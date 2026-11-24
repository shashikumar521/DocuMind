import { del, put } from "@vercel/blob";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { RetrievedChunkRef } from "./geminiClient.js";

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
  embedding: number[];
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
  insertChunks(chunks: StoredChunk[]): Promise<void>;
  deleteDocument(documentId: string): Promise<{ deleted: boolean; blobUrl?: string | null; filename?: string }>;
  searchSimilarChunks(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[]
  ): Promise<RetrievedChunkRef[]>;
  getTotalChunksCount(): Promise<number>;
  getEmbeddingDimensions(): Promise<number | null>;
  recordConversation(record: ConversationRecord): Promise<void>;
  getHistory(): Promise<ConversationRecord[]>;
  clearHistory(): Promise<void>;
  getQuestionsAnswered(): Promise<number>;
  savePdfBinary(documentId: string, filename: string, buffer: Buffer): Promise<UploadedBinaryRef>;
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

function isVercelEnvironment(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

function hasBlobCredentials(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim());
}

/**
 * Durable production storage backed by PostgreSQL (with pgvector when available)
 * and Vercel Blob for PDF object storage.
 */
class PostgresBlobStorage implements StorageAdapter {
  private pool: Pool;
  private initPromise: Promise<void> | null = null;
  private pgVectorEnabled = false;

  constructor(databaseUrl: string) {
    const needsSsl =
      databaseUrl.includes("sslmode=require") ||
      databaseUrl.includes("neon.tech") ||
      databaseUrl.includes("supabase") ||
      databaseUrl.includes("vercel-storage") ||
      isVercelEnvironment();

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
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
    if (isVercelEnvironment() && !hasBlobCredentials()) {
      throw new StorageConfigError(
        "BLOB_READ_WRITE_TOKEN is not configured. Connect a Vercel Blob store in Project Settings > Storage."
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
            embedding vector NOT NULL
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
            embedding DOUBLE PRECISION[] NOT NULL
          );
        `);
      }

      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_documind_chunks_document_id ON documind_chunks (document_id);"
      );

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

  getInfo(): StorageInfo {
    const usesBlob = hasBlobCredentials();
    return {
      storage_mode: "production-durable",
      vector_store: this.pgVectorEnabled ? "postgres-pgvector" : "postgres-array",
      object_storage: usesBlob ? "vercel-blob" : "local-dev-fs",
      storage_label: this.pgVectorEnabled
        ? "PostgreSQL (pgvector) + Vercel Blob"
        : "PostgreSQL + Vercel Blob",
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

  async insertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sql = this.pgVectorEnabled
        ? `INSERT INTO documind_chunks (chunk_id, document_id, filename, page_number, text, token_count, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`
        : `INSERT INTO documind_chunks (chunk_id, document_id, filename, page_number, text, token_count, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::double precision[])`;

      for (const c of chunks) {
        const embeddingParam = this.pgVectorEnabled ? toVectorLiteral(c.embedding) : c.embedding;
        await client.query(sql, [
          c.chunk_id,
          c.document_id,
          c.filename,
          c.page_number,
          c.text,
          c.token_count,
          embeddingParam,
        ]);
      }
      await client.query("COMMIT");
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
    return {
      deleted: true,
      filename: String(res.rows[0].filename),
      blobUrl: res.rows[0].blob_url ? String(res.rows[0].blob_url) : null,
    };
  }

  async searchSimilarChunks(
    queryEmbedding: number[],
    topK: number,
    documentIds?: string[]
  ): Promise<RetrievedChunkRef[]> {
    await this.init();
    const hasFilter = Array.isArray(documentIds) && documentIds.length > 0;

    if (this.pgVectorEnabled) {
      const vecLiteral = toVectorLiteral(queryEmbedding);
      const sql = hasFilter
        ? `SELECT chunk_id, document_id, filename, page_number, text,
                  (embedding <=> $1::vector) AS distance,
                  (1 - (embedding <=> $1::vector)) AS similarity
           FROM documind_chunks
           WHERE document_id = ANY($2::text[])
           ORDER BY embedding <=> $1::vector ASC
           LIMIT $3`
        : `SELECT chunk_id, document_id, filename, page_number, text,
                  (embedding <=> $1::vector) AS distance,
                  (1 - (embedding <=> $1::vector)) AS similarity
           FROM documind_chunks
           ORDER BY embedding <=> $1::vector ASC
           LIMIT $2`;

      const params = hasFilter ? [vecLiteral, documentIds, topK] : [vecLiteral, topK];
      const res = await this.pool.query(sql, params);
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

    const sql = hasFilter
      ? "SELECT chunk_id, document_id, filename, page_number, text, embedding FROM documind_chunks WHERE document_id = ANY($1::text[])"
      : "SELECT chunk_id, document_id, filename, page_number, text, embedding FROM documind_chunks";
    const res = await this.pool.query(sql, hasFilter ? [documentIds] : []);
    const scored = res.rows.map((row) => {
      const sim = cosineSimilarity(queryEmbedding, parseVectorColumn(row.embedding));
      return {
        chunk_id: String(row.chunk_id),
        document_id: String(row.document_id),
        filename: String(row.filename),
        page_number: Number(row.page_number),
        text: String(row.text),
        similarity: sim,
        distance: 1 - sim,
      };
    });
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

  async getTotalChunksCount(): Promise<number> {
    await this.init();
    const res = await this.pool.query("SELECT COUNT(*)::int AS cnt FROM documind_chunks");
    return Number(res.rows[0]?.cnt ?? 0);
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    await this.init();
    const sql = this.pgVectorEnabled
      ? "SELECT vector_dims(embedding) AS dims FROM documind_chunks LIMIT 1"
      : "SELECT array_length(embedding, 1) AS dims FROM documind_chunks LIMIT 1";
    const res = await this.pool.query(sql);
    const dims = res.rows[0]?.dims;
    return typeof dims === "number" && dims > 0 ? dims : null;
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
          "BLOB_READ_WRITE_TOKEN is required to store PDF files durably on Vercel."
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
    const preferredAccess = process.env.BLOB_ACCESS === "private" ? "private" : "public";

    try {
      const uploaded = await put(blobPath, buffer, {
        access: preferredAccess,
        addRandomSuffix: true,
        contentType: "application/pdf",
      });
      return { blobUrl: uploaded.url, blobPathname: uploaded.pathname };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("private store") || msg.toLowerCase().includes("public store")) {
        const fallbackAccess = preferredAccess === "public" ? "private" : "public";
        const uploaded = await put(blobPath, buffer, {
          access: fallbackAccess,
          addRandomSuffix: true,
          contentType: "application/pdf",
        });
        return { blobUrl: uploaded.url, blobPathname: uploaded.pathname };
      }
      throw err;
    }
  }

  async deletePdfBinary(documentId: string, filename: string, blobUrl?: string | null): Promise<void> {
    if (blobUrl && hasBlobCredentials()) {
      try {
        await del(blobUrl);
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
class LocalDevJsonStorage implements StorageAdapter {
  private baseDataDir = path.resolve(process.cwd(), "data");
  private baseUploadDir = path.resolve(process.cwd(), "uploads");
  private storePath = path.resolve(this.baseDataDir, "documind_store.json");
  private store: LocalStoreFile;

  constructor() {
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
      storage_label: "Local Dev Store (set DATABASE_URL & BLOB_READ_WRITE_TOKEN for production)",
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

  async insertChunks(chunks: StoredChunk[]): Promise<void> {
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
    documentIds?: string[]
  ): Promise<RetrievedChunkRef[]> {
    const scopeSet =
      documentIds && documentIds.length > 0 ? new Set(documentIds) : null;

    const candidates = this.store.chunks.filter((c) => {
      if (scopeSet && !scopeSet.has(c.document_id)) return false;
      const doc = this.store.documents[c.document_id];
      return doc && doc.status === "Indexed Successfully";
    });

    const scored = candidates.map((chunk) => {
      const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
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

  async getTotalChunksCount(): Promise<number> {
    return this.store.chunks.length;
  }

  async getEmbeddingDimensions(): Promise<number | null> {
    const first = this.store.chunks[0];
    return first && Array.isArray(first.embedding) && first.embedding.length > 0
      ? first.embedding.length
      : null;
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
    if (!hasBlobCredentials()) missing.push("BLOB_READ_WRITE_TOKEN");
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
      storage_label: "Missing DATABASE_URL / BLOB_READ_WRITE_TOKEN",
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
  async getTotalChunksCount(): Promise<number> { throw this.missingMessage(); }
  async getEmbeddingDimensions(): Promise<number | null> { throw this.missingMessage(); }
  async recordConversation(): Promise<void> { throw this.missingMessage(); }
  async getHistory(): Promise<ConversationRecord[]> { throw this.missingMessage(); }
  async clearHistory(): Promise<void> { throw this.missingMessage(); }
  async getQuestionsAnswered(): Promise<number> { throw this.missingMessage(); }
  async savePdfBinary(): Promise<UploadedBinaryRef> { throw this.missingMessage(); }
  async deletePdfBinary(): Promise<void> { throw this.missingMessage(); }
}

let cachedAdapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
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
