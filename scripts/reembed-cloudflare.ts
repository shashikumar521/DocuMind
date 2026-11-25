import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCloudflareEmbeddings,
  getCloudflareEmbeddingModel,
  getCloudflareExpectedEmbeddingDimensions,
  isCloudflareConfigured,
} from "../server/cloudflareClient.js";
import { extractPdfPagesAndChunks } from "../server/ragEngine.js";
import {
  ChunkMigrationStats,
  DatabaseIdentity,
  DocumentRecord,
  isKnownProductionTarget,
  parseDatabaseTargetInfo,
  PostgresBlobStorage,
  StoredChunk,
} from "../server/storage.js";

export interface BackfillCliArgs {
  execute: boolean;
  allowPreview: boolean;
  confirmProduction: boolean;
  expectedHost?: string;
  expectedDb?: string;
  batchSize: number;
}

export interface ReembedCloudflareStorage {
  inspectDatabaseIdentity(): Promise<DatabaseIdentity>;
  getChunkMigrationStats(): Promise<ChunkMigrationStats>;
  fetchChunksNeedingCloudflareEmbedding(
    limit: number
  ): Promise<Array<{ chunk_id: string; text: string }>>;
  saveCloudflareChunkEmbeddings(
    items: Array<{ chunk_id: string; embedding_cf: number[]; embedding_cf_model: string }>
  ): Promise<number>;
  fetchDocumentsWithMissingChunks?(limit: number): Promise<DocumentRecord[]>;
  getPdfBinary?(doc: DocumentRecord): Promise<{ buffer: Buffer; contentType: string } | null>;
  insertChunks?(
    chunks: StoredChunk[],
    options?: { provider?: "cloudflare"; embeddingModel?: string }
  ): Promise<void>;
  updateDocument?(
    documentId: string,
    patch: Partial<Pick<DocumentRecord, "status" | "progress" | "pages" | "chunks_count" | "error_message">>
  ): Promise<DocumentRecord | null>;
  markCompleteDocumentsIndexed?(): Promise<number>;
  close(): Promise<void>;
}

export interface RunReembedCloudflareOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  createStorage?: (databaseUrl: string) => ReembedCloudflareStorage;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  logger?: (line: string) => void;
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliArgs {
  let expectedHost: string | undefined;
  let expectedDb: string | undefined;
  let batchSize = 5;

  for (const arg of argv) {
    if (arg.startsWith("--expected-host=")) {
      expectedHost = arg.slice("--expected-host=".length).trim().toLowerCase() || undefined;
    } else if (arg.startsWith("--expected-db=")) {
      expectedDb = arg.slice("--expected-db=".length).trim() || undefined;
    } else if (arg.startsWith("--expected-database=")) {
      expectedDb = arg.slice("--expected-database=".length).trim() || undefined;
    } else if (arg.startsWith("--batch-size=")) {
      const parsed = Number(arg.slice("--batch-size=".length));
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 25) {
        batchSize = Math.floor(parsed);
      }
    }
  }

  return {
    execute: argv.includes("--execute"),
    allowPreview: argv.includes("--allow-preview"),
    confirmProduction: argv.includes("--confirm-production"),
    expectedHost,
    expectedDb,
    batchSize,
  };
}

function validatePreConnectionSafety(
  args: BackfillCliArgs,
  databaseUrl: string,
  env: NodeJS.ProcessEnv
): { targetEnv: "preview" | "production" | undefined } {
  if (args.allowPreview && args.confirmProduction) {
    throw new Error(
      "Conflicting authorization flags: --allow-preview and --confirm-production cannot be used together."
    );
  }

  const rawTargetEnv = env.TARGET_ENV?.trim().toLowerCase();
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  const urlTarget = parseDatabaseTargetInfo(databaseUrl);

  if (rawTargetEnv && rawTargetEnv !== "preview" && rawTargetEnv !== "production") {
    throw new Error(
      `Invalid TARGET_ENV='${env.TARGET_ENV}'. Expected 'preview' or 'production'.`
    );
  }

  const targetEnv =
    rawTargetEnv === "preview" || rawTargetEnv === "production" ? rawTargetEnv : undefined;

  if (args.expectedHost && urlTarget.hostname !== args.expectedHost) {
    throw new Error(
      `Database host mismatch: DATABASE_URL host '${urlTarget.hostname}' does not match --expected-host '${args.expectedHost}'.`
    );
  }

  if (args.expectedDb && urlTarget.databaseName && urlTarget.databaseName !== args.expectedDb) {
    throw new Error(
      `Database name mismatch: DATABASE_URL database '${urlTarget.databaseName}' does not match --expected-db '${args.expectedDb}'.`
    );
  }

  if (args.execute) {
    if (!targetEnv) {
      throw new Error(
        "Refusing --execute because TARGET_ENV is not set. Explicitly set TARGET_ENV=preview or TARGET_ENV=production (never inferred from VERCEL_ENV)."
      );
    }

    if (!args.expectedHost) {
      throw new Error(
        "Refusing --execute without --expected-host=<hostname>. Explicit host verification is mandatory before any write."
      );
    }

    if (!args.expectedDb) {
      throw new Error(
        "Refusing --execute without --expected-db=<dbname>. Explicit database name verification is mandatory before any write."
      );
    }

    if (targetEnv === "preview") {
      if (!args.allowPreview) {
        throw new Error(
          "Preview write refused: TARGET_ENV=preview requires --allow-preview."
        );
      }
      if (vercelEnv === "production") {
        throw new Error(
          "Preview write refused: cannot run TARGET_ENV=preview while VERCEL_ENV=production."
        );
      }
      const prodCheck = isKnownProductionTarget(urlTarget, env);
      if (prodCheck.isProduction) {
        throw new Error(
          `Preview write aborted: target database (${urlTarget.hostname}${urlTarget.databaseName ? `/${urlTarget.databaseName}` : ""}) is identified as Production (${prodCheck.reason}).`
        );
      }
      const previewExpectedHost = env.PREVIEW_EXPECTED_DATABASE_HOST?.trim().toLowerCase();
      if (previewExpectedHost && urlTarget.hostname !== previewExpectedHost) {
        throw new Error(
          `Preview write aborted: target host '${urlTarget.hostname}' does not match PREVIEW_EXPECTED_DATABASE_HOST '${previewExpectedHost}'.`
        );
      }
    } else if (targetEnv === "production") {
      if (!args.confirmProduction) {
        throw new Error(
          "Production write refused: TARGET_ENV=production requires --confirm-production."
        );
      }
      if (vercelEnv === "preview") {
        throw new Error(
          "Production write refused: cannot run TARGET_ENV=production while VERCEL_ENV=preview."
        );
      }
      const prodHost = env.PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
      if (prodHost && urlTarget.hostname !== prodHost) {
        throw new Error(
          `Production write aborted: host '${urlTarget.hostname}' does not match PRODUCTION_DATABASE_HOST '${prodHost}'.`
        );
      }
      const prodDb = env.PRODUCTION_DATABASE_NAME?.trim();
      if (prodDb && args.expectedDb !== prodDb) {
        throw new Error(
          `Production write aborted: --expected-db '${args.expectedDb}' does not match PRODUCTION_DATABASE_NAME '${prodDb}'.`
        );
      }
    }
  } else {
    if (vercelEnv === "preview" && !args.allowPreview) {
      throw new Error(
        "Refusing database inspection in VERCEL_ENV=preview without --allow-preview."
      );
    }
    if (targetEnv === "preview" || vercelEnv === "preview") {
      const prodCheck = isKnownProductionTarget(urlTarget, env);
      if (prodCheck.isProduction) {
        throw new Error(
          `Preview inspection aborted: target database (${urlTarget.hostname}${urlTarget.databaseName ? `/${urlTarget.databaseName}` : ""}) is identified as Production (${prodCheck.reason}).`
        );
      }
    }
  }

  return { targetEnv };
}

function validatePostConnectionIdentity(
  args: BackfillCliArgs,
  identity: DatabaseIdentity,
  targetEnv: "preview" | "production" | undefined,
  env: NodeJS.ProcessEnv
): void {
  if (args.expectedHost && identity.hostname !== args.expectedHost) {
    throw new Error(
      `Database host verification failed: connected host '${identity.hostname}' does not match --expected-host '${args.expectedHost}'.`
    );
  }

  if (args.expectedDb && identity.serverDatabaseName !== args.expectedDb) {
    throw new Error(
      `Database name verification failed: PostgreSQL current_database() is '${identity.serverDatabaseName}', expected '${args.expectedDb}'.`
    );
  }

  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  if (targetEnv === "preview" || vercelEnv === "preview") {
    const prodCheck = isKnownProductionTarget(
      { hostname: identity.hostname, databaseName: identity.serverDatabaseName },
      env
    );
    if (prodCheck.isProduction) {
      throw new Error(
        `Preview execution aborted after identity query: '${identity.hostname}/${identity.serverDatabaseName}' is identified as Production (${prodCheck.reason}).`
      );
    }
    const previewExpectedDb = env.PREVIEW_EXPECTED_DATABASE_NAME?.trim();
    if (previewExpectedDb && identity.serverDatabaseName !== previewExpectedDb) {
      throw new Error(
        `Preview execution aborted: current_database() '${identity.serverDatabaseName}' does not match PREVIEW_EXPECTED_DATABASE_NAME '${previewExpectedDb}'.`
      );
    }
  }

  if (targetEnv === "production") {
    const prodDb = env.PRODUCTION_DATABASE_NAME?.trim();
    if (prodDb && identity.serverDatabaseName !== prodDb) {
      throw new Error(
        `Production execution aborted: current_database() '${identity.serverDatabaseName}' does not match PRODUCTION_DATABASE_NAME '${prodDb}'.`
      );
    }
  }
}

export async function runReembedCloudflare(
  options: RunReembedCloudflareOptions = {}
): Promise<ChunkMigrationStats> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.logger ?? console.log;
  const args = parseBackfillCliArgs(argv);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to inspect or backfill PostgreSQL chunks.");
  }

  const { targetEnv } = validatePreConnectionSafety(args, databaseUrl, env);

  const storage = options.createStorage
    ? options.createStorage(databaseUrl)
    : new PostgresBlobStorage(databaseUrl);

  try {
    const identity = await storage.inspectDatabaseIdentity();
    validatePostConnectionIdentity(args, identity, targetEnv, env);

    const stats = await storage.getChunkMigrationStats();
    const model = getCloudflareEmbeddingModel();
    const expectedDims = getCloudflareExpectedEmbeddingDimensions();

    log("DocuMind Cloudflare Re-indexing & Embedding Status");
    log("------------------------------------------------");
    log(`Database host           : ${identity.hostname}`);
    log(`Database name           : ${identity.serverDatabaseName}`);
    log(`PostgreSQL version      : ${identity.serverVersion}`);
    log(`Target environment      : ${targetEnv ?? "unspecified (dry-run only)"}`);
    log(`Mode                    : ${args.execute ? "EXECUTE" : "DRY-RUN (read-only)"}`);
    log(`Target embedding model  : ${model} (${expectedDims}d)`);
    log(`pgvector enabled        : ${stats.pgvector_enabled}`);
    log(`embedding_cf column     : ${stats.has_embedding_cf_column}`);
    log(`embedding nullable      : ${stats.embedding_nullable}`);
    log(`Total chunks            : ${stats.total_chunks}`);
    log(`Legacy vector chunks    : ${stats.legacy_chunks}`);
    log(`Chunks with CF vec      : ${stats.cloudflare_chunks}`);
    log(`Chunks pending CF embed : ${stats.missing_cloudflare_chunks}`);

    if (!stats.has_embedding_cf_column || !stats.embedding_nullable) {
      throw new Error(
        "Database schema is not ready. Apply migrations/001_cloudflare_embeddings.sql first."
      );
    }

    if (!args.execute) {
      log(
        "\nDry-run complete (no writes performed). To execute writes, set TARGET_ENV=preview|production and pass --execute --expected-host=<host> --expected-db=<db> plus --allow-preview or --confirm-production."
      );
      return stats;
    }

    const embedFn = options.embedTexts ?? generateCloudflareEmbeddings;
    if (!options.embedTexts && !isCloudflareConfigured()) {
      throw new Error(
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set before running with --execute."
      );
    }

    if (targetEnv === "production") {
      log(
        `\nWARNING: Executing PRODUCTION backfill writes on ${identity.hostname} (database: ${identity.serverDatabaseName}, PostgreSQL ${identity.serverVersion}). Existing documents, PDFs, and chunk text will be preserved.`
      );
    }

    let totalUpdated = 0;
    let batchNumber = 0;

    // 1. Backfill existing chunks missing 1,024-d Cloudflare vectors
    while (true) {
      const pending = await storage.fetchChunksNeedingCloudflareEmbedding(args.batchSize);
      if (pending.length === 0) {
        break;
      }

      batchNumber += 1;
      const vectors = await embedFn(pending.map((c) => c.text));
      if (vectors.length !== pending.length) {
        throw new Error(
          `Batch ${batchNumber} vector count mismatch: expected ${pending.length}, got ${vectors.length}.`
        );
      }

      const payload = pending.map((chunk, idx) => {
        const vec = vectors[idx];
        if (!Array.isArray(vec) || vec.length !== expectedDims) {
          throw new Error(
            `Chunk ${chunk.chunk_id} received ${vec?.length ?? 0} dimensions instead of ${expectedDims}.`
          );
        }
        return {
          chunk_id: chunk.chunk_id,
          embedding_cf: vec,
          embedding_cf_model: model,
        };
      });

      const updated = await storage.saveCloudflareChunkEmbeddings(payload);
      totalUpdated += updated;
      log(
        `Batch ${batchNumber}: updated ${updated}/${pending.length} chunk(s) (total updated: ${totalUpdated}).`
      );
    }

    // 2. Re-index any documents with zero stored chunks using their stored PDF files
    if (
      storage.fetchDocumentsWithMissingChunks &&
      storage.getPdfBinary &&
      storage.insertChunks &&
      storage.updateDocument
    ) {
      const processedDocIds = new Set<string>();
      while (true) {
        const docsMissingChunks = await storage.fetchDocumentsWithMissingChunks(args.batchSize);
        const nextDocs = docsMissingChunks.filter((d) => !processedDocIds.has(d.id));
        if (nextDocs.length === 0) break;

        for (const doc of nextDocs) {
          processedDocIds.add(doc.id);
          const binary = await storage.getPdfBinary(doc);
          if (!binary) {
            log(`Skipping document ${doc.id} (${doc.filename}): no stored PDF binary available.`);
            continue;
          }

          const { totalPages, chunks: rawChunks } = await extractPdfPagesAndChunks(
            binary.buffer,
            doc.id,
            doc.filename
          );

          const storedChunks: StoredChunk[] = [];
          for (let offset = 0; offset < rawChunks.length; offset += args.batchSize) {
            const slice = rawChunks.slice(offset, offset + args.batchSize);
            const vecs = await embedFn(slice.map((c) => c.text));
            if (vecs.length !== slice.length) {
              throw new Error(
                `Document ${doc.id} vector count mismatch: expected ${slice.length}, got ${vecs.length}.`
              );
            }
            for (let i = 0; i < slice.length; i++) {
              const vec = vecs[i];
              if (!Array.isArray(vec) || vec.length !== expectedDims) {
                throw new Error(
                  `Chunk ${slice[i].chunk_id} received ${vec?.length ?? 0} dimensions instead of ${expectedDims}.`
                );
              }
              storedChunks.push({
                ...slice[i],
                embedding: null,
                embedding_model: null,
                embedding_cf: vec,
                embedding_cf_model: model,
              });
            }
          }

          await storage.insertChunks(storedChunks, {
            provider: "cloudflare",
            embeddingModel: model,
          });
          // Never mark document indexed until all Cloudflare embeddings are stored.
          await storage.updateDocument(doc.id, {
            status: "Indexed Successfully",
            progress: 100,
            pages: totalPages,
            chunks_count: storedChunks.length,
            error_message: null,
          });
          totalUpdated += storedChunks.length;
          log(
            `Re-indexed document ${doc.id} (${doc.filename}) from stored PDF: ${storedChunks.length} chunks (${expectedDims}d).`
          );
        }
      }
    }

    // 3. Ensure document status is marked indexed only once every chunk has valid Cloudflare vectors
    if (storage.markCompleteDocumentsIndexed) {
      const finalizedDocs = await storage.markCompleteDocumentsIndexed();
      if (finalizedDocs > 0) {
        log(`Marked ${finalizedDocs} document(s) 'Indexed Successfully' after verifying complete Cloudflare vectors.`);
      }
    }

    const finalStats = await storage.getChunkMigrationStats();
    log("\nBackfill Complete");
    log("-----------------");
    log(`Total chunks            : ${finalStats.total_chunks}`);
    log(`Legacy vector chunks    : ${finalStats.legacy_chunks}`);
    log(`Chunks with CF vec      : ${finalStats.cloudflare_chunks}`);
    log(`Remaining pending CF    : ${finalStats.missing_cloudflare_chunks}`);
    return finalStats;
  } finally {
    await storage.close();
  }
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  runReembedCloudflare().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
