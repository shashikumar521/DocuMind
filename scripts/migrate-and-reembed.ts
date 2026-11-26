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
import {
  ChunkMigrationStats,
  DatabaseIdentity,
  PostgresBlobStorage,
} from "../server/storage.js";
import {
  BackfillSummary,
  executeCloudflareBackfill,
  parseBackfillCliArgs,
  RunReembedCloudflareOptions,
  validatePostConnectionIdentity,
  validatePreConnectionSafety,
} from "./reembed-cloudflare.js";

export interface MigrateAndReembedResult {
  mode: "dry_run" | "execute";
  identity: DatabaseIdentity;
  pre_stats: ChunkMigrationStats;
  migrated_stats: ChunkMigrationStats;
  backfill: BackfillSummary | null;
  final_stats: ChunkMigrationStats;
  schema_ready: boolean;
  migration_complete: boolean;
}

export async function runMigrateAndReembed(
  options: RunReembedCloudflareOptions = {}
): Promise<MigrateAndReembedResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.logger ?? console.log;
  const args = parseBackfillCliArgs(argv);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to inspect, migrate, or backfill PostgreSQL.");
  }

  const { targetEnv } = validatePreConnectionSafety(args, databaseUrl, env);
  const model = getCloudflareEmbeddingModel();
  const expectedDims = getCloudflareExpectedEmbeddingDimensions();

  if (args.execute && !options.embedTexts && !isCloudflareConfigured()) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set before running migration and backfill with --execute."
    );
  }

  const storage = options.createStorage
    ? options.createStorage(databaseUrl)
    : new PostgresBlobStorage(databaseUrl);

  try {
    const identity = await storage.inspectDatabaseIdentity();
    validatePostConnectionIdentity(args, identity, targetEnv, env);

    if (typeof storage.inspectChunkMigrationStatsReadOnly !== "function") {
      throw new Error(
        "Aborted: storage adapter does not implement inspectChunkMigrationStatsReadOnly()."
      );
    }

    const preStats = await storage.inspectChunkMigrationStatsReadOnly();
    const preSchemaReady = preStats.has_embedding_cf_column && preStats.embedding_nullable;

    log("DocuMind Cloudflare Schema Migration & Backfill");
    log("-----------------------------------------------");
    log(`Database host           : ${identity.hostname}`);
    log(`Database name           : ${identity.serverDatabaseName}`);
    log(`PostgreSQL version      : ${identity.serverVersion}`);
    log(`Target environment      : ${targetEnv ?? "unspecified (dry-run only)"}`);
    log(`Mode                    : ${args.execute ? "EXECUTE MIGRATION + BACKFILL" : "DRY-RUN (read-only)"}`);
    log(`Target embedding model  : ${model} (${expectedDims}d)`);
    log(`pgvector enabled        : ${preStats.pgvector_enabled}`);
    log(`embedding_cf column     : ${preStats.has_embedding_cf_column}`);
    log(`embedding nullable      : ${preStats.embedding_nullable}`);
    log(`Schema ready            : ${preSchemaReady}`);
    log(`Total chunks            : ${preStats.total_chunks}`);
    log(`Chunks with CF vec      : ${preStats.cloudflare_chunks}`);
    log(`Chunks pending CF embed : ${preStats.missing_cloudflare_chunks}`);

    if (!args.execute) {
      log(
        "\nDry-run check complete (zero DDL/DML writes and zero Cloudflare API calls performed)."
      );
      return {
        mode: "dry_run",
        identity,
        pre_stats: preStats,
        migrated_stats: preStats,
        backfill: null,
        final_stats: preStats,
        schema_ready: preSchemaReady,
        migration_complete: preSchemaReady && preStats.missing_cloudflare_chunks === 0,
      };
    }

    if (typeof storage.applyCloudflareEmbeddingsMigration !== "function") {
      throw new Error(
        "Aborted: storage adapter does not implement applyCloudflareEmbeddingsMigration()."
      );
    }

    if (targetEnv === "production") {
      log(
        `\nWARNING: Applying schema migration and backfill writes on PRODUCTION ${identity.hostname} (${identity.serverDatabaseName}).`
      );
    }

    log("\nStep 1: Applying idempotent SQL migration (001_cloudflare_embeddings.sql)...");
    const migratedStats = await storage.applyCloudflareEmbeddingsMigration({
      expectedDimensions: expectedDims,
    });

    if (!migratedStats.has_embedding_cf_column || !migratedStats.embedding_nullable) {
      throw new Error(
        "Post-migration verification failed: `embedding_cf` column or nullable `embedding` is still missing."
      );
    }
    log(
      `Schema verified: embedding_cf=${migratedStats.has_embedding_cf_column}, embedding_nullable=${migratedStats.embedding_nullable}, pgvector=${migratedStats.pgvector_enabled}.`
    );

    log("\nStep 2: Running resilient Cloudflare embedding backfill...");
    const embedFn = options.embedTexts ?? generateCloudflareEmbeddings;
    const backfill = await executeCloudflareBackfill({
      storage,
      embedFn,
      initialStats: migratedStats,
      batchSize: args.batchSize,
      maxRetries: args.maxRetries,
      retryDelayMs: args.retryDelayMs,
      model,
      expectedDims,
      logger: log,
    });

    const finalStats = await storage.inspectChunkMigrationStatsReadOnly();
    const schemaReady = finalStats.has_embedding_cf_column && finalStats.embedding_nullable;
    const migrationComplete =
      schemaReady &&
      finalStats.missing_cloudflare_chunks === 0 &&
      backfill.failures.length === 0;

    log("\nStep 3: Final Migration Status");
    log("------------------------------");
    log(`Schema ready            : ${schemaReady}`);
    log(`Total chunks            : ${finalStats.total_chunks}`);
    log(`Completed embeddings    : ${finalStats.cloudflare_chunks}`);
    log(`Skipped chunks          : ${backfill.skipped_chunks}`);
    log(`Failures                : ${backfill.failures.length}`);
    log(`Remaining pending CF    : ${finalStats.missing_cloudflare_chunks}`);
    log(`Migration complete      : ${migrationComplete}`);

    if (backfill.failures.length > 0) {
      throw new Error(
        `Migration backfill completed with ${backfill.failures.length} chunk failure(s): ${backfill.failures
          .map((f) => `${f.chunk_id} (${f.error})`)
          .join("; ")}`
      );
    }

    return {
      mode: "execute",
      identity,
      pre_stats: preStats,
      migrated_stats: migratedStats,
      backfill,
      final_stats: finalStats,
      schema_ready: schemaReady,
      migration_complete: migrationComplete,
    };
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
  runMigrateAndReembed().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
