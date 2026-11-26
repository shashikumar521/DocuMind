import { del, get, put } from "@vercel/blob";
import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import type { AiProvider } from "./aiClient.js";
import type { RetrievedChunkRef } from "./ragPrompt.js";

export type ProcessingStatus =
  | "Uploaded"
  | "Extracting Text"
  | "Chunking"
  | "Generating Embeddings"
  | "Indexing Vectors"
  | "Indexed Successfully"
  | "Failed";

export interface DocumentRecord {
  id: string;
  filename: string;
  size_bytes: number;
  pages: number;
  chunks_count: number;
  status: ProcessingStatus;
  progress: number;
  error_message: string | null;
  sha256: string;
  blob_url?: string | null;
  blob_pathname?: string | null;
  uploaded_at: string;
}

export interface StoredChunk {
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  token_count: number;
  embedding?: number[] | null;
  embedding_model?: string | null;
  embedding_cf?: number[] | null;
  embedding_cf_model?: string | null;
}

export interface ChunkMigrationStats {
  total_chunks: number;
  legacy_chunks: number;
  cloudflare_chunks: number;
  missing_cloudflare_chunks: number;
  has_embedding_cf_column: boolean;
  has_embedding_model_column: boolean;
  has_embedding_cf_model_column: boolean;
  embedding_nullable: boolean;
  pgvector_enabled: boolean;
}

export interface ConversationRecord {
  id: string;
  question: string;
  answer: string;
  sources: RetrievedChunkRef[];
  created_at: string;
}

export interface StorageInfo {
  storage_mode: "production-durable" | "local-dev";
  vector_store: "postgres-pgvector" | "postgres-array" | "local-dev-json";
  object_storage: "vercel-blob" | "local-dev-fs";
  storage_label: string;
}

export class StorageConfigError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "StorageConfigError";
    this.statusCode = statusCode;
  }
}

export interface UploadedBinaryRef {
  blobUrl: string | null;
  blobPathname: string | null;
}

export interface StorageAdapter {
  init(): Promise<void>;
  getInfo(): StorageInfo;
  listDocuments(): Promise<DocumentRecord[]>;
  getDocument(documentId: string): Promise<DocumentRecord | null>;
  findIndexedBySha256(sha256: string): Promise<DocumentRecord | null>;
  insertDocument(doc: DocumentRecord): Promise<void>;
  updateDocument(
    documentId: string,
    patch: Partial<Pick<DocumentRecord, "status" | "progress" | "pages" | "chunks_count" | "error_message" | "blob_url" | "blob_pathname">>
  ): Promise<DocumentRecord | null>;
  insertChunks(
    chunks: StoredChunk[],
    options?: { provider?: AiProvider; embeddingModel?: string }
  ): Promise<void>;
  deleteDocument(documentId: string): Promise<{ deleted: boolean; blobUrl?: string | null; filename?: string }>;
  searchSimilarChunks(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[],
    options?: { provider?: AiProvider; embeddingModel?: string }
  ): Promise<RetrievedChunkRef[]>;
  getDocumentChunks(documentId: string, limit?: number): Promise<RetrievedChunkRef[]>;
  getTotalChunksCount(): Promise<number>;
  getEmbeddingDimensions(): Promise<number | null>;
  getChunkMigrationStats?(): Promise<ChunkMigrationStats>;
  recordConversation(record: ConversationRecord): Promise<void>;
  getHistory(): Promise<ConversationRecord[]>;
  clearHistory(): Promise<void>;
  getQuestionsAnswered(): Promise<number>;
  savePdfBinary(documentId: string, filename: string, buffer: Buffer): Promise<UploadedBinaryRef>;
  getPdfBinary(doc: DocumentRecord): Promise<{ buffer: Buffer; contentType: string } | null>;
  deletePdfBinary(documentId: string, filename: string, blobUrl?: string | null): Promise<void>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function toVectorLiteral(vec: number[]): string {
  for (const v of vec) {
    if (!Number.isFinite(v)) {
      throw new Error("Invalid non-finite number in embedding vector.");
    }
  }
  return `[${vec.join(",")}]`;
}

function parseVectorColumn(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!trimmed) return [];
    return trimmed.split(",").map((s) => Number(s));
  }
  return [];
}

interface BlobRequestContextValue {
  oidcToken?: string;
}

const blobRequestContext = new AsyncLocalStorage<BlobRequestContextValue>();
const VERCEL_REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

export function runWithBlobOidcContext<T>(oidcToken: string | undefined, fn: () => T): T {
  const cleaned = oidcToken?.trim() || undefined;
  return blobRequestContext.run({ oidcToken: cleaned }, fn);
}

function getVercelRequestContextOidcToken(): string | undefined {
  const asyncStoreToken = blobRequestContext.getStore()?.oidcToken?.trim();
  if (asyncStoreToken) return asyncStoreToken;

  const ctxGlobal = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, string | string[] | undefined> } } | undefined>)[
    VERCEL_REQUEST_CONTEXT_SYMBOL
  ];
  const headerVal = ctxGlobal?.get?.()?.headers?.["x-vercel-oidc-token"];
  if (typeof headerVal === "string" && headerVal.trim()) {
    return headerVal.trim();
  }
  if (Array.isArray(headerVal) && typeof headerVal[0] === "string" && headerVal[0].trim()) {
    return headerVal[0].trim();
  }

  const envToken = process.env.VERCEL_OIDC_TOKEN?.trim();
  return envToken || undefined;
}

function getBlobStoreId(): string | undefined {
  return process.env.BLOB_STORE_ID?.trim() || undefined;
}

function getBlobAccessMode(): "private" | "public" {
  return process.env.BLOB_ACCESS === "public" ? "public" : "private";
}

function getBlobAuthOptions(): { token?: string; oidcToken?: string; storeId?: string } {
  const storeId = getBlobStoreId();
  const oidcToken = getVercelRequestContextOidcToken();
  const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();

  if (oidcToken && storeId) {
    return { oidcToken, storeId };
  }
  if (readWriteToken) {
    return { token: readWriteToken };
  }
  if (storeId) {
    return { storeId };
  }
  return {};
}

function isVercelEnvironment(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

export interface DatabaseTargetInfo {
  hostname: string;
  databaseName: string;
}

export interface DatabaseIdentity {
  hostname: string;
  urlDatabaseName: string;
  serverDatabaseName: string;
  serverVersion: string;
}

export function parseDatabaseTargetInfo(databaseUrl: string): DatabaseTargetInfo {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    throw new StorageConfigError(
      "Configured DATABASE_URL is not a valid PostgreSQL connection URL.",
      500
    );
  }
  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new StorageConfigError("Configured DATABASE_URL is missing a database hostname.", 500);
  }
  const rawPath = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
  const databaseName = rawPath ? decodeURIComponent(rawPath).trim() : "";
  return { hostname, databaseName };
}

export function isKnownProductionTarget(
  target: { hostname: string; databaseName?: string },
  env: NodeJS.ProcessEnv = process.env
): { isProduction: boolean; reason?: string } {
  const host = target.hostname.trim().toLowerCase();
  const dbName = (target.databaseName ?? "").trim();
  const dbLower = dbName.toLowerCase();

  const prodUrl = env.PRODUCTION_DATABASE_URL?.trim();
  if (prodUrl) {
    try {
      const prodParsed = parseDatabaseTargetInfo(prodUrl);
      if (host === prodParsed.hostname) {
        return { isProduction: true, reason: "matches PRODUCTION_DATABASE_URL host" };
      }
    } catch {
      // Ignore malformed optional reference URL
    }
  }

  const configuredProdHosts = [
    env.PRODUCTION_DATABASE_HOST?.trim(),
    ...(env.PRODUCTION_DATABASE_HOSTS?.split(",") ?? []).map((h) => h.trim()),
  ]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.toLowerCase());

  if (configuredProdHosts.includes(host)) {
    return { isProduction: true, reason: "matches PRODUCTION_DATABASE_HOST" };
  }

  const configuredProdDb = env.PRODUCTION_DATABASE_NAME?.trim();
  if (configuredProdDb && configuredProdHosts.length === 0 && dbName === configuredProdDb) {
    return { isProduction: true, reason: "matches PRODUCTION_DATABASE_NAME" };
  }

  if (
    host.startsWith("prod.") ||
    host.startsWith("prod-") ||
    host.startsWith("production.") ||
    host.startsWith("production-") ||
    host.includes(".prod.") ||
    host.includes(".production.") ||
    host.includes("-prod.") ||
    host.includes("-production.")
  ) {
    return { isProduction: true, reason: "hostname contains production identifier" };
  }

  if (
    dbLower === "prod" ||
    dbLower === "production" ||
    dbLower.startsWith("prod_") ||
    dbLower.startsWith("prod-") ||
    dbLower.startsWith("production_") ||
    dbLower.startsWith("production-") ||
    dbLower.endsWith("_prod") ||
    dbLower.endsWith("-prod") ||
    dbLower.endsWith("_production") ||
    dbLower.endsWith("-production")
  ) {
    return { isProduction: true, reason: "database name contains production identifier" };
  }

  return { isProduction: false };
}

export function assertPreviewDatabaseIsolation(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.VERCEL_ENV?.trim().toLowerCase() !== "preview") {
    return;
  }

  if (env.TARGET_ENV?.trim().toLowerCase() === "production") {
    throw new StorageConfigError(
      "Preview deployment refused to run with TARGET_ENV=production.",
      503
    );
  }

  const target = parseDatabaseTargetInfo(databaseUrl);
  const prodCheck = isKnownProductionTarget(target, env);
  if (prodCheck.isProduction) {
    throw new StorageConfigError(
      `Preview deployment refused to connect to a Production PostgreSQL target (${target.hostname}${target.databaseName ? `/${target.databaseName}` : ""}: ${prodCheck.reason}). Configure an isolated Preview DATABASE_URL.`,
      503
    );
  }

  const expectedPreviewHost = env.PREVIEW_EXPECTED_DATABASE_HOST?.trim().toLowerCase();
  if (expectedPreviewHost && target.hostname !== expectedPreviewHost) {
    throw new StorageConfigError(
      `Preview deployment refused: active DATABASE_URL host (${target.hostname}) does not match PREVIEW_EXPECTED_DATABASE_HOST (${expectedPreviewHost}).`,
      503
    );
  }

  const expectedPreviewDb = env.PREVIEW_EXPECTED_DATABASE_NAME?.trim();
  if (expectedPreviewDb && target.databaseName && target.databaseName !== expectedPreviewDb) {
    throw new StorageConfigError(
      `Preview deployment refused: active DATABASE_URL database (${target.databaseName}) does not match PREVIEW_EXPECTED_DATABASE_NAME (${expectedPreviewDb}).`,
      503
    );
  }
}

function hasBlobCredentials(): boolean {
  return Boolean(
    getBlobStoreId() ||
      process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
      (getVercelRequestContextOidcToken() && getBlobStoreId())
  );
}

interface ChunkSchemaCapabilities {
  hasEmbeddingModelColumn: boolean;
  hasEmbeddingCfColumn: boolean;
  hasEmbeddingCfModelColumn: boolean;
  embeddingNullable: boolean;
}

export function sanitizeDatabaseErrorMessage(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"`]+@/gi, "postgresql://***@");
}

/**
 * Durable production storage backed by PostgreSQL (with pgvector when available)
 * and Vercel Blob for PDF object storage.
 */
export class PostgresBlobStorage implements StorageAdapter {
  private pool: Pool;
  private readonly databaseUrl: string;
  private initPromise: Promise<void> | null = null;
  private pgVectorEnabled = false;
  private schemaCaps: ChunkSchemaCapabilities = {
    hasEmbeddingModelColumn: false,
    hasEmbeddingCfColumn: false,
    hasEmbeddingCfModelColumn: false,
    embeddingNullable: false,
  };
  private cachedEmbeddingDims: number | null = null;

  constructor(databaseUrl: string, poolOverride?: Pool) {
    this.databaseUrl = databaseUrl;
    if (poolOverride) {
      this.pool = poolOverride;
      this.attachPoolErrorListener();
      return;
    }
    const serverless = isVercelEnvironment();
    const needsSsl =
      databaseUrl.includes("sslmode=") ||
      databaseUrl.includes("neon.tech") ||
      databaseUrl.includes("supabase") ||
      databaseUrl.includes("vercel-storage") ||
      serverless;

    let normalizedUrl = databaseUrl;
    let hasExplicitSslParam = false;
    try {
      const parsed = new URL(databaseUrl);
      const sslmode = parsed.searchParams.get("sslmode")?.toLowerCase();
      const uselibpqcompat = parsed.searchParams.get("uselibpqcompat")?.toLowerCase();
      if (sslmode) {
        hasExplicitSslParam = true;
        if (
          uselibpqcompat !== "true" &&
          (sslmode === "prefer" || sslmode === "require" || sslmode === "verify-ca")
        ) {
          parsed.searchParams.set("sslmode", "verify-full");
          normalizedUrl = parsed.toString();
        }
      } else if (needsSsl) {
        parsed.searchParams.set("sslmode", "verify-full");
        normalizedUrl = parsed.toString();
        hasExplicitSslParam = true;
      }
    } catch {
      // Non-URL connection string; keep original string and enforce strict TLS if needsSsl
    }

    this.pool = new Pool({
      connectionString: normalizedUrl,
      max: serverless ? 3 : 5,
      idleTimeoutMillis: serverless ? 10_000 : 20_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
      allowExitOnIdle: serverless,
      ssl: needsSsl && !hasExplicitSslParam ? { rejectUnauthorized: true } : undefined,
    });
    this.attachPoolErrorListener();
  }

  private attachPoolErrorListener(): void {
    const maybeEmitter = this.pool as unknown as {
      on?: (event: string, listener: (err: unknown) => void) => void;
    };
    if (typeof maybeEmitter.on === "function") {
      maybeEmitter.on("error", (err: unknown) => {
        const rawMsg = err instanceof Error ? err.message : String(err ?? "unknown pool error");
        console.error("[storage] PostgreSQL pool idle client error:", sanitizeDatabaseErrorMessage(rawMsg));
      });
    }
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bootstrapSchema().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  private async bootstrapSchema(): Promise<void> {
    assertPreviewDatabaseIsolation(this.databaseUrl);

    if (isVercelEnvironment() && !hasBlobCredentials()) {
      throw new StorageConfigError(
        "Vercel Blob is not configured. Connect a Vercel Blob store with OIDC (BLOB_STORE_ID) or set BLOB_READ_WRITE_TOKEN in Project Settings > Storage."
      );
    }

    const client = await this.pool.connect();
    try {
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
        this.pgVectorEnabled = true;
      } catch {
        this.pgVectorEnabled = false;
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS documind_documents (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          pages INTEGER NOT NULL DEFAULT 0,
          chunks_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          sha256 TEXT NOT NULL,
          blob_url TEXT,
          blob_pathname TEXT,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_documind_documents_sha256 ON documind_documents (sha256);"
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_documind_documents_uploaded_at ON documind_documents (uploaded_at DESC);"
      );

      if (this.pgVectorEnabled) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS documind_chunks (
            chunk_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documind_documents(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            embedding vector,
            embedding_model TEXT,
            embedding_cf vector(1024),
            embedding_cf_model TEXT
          );
        `);
      } else {
        await client.query(`
          CREATE TABLE IF NOT EXISTS documind_chunks (
            chunk_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documind_documents(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            embedding DOUBLE PRECISION[],
            embedding_model TEXT,
            embedding_cf DOUBLE PRECISION[],
            embedding_cf_model TEXT
          );
        `);
      }

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_documind_chunks_document_id ON documind_chunks (document_id);"
      );

      // Read-only schema capability inspection (never runs ALTER TABLE / UPDATE / CREATE INDEX on existing tables)
      const colRes = await client.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'documind_chunks'`
      );
      const colMap = new Map(
        colRes.rows.map((r) => [String(r.column_name), String(r.is_nullable).toUpperCase() === "YES"])
      );
      this.schemaCaps = {
        hasEmbeddingModelColumn: colMap.has("embedding_model"),
        hasEmbeddingCfColumn: colMap.has("embedding_cf"),
        hasEmbeddingCfModelColumn: colMap.has("embedding_cf_model"),
        embeddingNullable: colMap.get("embedding") ?? false,
      };

      await client.query(`
        CREATE TABLE IF NOT EXISTS documind_conversations (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS documind_meta (
          key TEXT PRIMARY KEY,
          value_int BIGINT NOT NULL DEFAULT 0
        );
      `);

      await client.query(`
        INSERT INTO documind_meta (key, value_int)
        VALUES ('questions_answered', 0)
        ON CONFLICT (key) DO NOTHING;
      `);
    } finally {
      client.release();
    }
  }

  private async refreshSchemaCapabilities(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const extRes = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1"
      );
      this.pgVectorEnabled = (extRes.rowCount ?? extRes.rows.length) > 0;

      const colRes = await client.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'documind_chunks'`
      );
      const colMap = new Map(
        colRes.rows.map((r) => [String(r.column_name), String(r.is_nullable).toUpperCase() === "YES"])
      );
      this.schemaCaps = {
        hasEmbeddingModelColumn: colMap.has("embedding_model"),
        hasEmbeddingCfColumn: colMap.has("embedding_cf"),
        hasEmbeddingCfModelColumn: colMap.has("embedding_cf_model"),
        embeddingNullable: colMap.get("embedding") ?? false,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Explicitly applies migrations/001_cloudflare_embeddings.sql (Section B) in a single
   * atomic transaction. Never called automatically at runtime startup or during dry-run.
   */
  async applyCloudflareEmbeddingsMigration(
    options: { expectedDimensions?: number } = {}
  ): Promise<ChunkMigrationStats> {
    assertPreviewDatabaseIsolation(this.databaseUrl);

    const dims =
      typeof options.expectedDimensions === "number" &&
      Number.isInteger(options.expectedDimensions) &&
      options.expectedDimensions > 0
        ? options.expectedDimensions
        : 1024;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

      const tableRes = await client.query(
        `SELECT 1
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'documind_chunks'
         LIMIT 1`
      );
      const tableExists = (tableRes.rowCount ?? tableRes.rows.length) > 0;

      if (!tableExists) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS documind_documents (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            pages INTEGER NOT NULL DEFAULT 0,
            chunks_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            sha256 TEXT NOT NULL,
            blob_url TEXT,
            blob_pathname TEXT,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS documind_chunks (
            chunk_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documind_documents(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            embedding vector,
            embedding_model TEXT,
            embedding_cf vector(${dims}),
            embedding_cf_model TEXT
          );
        `);

        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_documind_chunks_document_id ON documind_chunks (document_id);"
        );
      }

      await client.query(
        "ALTER TABLE documind_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;"
      );
      await client.query(
        "ALTER TABLE documind_chunks ALTER COLUMN embedding DROP NOT NULL;"
      );
      await client.query(
        `ALTER TABLE documind_chunks ADD COLUMN IF NOT EXISTS embedding_cf vector(${dims});`
      );
      await client.query(
        "ALTER TABLE documind_chunks ADD COLUMN IF NOT EXISTS embedding_cf_model TEXT;"
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    this.initPromise = null;
    this.cachedEmbeddingDims = null;

    const verifiedStats = await this.inspectChunkMigrationStatsReadOnly();
    this.pgVectorEnabled = verifiedStats.pgvector_enabled;
    this.schemaCaps = {
      hasEmbeddingModelColumn: verifiedStats.has_embedding_model_column,
      hasEmbeddingCfColumn: verifiedStats.has_embedding_cf_column,
      hasEmbeddingCfModelColumn: verifiedStats.has_embedding_cf_model_column,
      embeddingNullable: verifiedStats.embedding_nullable,
    };

    if (!verifiedStats.has_embedding_cf_column || !verifiedStats.embedding_nullable) {
      throw new StorageConfigError(
        "Explicit migration completed without required schema capabilities (`embedding_cf` column or nullable `embedding`)."
      );
    }

    return verifiedStats;
  }

  async ensureCloudflareVectorIndex(): Promise<void> {
    assertPreviewDatabaseIsolation(this.databaseUrl);
    const stats = await this.inspectChunkMigrationStatsReadOnly();
    if (!stats.pgvector_enabled || !stats.has_embedding_cf_column) {
      return;
    }
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_documind_chunks_embedding_cf_hnsw
       ON documind_chunks USING hnsw (embedding_cf vector_cosine_ops)
       WHERE embedding_cf IS NOT NULL;`
    );
  }

  getInfo(): StorageInfo {
    const usesBlob = hasBlobCredentials();
    const usesOidc = Boolean(getBlobStoreId() && !process.env.BLOB_READ_WRITE_TOKEN?.trim());
    const blobLabel = usesOidc
      ? `Vercel Blob (OIDC, ${getBlobAccessMode()})`
      : "Vercel Blob";
    return {
      storage_mode: "production-durable",
      vector_store: this.pgVectorEnabled ? "postgres-pgvector" : "postgres-array",
      object_storage: usesBlob ? "vercel-blob" : "local-dev-fs",
      storage_label: this.pgVectorEnabled
        ? `PostgreSQL (pgvector) + ${blobLabel}`
        : `PostgreSQL + ${blobLabel}`,
    };
  }

  private mapDocRow(row: Record<string, unknown>): DocumentRecord {
    return {
      id: String(row.id),
      filename: String(row.filename),
      size_bytes: Number(row.size_bytes ?? 0),
      pages: Number(row.pages ?? 0),
      chunks_count: Number(row.chunks_count ?? 0),
      status: row.status as ProcessingStatus,
      progress: Number(row.progress ?? 0),
      error_message: row.error_message ? String(row.error_message) : null,
      sha256: String(row.sha256),
      blob_url: row.blob_url ? String(row.blob_url) : null,
      blob_pathname: row.blob_pathname ? String(row.blob_pathname) : null,
      uploaded_at:
        row.uploaded_at instanceof Date
          ? row.uploaded_at.toISOString()
          : String(row.uploaded_at),
    };
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    await this.init();
    const res = await this.pool.query(
      "SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents ORDER BY uploaded_at DESC"
    );
    return res.rows.map((r) => this.mapDocRow(r));
  }

  async getDocument(documentId: string): Promise<DocumentRecord | null> {
    await this.init();
    const res = await this.pool.query(
      "SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents WHERE id = $1 LIMIT 1",
      [documentId]
    );
    return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
  }

  async findIndexedBySha256(sha256: string): Promise<DocumentRecord | null> {
    await this.init();
    const res = await this.pool.query(
      "SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents WHERE sha256 = $1 AND status = 'Indexed Successfully' LIMIT 1",
      [sha256]
    );
    return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
  }

  async insertDocument(doc: DocumentRecord): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO documind_documents (
        id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        doc.id,
        doc.filename,
        doc.size_bytes,
        doc.pages,
        doc.chunks_count,
        doc.status,
        doc.progress,
        doc.error_message,
        doc.sha256,
        doc.blob_url ?? null,
        doc.blob_pathname ?? null,
        doc.uploaded_at,
      ]
    );
  }

  async updateDocument(
    documentId: string,
    patch: Partial<Pick<DocumentRecord, "status" | "progress" | "pages" | "chunks_count" | "error_message" | "blob_url" | "blob_pathname">>
  ): Promise<DocumentRecord | null> {
    await this.init();
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (patch.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(patch.status);
    }
    if (patch.progress !== undefined) {
      fields.push(`progress = $${idx++}`);
      values.push(patch.progress);
    }
    if (patch.pages !== undefined) {
      fields.push(`pages = $${idx++}`);
      values.push(patch.pages);
    }
    if (patch.chunks_count !== undefined) {
      fields.push(`chunks_count = $${idx++}`);
      values.push(patch.chunks_count);
    }
    if (patch.error_message !== undefined) {
      fields.push(`error_message = $${idx++}`);
      values.push(patch.error_message);
    }
    if (patch.blob_url !== undefined) {
      fields.push(`blob_url = $${idx++}`);
      values.push(patch.blob_url);
    }
    if (patch.blob_pathname !== undefined) {
      fields.push(`blob_pathname = $${idx++}`);
      values.push(patch.blob_pathname);
    }

    if (fields.length === 0) return this.getDocument(documentId);

    values.push(documentId);
    const res = await this.pool.query(
      `UPDATE documind_documents SET ${fields.join(", ")} WHERE id = $${idx} RETURNING id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at`,
      values
    );
    return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
  }

  async insertChunks(
    chunks: StoredChunk[],
    options: { provider?: AiProvider; embeddingModel?: string } = {}
  ): Promise<void> {
    if (chunks.length === 0) return;
    await this.init();

    if (!this.schemaCaps.hasEmbeddingCfColumn || !this.schemaCaps.embeddingNullable) {
      await this.refreshSchemaCapabilities();
    }

    if (!this.schemaCaps.hasEmbeddingCfColumn || !this.schemaCaps.embeddingNullable) {
      throw new StorageConfigError(
        "Database migration 001_cloudflare_embeddings.sql has not been applied yet (missing nullable `embedding` or `embedding_cf` column). Run the explicit SQL migration before indexing with Cloudflare Workers AI."
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sql = this.pgVectorEnabled
        ? `INSERT INTO documind_chunks (
             chunk_id, document_id, filename, page_number, text, token_count,
             embedding, embedding_cf, embedding_cf_model
           ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::vector, $8)
           ON CONFLICT (chunk_id) DO UPDATE SET
             text = EXCLUDED.text,
             token_count = EXCLUDED.token_count,
             embedding_cf = EXCLUDED.embedding_cf,
             embedding_cf_model = EXCLUDED.embedding_cf_model`
        : `INSERT INTO documind_chunks (
             chunk_id, document_id, filename, page_number, text, token_count,
             embedding, embedding_cf, embedding_cf_model
           ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::double precision[], $8)
           ON CONFLICT (chunk_id) DO UPDATE SET
             text = EXCLUDED.text,
             token_count = EXCLUDED.token_count,
             embedding_cf = EXCLUDED.embedding_cf,
             embedding_cf_model = EXCLUDED.embedding_cf_model`;

      for (const c of chunks) {
        const vec = c.embedding_cf;
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(`Missing Cloudflare embedding vector for chunk ${c.chunk_id}.`);
        }
        const embeddingParam = this.pgVectorEnabled ? toVectorLiteral(vec) : vec;
        const cfModel = c.embedding_cf_model ?? options.embeddingModel ?? "@cf/baai/bge-m3";
        await client.query(sql, [
          c.chunk_id,
          c.document_id,
          c.filename,
          c.page_number,
          c.text,
          c.token_count,
          embeddingParam,
          cfModel,
        ]);
      }

      await client.query("COMMIT");
      this.cachedEmbeddingDims = null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteDocument(documentId: string): Promise<{ deleted: boolean; blobUrl?: string | null; filename?: string }> {
    await this.init();
    const res = await this.pool.query(
      "DELETE FROM documind_documents WHERE id = $1 RETURNING filename, blob_url",
      [documentId]
    );
    if (!res.rows[0]) {
      return { deleted: false };
    }
    this.cachedEmbeddingDims = null;
    return {
      deleted: true,
      filename: String(res.rows[0].filename),
      blobUrl: res.rows[0].blob_url ? String(res.rows[0].blob_url) : null,
    };
  }

  async searchSimilarChunks(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[],
    options: { provider?: AiProvider; embeddingModel?: string } = {}
  ): Promise<RetrievedChunkRef[]> {
    await this.init();
    const hasFilter = Array.isArray(documentIds) && documentIds.length > 0;

    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      await this.refreshSchemaCapabilities();
    }

    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      throw new StorageConfigError(
        "Database migration 001_cloudflare_embeddings.sql has not been applied yet (`embedding_cf` column missing). Run the explicit SQL migration and backfill before querying with Cloudflare Workers AI."
      );
    }

    const storedDims = await this.getEmbeddingDimensions();
    if (storedDims !== null && queryEmbedding.length !== storedDims) {
      throw new Error(
        `Vector dimension mismatch for cloudflare retrieval: query vector has ${queryEmbedding.length} dimensions while stored embedding_cf chunks have ${storedDims} dimensions.`
      );
    }

    const whereClauses: string[] = ["embedding_cf IS NOT NULL"];
    const baseParams: unknown[] = [];

    if (options.embeddingModel && this.schemaCaps.hasEmbeddingCfModelColumn) {
      baseParams.push(options.embeddingModel);
      whereClauses.push(`embedding_cf_model = $${baseParams.length}`);
    }

    if (this.pgVectorEnabled) {
      baseParams.push(queryEmbedding.length);
      whereClauses.push(`vector_dims(embedding_cf) = $${baseParams.length}`);
    }

    if (hasFilter) {
      baseParams.push(documentIds);
      whereClauses.push(`document_id = ANY($${baseParams.length}::text[])`);
    }

    const whereSql = whereClauses.join(" AND ");

    if (this.pgVectorEnabled) {
      const vecLiteral = toVectorLiteral(queryEmbedding);
      const vecIdx = baseParams.length + 1;
      const limitIdx = baseParams.length + 2;
      const sql = `SELECT chunk_id, document_id, filename, page_number, text,
                          (embedding_cf <=> $${vecIdx}::vector) AS distance,
                          (1 - (embedding_cf <=> $${vecIdx}::vector)) AS similarity
                   FROM documind_chunks
                   WHERE ${whereSql}
                   ORDER BY embedding_cf <=> $${vecIdx}::vector ASC
                   LIMIT $${limitIdx}`;

      const res = await this.pool.query(sql, [...baseParams, vecLiteral, topK]);
      return res.rows.map((row, idx) => {
        const sim = Number(row.similarity ?? 0);
        const dist = Number(row.distance ?? 1 - sim);
        return {
          rank: idx + 1,
          chunk_id: String(row.chunk_id),
          document_id: String(row.document_id),
          filename: String(row.filename),
          page_number: Number(row.page_number),
          text: String(row.text),
          similarity: Number(sim.toFixed(4)),
          distance: Number(dist.toFixed(4)),
        };
      });
    }

    const sql = `SELECT chunk_id, document_id, filename, page_number, text, embedding_cf AS vec
                 FROM documind_chunks
                 WHERE ${whereSql}`;
    const res = await this.pool.query(sql, baseParams);
    const scored = res.rows
      .map((row) => {
        const vec = parseVectorColumn(row.vec);
        if (vec.length !== queryEmbedding.length) return null;
        const sim = cosineSimilarity(queryEmbedding, vec);
        return {
          chunk_id: String(row.chunk_id),
          document_id: String(row.document_id),
          filename: String(row.filename),
          page_number: Number(row.page_number),
          text: String(row.text),
          similarity: sim,
          distance: 1 - sim,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).map((item, idx) => ({
      rank: idx + 1,
      chunk_id: item.chunk_id,
      document_id: item.document_id,
      filename: item.filename,
      page_number: item.page_number,
      text: item.text,
      similarity: Number(item.similarity.toFixed(4)),
      distance: Number(item.distance.toFixed(4)),
    }));
  }

  async getDocumentChunks(documentId: string, limit = 60): Promise<RetrievedChunkRef[]> {
    await this.init();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 60)));
    const res = await this.pool.query(
      `SELECT chunk_id, document_id, filename, page_number, text
       FROM documind_chunks
       WHERE document_id = $1
       ORDER BY page_number ASC, chunk_id ASC
       LIMIT $2`,
      [documentId, safeLimit]
    );
    return res.rows.map((row, idx) => ({
      rank: idx + 1,
      chunk_id: String(row.chunk_id),
      document_id: String(row.document_id),
      filename: String(row.filename),
      page_number: Number(row.page_number),
      text: String(row.text),
      similarity: 1,
      distance: 0,
    }));
  }

  async getTotalChunksCount(): Promise<number> {
    await this.init();
    const res = await this.pool.query("SELECT COUNT(*)::int AS cnt FROM documind_chunks");
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    await this.init();
    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      return null;
    }
    if (typeof this.cachedEmbeddingDims === "number" && this.cachedEmbeddingDims > 0) {
      return this.cachedEmbeddingDims;
    }
    const sql = this.pgVectorEnabled
      ? `SELECT vector_dims(embedding_cf) AS dims FROM documind_chunks WHERE embedding_cf IS NOT NULL LIMIT 1`
      : `SELECT array_length(embedding_cf, 1) AS dims FROM documind_chunks WHERE embedding_cf IS NOT NULL LIMIT 1`;
    const res = await this.pool.query(sql);
    const dims = res.rows[0]?.dims;
    if (typeof dims === "number" && dims > 0) {
      this.cachedEmbeddingDims = dims;
      return dims;
    }
    return null;
  }

  async getChunkMigrationStats(): Promise<ChunkMigrationStats> {
    await this.init();
    if (!this.schemaCaps.hasEmbeddingCfColumn || !this.schemaCaps.embeddingNullable) {
      await this.refreshSchemaCapabilities();
    }
    const hasCf = this.schemaCaps.hasEmbeddingCfColumn;
    const cfSelect = hasCf
      ? `COUNT(*) FILTER (WHERE embedding_cf IS NOT NULL)::int AS cloudflare_chunks,
         COUNT(*) FILTER (WHERE embedding_cf IS NULL)::int AS missing_cloudflare_chunks`
      : `0::int AS cloudflare_chunks,
         COUNT(*)::int AS missing_cloudflare_chunks`;

    const res = await this.pool.query<{
      total_chunks: number;
      legacy_chunks: number;
      cloudflare_chunks: number;
      missing_cloudflare_chunks: number;
    }>(
      `SELECT
         COUNT(*)::int AS total_chunks,
         COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS legacy_chunks,
         ${cfSelect}
       FROM documind_chunks`
    );
    const row = res.rows[0];
    return {
      total_chunks: Number(row?.total_chunks ?? 0),
      legacy_chunks: Number(row?.legacy_chunks ?? 0),
      cloudflare_chunks: Number(row?.cloudflare_chunks ?? 0),
      missing_cloudflare_chunks: Number(row?.missing_cloudflare_chunks ?? 0),
      has_embedding_cf_column: this.schemaCaps.hasEmbeddingCfColumn,
      has_embedding_model_column: this.schemaCaps.hasEmbeddingModelColumn,
      has_embedding_cf_model_column: this.schemaCaps.hasEmbeddingCfModelColumn,
      embedding_nullable: this.schemaCaps.embeddingNullable,
      pgvector_enabled: this.pgVectorEnabled,
    };
  }

  async inspectChunkMigrationStatsReadOnly(): Promise<ChunkMigrationStats> {
    assertPreviewDatabaseIsolation(this.databaseUrl);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");

      const extRes = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1"
      );
      const pgVectorEnabled = (extRes.rowCount ?? extRes.rows.length) > 0;

      const tableRes = await client.query(
        `SELECT 1
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'documind_chunks'
         LIMIT 1`
      );
      const tableExists = (tableRes.rowCount ?? tableRes.rows.length) > 0;

      if (!tableExists) {
        await client.query("COMMIT");
        return {
          total_chunks: 0,
          legacy_chunks: 0,
          cloudflare_chunks: 0,
          missing_cloudflare_chunks: 0,
          has_embedding_cf_column: false,
          has_embedding_model_column: false,
          has_embedding_cf_model_column: false,
          embedding_nullable: false,
          pgvector_enabled: pgVectorEnabled,
        };
      }

      const colRes = await client.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'documind_chunks'`
      );
      const colMap = new Map(
        colRes.rows.map((r) => [String(r.column_name), String(r.is_nullable).toUpperCase() === "YES"])
      );
      const hasEmbeddingModelColumn = colMap.has("embedding_model");
      const hasEmbeddingCfColumn = colMap.has("embedding_cf");
      const hasEmbeddingCfModelColumn = colMap.has("embedding_cf_model");
      const embeddingNullable = colMap.get("embedding") ?? false;
      const hasLegacyEmbeddingColumn = colMap.has("embedding");

      const legacySelect = hasLegacyEmbeddingColumn
        ? "COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS legacy_chunks"
        : "0::int AS legacy_chunks";
      const cfSelect = hasEmbeddingCfColumn
        ? `COUNT(*) FILTER (WHERE embedding_cf IS NOT NULL)::int AS cloudflare_chunks,
           COUNT(*) FILTER (WHERE embedding_cf IS NULL)::int AS missing_cloudflare_chunks`
        : `0::int AS cloudflare_chunks,
           COUNT(*)::int AS missing_cloudflare_chunks`;

      const res = await client.query<{
        total_chunks: number;
        legacy_chunks: number;
        cloudflare_chunks: number;
        missing_cloudflare_chunks: number;
      }>(
        `SELECT
           COUNT(*)::int AS total_chunks,
           ${legacySelect},
           ${cfSelect}
         FROM documind_chunks`
      );
      await client.query("COMMIT");

      const row = res.rows[0];
      return {
        total_chunks: Number(row?.total_chunks ?? 0),
        legacy_chunks: Number(row?.legacy_chunks ?? 0),
        cloudflare_chunks: Number(row?.cloudflare_chunks ?? 0),
        missing_cloudflare_chunks: Number(row?.missing_cloudflare_chunks ?? 0),
        has_embedding_cf_column: hasEmbeddingCfColumn,
        has_embedding_model_column: hasEmbeddingModelColumn,
        has_embedding_cf_model_column: hasEmbeddingCfModelColumn,
        embedding_nullable: embeddingNullable,
        pgvector_enabled: pgVectorEnabled,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async fetchChunksNeedingCloudflareEmbedding(
    limit: number,
    excludeChunkIds: string[] = []
  ): Promise<Array<{ chunk_id: string; text: string }>> {
    await this.init();
    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      await this.refreshSchemaCapabilities();
    }
    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      throw new StorageConfigError(
        "Cannot backfill Cloudflare embeddings: `embedding_cf` column does not exist. Run migrations/001_cloudflare_embeddings.sql first."
      );
    }
    const cleanedExclusions = excludeChunkIds.filter((id) => typeof id === "string" && id.length > 0);
    const res =
      cleanedExclusions.length > 0
        ? await this.pool.query<{ chunk_id: string; text: string }>(
            `SELECT chunk_id, text
             FROM documind_chunks
             WHERE embedding_cf IS NULL
               AND NOT (chunk_id = ANY($2::text[]))
             ORDER BY chunk_id ASC
             LIMIT $1`,
            [limit, cleanedExclusions]
          )
        : await this.pool.query<{ chunk_id: string; text: string }>(
            `SELECT chunk_id, text
             FROM documind_chunks
             WHERE embedding_cf IS NULL
             ORDER BY chunk_id ASC
             LIMIT $1`,
            [limit]
          );
    return res.rows.map((r) => ({ chunk_id: String(r.chunk_id), text: String(r.text) }));
  }

  async fetchDocumentsWithMissingChunks(limit: number): Promise<DocumentRecord[]> {
    await this.init();
    const res = await this.pool.query(
      `SELECT d.id, d.filename, d.size_bytes, d.pages, d.chunks_count, d.status, d.progress,
              d.error_message, d.sha256, d.blob_url, d.blob_pathname, d.uploaded_at
       FROM documind_documents d
       WHERE NOT EXISTS (
         SELECT 1 FROM documind_chunks c WHERE c.document_id = d.id
       )
       ORDER BY d.uploaded_at ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.mapDocRow(r));
  }

  async markCompleteDocumentsIndexed(): Promise<number> {
    await this.init();
    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      return 0;
    }
    const res = await this.pool.query(
      `UPDATE documind_documents d
       SET status = 'Indexed Successfully',
           progress = 100,
           error_message = NULL,
           chunks_count = sub.total_chunks
       FROM (
         SELECT document_id,
                COUNT(*)::int AS total_chunks,
                COUNT(*) FILTER (WHERE embedding_cf IS NULL)::int AS pending_cf
         FROM documind_chunks
         GROUP BY document_id
       ) sub
       WHERE d.id = sub.document_id
         AND sub.total_chunks > 0
         AND sub.pending_cf = 0
         AND (d.status <> 'Indexed Successfully' OR d.progress < 100 OR d.chunks_count <> sub.total_chunks)`
    );
    return res.rowCount ?? 0;
  }

  async saveCloudflareChunkEmbeddings(
    items: Array<{ chunk_id: string; embedding_cf: number[]; embedding_cf_model: string }>
  ): Promise<number> {
    if (items.length === 0) return 0;
    await this.init();
    if (!this.schemaCaps.hasEmbeddingCfColumn) {
      throw new StorageConfigError(
        "Cannot save Cloudflare embeddings: `embedding_cf` column does not exist."
      );
    }
    const client = await this.pool.connect();
    let updated = 0;
    try {
      await client.query("BEGIN");
      const sql = this.pgVectorEnabled
        ? `UPDATE documind_chunks
           SET embedding_cf = $1::vector, embedding_cf_model = $2
           WHERE chunk_id = $3 AND embedding_cf IS NULL`
        : `UPDATE documind_chunks
           SET embedding_cf = $1::double precision[], embedding_cf_model = $2
           WHERE chunk_id = $3 AND embedding_cf IS NULL`;
      for (const item of items) {
        const param = this.pgVectorEnabled ? toVectorLiteral(item.embedding_cf) : item.embedding_cf;
        const res = await client.query(sql, [param, item.embedding_cf_model, item.chunk_id]);
        updated += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
      this.cachedEmbeddingDims = null;
      return updated;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async inspectDatabaseIdentity(): Promise<DatabaseIdentity> {
    const target = parseDatabaseTargetInfo(this.databaseUrl);
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ current_database: string; server_version: string }>(
        "SELECT current_database() AS current_database, current_setting('server_version') AS server_version"
      );
      const row = res.rows[0];
      return {
        hostname: target.hostname,
        urlDatabaseName: target.databaseName,
        serverDatabaseName: String(row?.current_database ?? "").trim(),
        serverVersion: String(row?.server_version ?? "unknown").trim(),
      };
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async recordConversation(record: ConversationRecord): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO documind_conversations (id, question, answer, sources_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [record.id, record.question, record.answer, JSON.stringify(record.sources), record.created_at]
    );
    await this.pool.query(
      `INSERT INTO documind_meta (key, value_int)
       VALUES ('questions_answered', 1)
       ON CONFLICT (key) DO UPDATE SET value_int = documind_meta.value_int + 1`
    );
  }

  async getHistory(): Promise<ConversationRecord[]> {
    await this.init();
    const res = await this.pool.query(
      "SELECT id, question, answer, sources_json, created_at FROM documind_conversations ORDER BY created_at ASC LIMIT 200"
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      question: String(row.question),
      answer: String(row.answer),
      sources: Array.isArray(row.sources_json)
        ? (row.sources_json as RetrievedChunkRef[])
        : [],
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
  }

  async clearHistory(): Promise<void> {
    await this.init();
    await this.pool.query("DELETE FROM documind_conversations");
  }

  async getQuestionsAnswered(): Promise<number> {
    await this.init();
    const res = await this.pool.query(
      "SELECT value_int FROM documind_meta WHERE key = 'questions_answered' LIMIT 1"
    );
    return Number(res.rows[0]?.value_int ?? 0);
  }

  async savePdfBinary(documentId: string, filename: string, buffer: Buffer): Promise<UploadedBinaryRef> {
    if (!hasBlobCredentials()) {
      if (isVercelEnvironment()) {
        throw new StorageConfigError(
          "Vercel Blob credentials are required to store PDF files durably on Vercel (configure OIDC with BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN)."
        );
      }
      const uploadDir = path.resolve(process.cwd(), "uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const safePath = path.resolve(uploadDir, `${documentId}_${filename}`);
      if (!safePath.startsWith(uploadDir + path.sep)) {
        throw new Error("Invalid file path.");
      }
      fs.writeFileSync(safePath, buffer);
      return { blobUrl: null, blobPathname: null };
    }

    const blobPath = `documind/${documentId}/${filename}`;
    const access = getBlobAccessMode();
    const authOptions = getBlobAuthOptions();

    const uploaded = await put(blobPath, buffer, {
      ...authOptions,
      access,
      addRandomSuffix: true,
      contentType: "application/pdf",
    });
    return { blobUrl: uploaded.url, blobPathname: uploaded.pathname };
  }

  async getPdfBinary(doc: DocumentRecord): Promise<{ buffer: Buffer; contentType: string } | null> {
    const target = doc.blob_url || doc.blob_pathname;
    if (target && hasBlobCredentials()) {
      const result = await get(target, {
        ...getBlobAuthOptions(),
        access: getBlobAccessMode(),
        useCache: false,
      });
      if (!result || result.statusCode !== 200 || !result.stream) {
        return null;
      }
      const chunks: Uint8Array[] = [];
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return {
        buffer: Buffer.concat(chunks),
        contentType: result.blob.contentType || "application/pdf",
      };
    }

    if (!isVercelEnvironment()) {
      const uploadDir = path.resolve(process.cwd(), "uploads");
      const safePath = path.resolve(uploadDir, `${doc.id}_${doc.filename}`);
      if (safePath.startsWith(uploadDir + path.sep) && fs.existsSync(safePath)) {
        return {
          buffer: fs.readFileSync(safePath),
          contentType: "application/pdf",
        };
      }
    }

    return null;
  }

  async deletePdfBinary(documentId: string, filename: string, blobUrl?: string | null): Promise<void> {
    if (blobUrl && hasBlobCredentials()) {
      try {
        await del(blobUrl, getBlobAuthOptions());
      } catch {
        // Ignore missing blob object during cleanup
      }
      return;
    }

    if (!isVercelEnvironment()) {
      const uploadDir = path.resolve(process.cwd(), "uploads");
      const safePath = path.resolve(uploadDir, `${documentId}_${filename}`);
      if (safePath.startsWith(uploadDir + path.sep) && fs.existsSync(safePath)) {
        fs.unlinkSync(safePath);
      }
    }
  }
}

interface LocalStoreFile {
  documents: Record<string, DocumentRecord>;
  chunks: StoredChunk[];
  conversations: ConversationRecord[];
  questions_answered: number;
}

/**
 * Local development fallback used ONLY outside Vercel when DATABASE_URL is not configured.
 */
export class LocalDevJsonStorage implements StorageAdapter {
  private baseDataDir = path.resolve(process.cwd(), "data");
  private baseUploadDir = path.resolve(process.cwd(), "uploads");
  private storePath = path.resolve(this.baseDataDir, "documind_store.json");
  private store: LocalStoreFile;

  constructor(customStorePath?: string) {
    if (customStorePath) {
      this.storePath = path.resolve(customStorePath);
      this.baseDataDir = path.dirname(this.storePath);
    }
    this.ensureDirs();
    this.store = this.loadStore();
  }

  private ensureDirs() {
    if (!fs.existsSync(this.baseDataDir)) fs.mkdirSync(this.baseDataDir, { recursive: true });
    if (!fs.existsSync(this.baseUploadDir)) fs.mkdirSync(this.baseUploadDir, { recursive: true });
  }

  private loadStore(): LocalStoreFile {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<LocalStoreFile>;
        return {
          documents: parsed.documents ?? {},
          chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
          conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
          questions_answered:
            typeof parsed.questions_answered === "number" ? parsed.questions_answered : 0,
        };
      }
    } catch {
      // Recover cleanly on corrupted local store
    }
    return {
      documents: {},
      chunks: [],
      conversations: [],
      questions_answered: 0,
    };
  }

  private saveStore() {
    this.ensureDirs();
    const tmpPath = `${this.storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.store), "utf-8");
    fs.renameSync(tmpPath, this.storePath);
  }

  async init(): Promise<void> {}

  getInfo(): StorageInfo {
    return {
      storage_mode: "local-dev",
      vector_store: "local-dev-json",
      object_storage: "local-dev-fs",
      storage_label: "Local Dev Store (set DATABASE_URL & BLOB_STORE_ID for production)",
    };
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    return Object.values(this.store.documents).sort((a, b) =>
      b.uploaded_at.localeCompare(a.uploaded_at)
    );
  }

  async getDocument(documentId: string): Promise<DocumentRecord | null> {
    return this.store.documents[documentId] ?? null;
  }

  async findIndexedBySha256(sha256: string): Promise<DocumentRecord | null> {
    for (const existing of Object.values(this.store.documents)) {
      if (existing.sha256 === sha256 && existing.status === "Indexed Successfully") {
        return existing;
      }
    }
    return null;
  }

  async insertDocument(doc: DocumentRecord): Promise<void> {
    this.store.documents[doc.id] = doc;
    this.saveStore();
  }

  async updateDocument(
    documentId: string,
    patch: Partial<Pick<DocumentRecord, "status" | "progress" | "pages" | "chunks_count" | "error_message" | "blob_url" | "blob_pathname">>
  ): Promise<DocumentRecord | null> {
    const existing = this.store.documents[documentId];
    if (!existing) return null;
    Object.assign(existing, patch);
    this.saveStore();
    return existing;
  }

  async insertChunks(
    chunks: StoredChunk[],
    _options: { provider?: AiProvider; embeddingModel?: string } = {}
  ): Promise<void> {
    this.store.chunks.push(...chunks);
    this.saveStore();
  }

  async deleteDocument(documentId: string): Promise<{ deleted: boolean; blobUrl?: string | null; filename?: string }> {
    const existing = this.store.documents[documentId];
    if (!existing) return { deleted: false };
    delete this.store.documents[documentId];
    this.store.chunks = this.store.chunks.filter((c) => c.document_id !== documentId);
    this.saveStore();
    return { deleted: true, filename: existing.filename, blobUrl: existing.blob_url };
  }

  async searchSimilarChunks(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[],
    options: { provider?: AiProvider; embeddingModel?: string } = {}
  ): Promise<RetrievedChunkRef[]> {
    const scopeSet =
      documentIds && documentIds.length > 0 ? new Set(documentIds) : null;

    const candidates = this.store.chunks.filter((c) => {
      if (scopeSet && !scopeSet.has(c.document_id)) return false;
      const doc = this.store.documents[c.document_id];
      if (!doc || doc.status !== "Indexed Successfully") return false;
      const vec = c.embedding_cf;
      if (!Array.isArray(vec) || vec.length !== queryEmbedding.length) return false;
      if (
        options.embeddingModel &&
        c.embedding_cf_model &&
        c.embedding_cf_model !== options.embeddingModel
      ) {
        return false;
      }
      return true;
    });

    const scored = candidates.map((chunk) => {
      const vec = chunk.embedding_cf ?? [];
      const sim = cosineSimilarity(queryEmbedding, vec);
      return {
        chunk,
        similarity: sim,
        distance: 1 - sim,
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK).map((item, idx) => ({
      rank: idx + 1,
      chunk_id: item.chunk.chunk_id,
      document_id: item.chunk.document_id,
      filename: item.chunk.filename,
      page_number: item.chunk.page_number,
      text: item.chunk.text,
      similarity: Number(item.similarity.toFixed(4)),
      distance: Number(item.distance.toFixed(4)),
    }));
  }

  async getDocumentChunks(documentId: string, limit = 60): Promise<RetrievedChunkRef[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 60)));
    const doc = this.store.documents[documentId];
    if (!doc || doc.status !== "Indexed Successfully") {
      return [];
    }
    const ordered = this.store.chunks
      .filter((c) => c.document_id === documentId)
      .sort((a, b) => a.page_number - b.page_number || a.chunk_id.localeCompare(b.chunk_id))
      .slice(0, safeLimit);

    return ordered.map((chunk, idx) => ({
      rank: idx + 1,
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      filename: chunk.filename,
      page_number: chunk.page_number,
      text: chunk.text,
      similarity: 1,
      distance: 0,
    }));
  }

  async getTotalChunksCount(): Promise<number> {
    return this.store.chunks.length;
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    for (const chunk of this.store.chunks) {
      const vec = chunk.embedding_cf;
      if (Array.isArray(vec) && vec.length > 0) {
        return vec.length;
      }
    }
    return null;
  }

  async getChunkMigrationStats(): Promise<ChunkMigrationStats> {
    const totalChunks = this.store.chunks.length;
    const legacyChunks = this.store.chunks.filter(
      (c) => Array.isArray(c.embedding) && c.embedding.length > 0
    ).length;
    const cloudflareChunks = this.store.chunks.filter(
      (c) => Array.isArray(c.embedding_cf) && c.embedding_cf.length > 0
    ).length;
    return {
      total_chunks: totalChunks,
      legacy_chunks: legacyChunks,
      cloudflare_chunks: cloudflareChunks,
      missing_cloudflare_chunks: totalChunks - cloudflareChunks,
      has_embedding_cf_column: true,
      has_embedding_model_column: true,
      has_embedding_cf_model_column: true,
      embedding_nullable: true,
      pgvector_enabled: false,
    };
  }

  async recordConversation(record: ConversationRecord): Promise<void> {
    this.store.conversations.push(record);
    if (this.store.conversations.length > 200) {
      this.store.conversations = this.store.conversations.slice(-200);
    }
    this.store.questions_answered += 1;
    this.saveStore();
  }

  async getHistory(): Promise<ConversationRecord[]> {
    return this.store.conversations;
  }

  async clearHistory(): Promise<void> {
    this.store.conversations = [];
    this.saveStore();
  }

  async getQuestionsAnswered(): Promise<number> {
    return this.store.questions_answered;
  }

  async savePdfBinary(documentId: string, filename: string, buffer: Buffer): Promise<UploadedBinaryRef> {
    this.ensureDirs();
    const safeDiskPath = path.resolve(this.baseUploadDir, `${documentId}_${filename}`);
    if (!safeDiskPath.startsWith(this.baseUploadDir + path.sep)) {
      throw new Error("Invalid file path.");
    }
    fs.writeFileSync(safeDiskPath, buffer);
    return { blobUrl: null, blobPathname: null };
  }

  async getPdfBinary(doc: DocumentRecord): Promise<{ buffer: Buffer; contentType: string } | null> {
    const safeDiskPath = path.resolve(this.baseUploadDir, `${doc.id}_${doc.filename}`);
    if (safeDiskPath.startsWith(this.baseUploadDir + path.sep) && fs.existsSync(safeDiskPath)) {
      return {
        buffer: fs.readFileSync(safeDiskPath),
        contentType: "application/pdf",
      };
    }
    return null;
  }

  async deletePdfBinary(documentId: string, filename: string): Promise<void> {
    const safeDiskPath = path.resolve(this.baseUploadDir, `${documentId}_${filename}`);
    if (safeDiskPath.startsWith(this.baseUploadDir + path.sep) && fs.existsSync(safeDiskPath)) {
      fs.unlinkSync(safeDiskPath);
    }
  }
}

class UnconfiguredProductionStorage implements StorageAdapter {
  private missingMessage(): StorageConfigError {
    const missing: string[] = [];
    if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
    if (!hasBlobCredentials()) missing.push("BLOB_STORE_ID (OIDC) or BLOB_READ_WRITE_TOKEN");
    return new StorageConfigError(
      `Production storage is not configured. Missing environment variable(s): ${missing.join(", ")}. Configure PostgreSQL and Vercel Blob in Vercel Project Settings.`
    );
  }

  async init(): Promise<void> {
    throw this.missingMessage();
  }
  getInfo(): StorageInfo {
    return {
      storage_mode: "production-durable",
      vector_store: "postgres-pgvector",
      object_storage: "vercel-blob",
      storage_label: "Missing DATABASE_URL / BLOB_STORE_ID",
    };
  }
  async listDocuments(): Promise<DocumentRecord[]> { throw this.missingMessage(); }
  async getDocument(): Promise<DocumentRecord | null> { throw this.missingMessage(); }
  async findIndexedBySha256(): Promise<DocumentRecord | null> { throw this.missingMessage(); }
  async insertDocument(): Promise<void> { throw this.missingMessage(); }
  async updateDocument(): Promise<DocumentRecord | null> { throw this.missingMessage(); }
  async insertChunks(): Promise<void> { throw this.missingMessage(); }
  async deleteDocument(): Promise<{ deleted: boolean }> { throw this.missingMessage(); }
  async searchSimilarChunks(): Promise<RetrievedChunkRef[]> { throw this.missingMessage(); }
  async getDocumentChunks(): Promise<RetrievedChunkRef[]> { throw this.missingMessage(); }
  async getTotalChunksCount(): Promise<number> { throw this.missingMessage(); }
  async getEmbeddingDimensions(): Promise<number | null> { throw this.missingMessage(); }
  async getChunkMigrationStats(): Promise<ChunkMigrationStats> { throw this.missingMessage(); }
  async recordConversation(): Promise<void> { throw this.missingMessage(); }
  async getHistory(): Promise<ConversationRecord[]> { throw this.missingMessage(); }
  async clearHistory(): Promise<void> { throw this.missingMessage(); }
  async getQuestionsAnswered(): Promise<number> { throw this.missingMessage(); }
  async savePdfBinary(): Promise<UploadedBinaryRef> { throw this.missingMessage(); }
  async getPdfBinary(): Promise<{ buffer: Buffer; contentType: string } | null> { throw this.missingMessage(); }
  async deletePdfBinary(): Promise<void> { throw this.missingMessage(); }
}

let cachedAdapter: StorageAdapter | null = null;
let testAdapterOverride: StorageAdapter | null = null;

export function setStorageAdapterForTest(adapter: StorageAdapter | null): void {
  testAdapterOverride = adapter;
}

export function getStorageAdapter(): StorageAdapter {
  if (testAdapterOverride) return testAdapterOverride;
  if (cachedAdapter) return cachedAdapter;
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    cachedAdapter = new PostgresBlobStorage(dbUrl);
    return cachedAdapter;
  }
  if (isVercelEnvironment()) {
    cachedAdapter = new UnconfiguredProductionStorage();
    return cachedAdapter;
  }
  cachedAdapter = new LocalDevJsonStorage();
  return cachedAdapter;
}
