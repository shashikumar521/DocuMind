import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GEMINI_EMBEDDING_DIMENSIONS } from "../server/aiClient.js";
import {
  GEMINI_EMBEDDING_MODEL,
  generateEmbeddings as generateGeminiEmbeddings,
  isGeminiConfigured,
} from "../server/geminiClient.js";
import {
  ChunkMigrationStats,
  DatabaseIdentity,
  isKnownProductionTarget,
  parseDatabaseTargetInfo,
  PostgresBlobStorage,
} from "../server/storage.js";

export interface RollbackCliArgs {
  execute: boolean;
  allowPreview: boolean;
  confirmProduction: boolean;
  expectedHost?: string;
  expectedDb?: string;
  batchSize: number;
}

export interface ReembedGeminiStorage {
  inspectDatabaseIdentity(): Promise<DatabaseIdentity>;
  getChunkMigrationStats(): Promise<ChunkMigrationStats>;
  fetchChunksNeedingGeminiEmbedding(
    limit: number
  ): Promise<Array<{ chunk_id: string; text: string }>>;
  saveGeminiChunkEmbeddings(
    items: Array<{ chunk_id: string; embedding: number[]; embedding_model: string }>
  ): Promise<number>;
  close(): Promise<void>;
}

export interface RunReembedGeminiOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  createStorage?: (databaseUrl: string) => ReembedGeminiStorage;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  logger?: (line: string) => void;
}

export function parseRollbackCliArgs(argv: string[]): RollbackCliArgs {
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
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 15) {
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
  args: RollbackCliArgs,
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
  args: RollbackCliArgs,
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

export async function runReembedGemini(
  options: RunReembedGeminiOptions = {}
): Promise<ChunkMigrationStats> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.logger ?? console.log;
  const args = parseRollbackCliArgs(argv);

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

    log("DocuMind Gemini Rollback Re-embedding Status");
    log("--------------------------------------------");
    log(`Database host               : ${identity.hostname}`);
    log(`Database name               : ${identity.serverDatabaseName}`);
    log(`PostgreSQL version          : ${identity.serverVersion}`);
    log(`Target environment          : ${targetEnv ?? "unspecified (dry-run only)"}`);
    log(`Mode                        : ${args.execute ? "EXECUTE" : "DRY-RUN (read-only)"}`);
    log(`Target embedding model      : ${GEMINI_EMBEDDING_MODEL} (${GEMINI_EMBEDDING_DIMENSIONS}d)`);
    log(`Total chunks                : ${stats.total_chunks}`);
    log(`Chunks with Gemini vec      : ${stats.gemini_chunks}`);
    log(`Chunks with CF vec          : ${stats.cloudflare_chunks}`);
    log(`Chunks missing Gemini vec   : ${stats.missing_gemini_chunks}`);

    if (!args.execute) {
      log(
        "\nDry-run complete (no writes performed). To execute rollback writes, set TARGET_ENV=preview|production and pass --execute --expected-host=<host> --expected-db=<db> plus --allow-preview or --confirm-production."
      );
      return stats;
    }

    const embedFn = options.embedTexts ?? generateGeminiEmbeddings;
    if (!options.embedTexts && !isGeminiConfigured()) {
      throw new Error("GEMINI_API_KEY must be set before running reverse rollback with --execute.");
    }

    if (targetEnv === "production") {
      log(
        `\nWARNING: Executing PRODUCTION Gemini rollback writes on ${identity.hostname} (database: ${identity.serverDatabaseName}, PostgreSQL ${identity.serverVersion}). Existing Cloudflare vectors and chunk text will be preserved.`
      );
    }

    let totalUpdated = 0;
    let batchNumber = 0;

    while (true) {
      const pending = await storage.fetchChunksNeedingGeminiEmbedding(args.batchSize);
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
        if (!Array.isArray(vec) || vec.length !== GEMINI_EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Chunk ${chunk.chunk_id} received ${vec?.length ?? 0} dimensions instead of ${GEMINI_EMBEDDING_DIMENSIONS}.`
          );
        }
        return {
          chunk_id: chunk.chunk_id,
          embedding: vec,
          embedding_model: GEMINI_EMBEDDING_MODEL,
        };
      });

      const updated = await storage.saveGeminiChunkEmbeddings(payload);
      totalUpdated += updated;
      log(
        `Batch ${batchNumber}: restored Gemini embeddings for ${updated}/${pending.length} chunk(s) (total updated: ${totalUpdated}).`
      );
    }

    const finalStats = await storage.getChunkMigrationStats();
    log("\nRollback Backfill Complete");
    log("--------------------------");
    log(`Total chunks                : ${finalStats.total_chunks}`);
    log(`Chunks with Gemini vec      : ${finalStats.gemini_chunks}`);
    log(`Remaining missing Gemini    : ${finalStats.missing_gemini_chunks}`);
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
  runReembedGemini().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
