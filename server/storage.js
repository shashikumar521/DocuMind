import { del, get, put } from "@vercel/blob";
import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
export class StorageConfigError extends Error {
    statusCode;
    constructor(message, statusCode = 503) {
        super(message);
        this.name = "StorageConfigError";
        this.statusCode = statusCode;
    }
}
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0)
        return 0;
    return dot / denom;
}
function toVectorLiteral(vec) {
    for (const v of vec) {
        if (!Number.isFinite(v)) {
            throw new Error("Invalid non-finite number in embedding vector.");
        }
    }
    return `[${vec.join(",")}]`;
}
function parseVectorColumn(raw) {
    if (Array.isArray(raw)) {
        return raw.map((n) => Number(n));
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
        if (!trimmed)
            return [];
        return trimmed.split(",").map((s) => Number(s));
    }
    return [];
}
const blobRequestContext = new AsyncLocalStorage();
const VERCEL_REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");
export function runWithBlobOidcContext(oidcToken, fn) {
    const cleaned = oidcToken?.trim() || undefined;
    return blobRequestContext.run({ oidcToken: cleaned }, fn);
}
function getVercelRequestContextOidcToken() {
    const asyncStoreToken = blobRequestContext.getStore()?.oidcToken?.trim();
    if (asyncStoreToken)
        return asyncStoreToken;
    const ctxGlobal = globalThis[VERCEL_REQUEST_CONTEXT_SYMBOL];
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
function getBlobStoreId() {
    return process.env.BLOB_STORE_ID?.trim() || undefined;
}
function getBlobAccessMode() {
    return process.env.BLOB_ACCESS === "public" ? "public" : "private";
}
function getBlobAuthOptions() {
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
function isVercelEnvironment() {
    return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}
function hasBlobCredentials() {
    return Boolean(getBlobStoreId() ||
        process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
        (getVercelRequestContextOidcToken() && getBlobStoreId()));
}
/**
 * Durable production storage backed by PostgreSQL (with pgvector when available)
 * and Vercel Blob for PDF object storage.
 */
class PostgresBlobStorage {
    pool;
    initPromise = null;
    pgVectorEnabled = false;
    constructor(databaseUrl) {
        const needsSsl = databaseUrl.includes("sslmode=") ||
            databaseUrl.includes("neon.tech") ||
            databaseUrl.includes("supabase") ||
            databaseUrl.includes("vercel-storage") ||
            isVercelEnvironment();
        let normalizedUrl = databaseUrl;
        let hasExplicitSslParam = false;
        try {
            const parsed = new URL(databaseUrl);
            const sslmode = parsed.searchParams.get("sslmode")?.toLowerCase();
            const uselibpqcompat = parsed.searchParams.get("uselibpqcompat")?.toLowerCase();
            if (sslmode) {
                hasExplicitSslParam = true;
                if (uselibpqcompat !== "true" &&
                    (sslmode === "prefer" || sslmode === "require" || sslmode === "verify-ca")) {
                    parsed.searchParams.set("sslmode", "verify-full");
                    normalizedUrl = parsed.toString();
                }
            }
            else if (needsSsl) {
                parsed.searchParams.set("sslmode", "verify-full");
                normalizedUrl = parsed.toString();
                hasExplicitSslParam = true;
            }
        }
        catch {
            // Non-URL connection string; keep original string and enforce strict TLS if needsSsl
        }
        this.pool = new Pool({
            connectionString: normalizedUrl,
            max: 5,
            idleTimeoutMillis: 20_000,
            connectionTimeoutMillis: 10_000,
            ssl: needsSsl && !hasExplicitSslParam ? { rejectUnauthorized: true } : undefined,
        });
    }
    async init() {
        if (!this.initPromise) {
            this.initPromise = this.bootstrapSchema().catch((err) => {
                this.initPromise = null;
                throw err;
            });
        }
        await this.initPromise;
    }
    async bootstrapSchema() {
        if (isVercelEnvironment() && !hasBlobCredentials()) {
            throw new StorageConfigError("Vercel Blob is not configured. Connect a Vercel Blob store with OIDC (BLOB_STORE_ID) or set BLOB_READ_WRITE_TOKEN in Project Settings > Storage.");
        }
        const client = await this.pool.connect();
        try {
            try {
                await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
                this.pgVectorEnabled = true;
            }
            catch {
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
            await client.query("CREATE INDEX IF NOT EXISTS idx_documind_documents_sha256 ON documind_documents (sha256);");
            await client.query("CREATE INDEX IF NOT EXISTS idx_documind_documents_uploaded_at ON documind_documents (uploaded_at DESC);");
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
            }
            else {
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
            await client.query("CREATE INDEX IF NOT EXISTS idx_documind_chunks_document_id ON documind_chunks (document_id);");
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
        }
        finally {
            client.release();
        }
    }
    getInfo() {
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
    mapDocRow(row) {
        return {
            id: String(row.id),
            filename: String(row.filename),
            size_bytes: Number(row.size_bytes ?? 0),
            pages: Number(row.pages ?? 0),
            chunks_count: Number(row.chunks_count ?? 0),
            status: row.status,
            progress: Number(row.progress ?? 0),
            error_message: row.error_message ? String(row.error_message) : null,
            sha256: String(row.sha256),
            blob_url: row.blob_url ? String(row.blob_url) : null,
            blob_pathname: row.blob_pathname ? String(row.blob_pathname) : null,
            uploaded_at: row.uploaded_at instanceof Date
                ? row.uploaded_at.toISOString()
                : String(row.uploaded_at),
        };
    }
    async listDocuments() {
        await this.init();
        const res = await this.pool.query("SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents ORDER BY uploaded_at DESC");
        return res.rows.map((r) => this.mapDocRow(r));
    }
    async getDocument(documentId) {
        await this.init();
        const res = await this.pool.query("SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents WHERE id = $1 LIMIT 1", [documentId]);
        return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
    }
    async findIndexedBySha256(sha256) {
        await this.init();
        const res = await this.pool.query("SELECT id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at FROM documind_documents WHERE sha256 = $1 AND status = 'Indexed Successfully' LIMIT 1", [sha256]);
        return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
    }
    async insertDocument(doc) {
        await this.init();
        await this.pool.query(`INSERT INTO documind_documents (
        id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
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
        ]);
    }
    async updateDocument(documentId, patch) {
        await this.init();
        const fields = [];
        const values = [];
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
        if (fields.length === 0)
            return this.getDocument(documentId);
        values.push(documentId);
        const res = await this.pool.query(`UPDATE documind_documents SET ${fields.join(", ")} WHERE id = $${idx} RETURNING id, filename, size_bytes, pages, chunks_count, status, progress, error_message, sha256, blob_url, blob_pathname, uploaded_at`, values);
        return res.rows[0] ? this.mapDocRow(res.rows[0]) : null;
    }
    async insertChunks(chunks) {
        if (chunks.length === 0)
            return;
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
        }
        catch (err) {
            await client.query("ROLLBACK");
            throw err;
        }
        finally {
            client.release();
        }
    }
    async deleteDocument(documentId) {
        await this.init();
        const res = await this.pool.query("DELETE FROM documind_documents WHERE id = $1 RETURNING filename, blob_url", [documentId]);
        if (!res.rows[0]) {
            return { deleted: false };
        }
        return {
            deleted: true,
            filename: String(res.rows[0].filename),
            blobUrl: res.rows[0].blob_url ? String(res.rows[0].blob_url) : null,
        };
    }
    async searchSimilarChunks(queryEmbedding, topK, documentIds) {
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
    async getTotalChunksCount() {
        await this.init();
        const res = await this.pool.query("SELECT COUNT(*)::int AS cnt FROM documind_chunks");
        return Number(res.rows[0]?.cnt ?? 0);
    }
    async getEmbeddingDimensions() {
        await this.init();
        const sql = this.pgVectorEnabled
            ? "SELECT vector_dims(embedding) AS dims FROM documind_chunks LIMIT 1"
            : "SELECT array_length(embedding, 1) AS dims FROM documind_chunks LIMIT 1";
        const res = await this.pool.query(sql);
        const dims = res.rows[0]?.dims;
        return typeof dims === "number" && dims > 0 ? dims : null;
    }
    async recordConversation(record) {
        await this.init();
        await this.pool.query(`INSERT INTO documind_conversations (id, question, answer, sources_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`, [record.id, record.question, record.answer, JSON.stringify(record.sources), record.created_at]);
        await this.pool.query(`INSERT INTO documind_meta (key, value_int)
       VALUES ('questions_answered', 1)
       ON CONFLICT (key) DO UPDATE SET value_int = documind_meta.value_int + 1`);
    }
    async getHistory() {
        await this.init();
        const res = await this.pool.query("SELECT id, question, answer, sources_json, created_at FROM documind_conversations ORDER BY created_at ASC LIMIT 200");
        return res.rows.map((row) => ({
            id: String(row.id),
            question: String(row.question),
            answer: String(row.answer),
            sources: Array.isArray(row.sources_json)
                ? row.sources_json
                : [],
            created_at: row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
        }));
    }
    async clearHistory() {
        await this.init();
        await this.pool.query("DELETE FROM documind_conversations");
    }
    async getQuestionsAnswered() {
        await this.init();
        const res = await this.pool.query("SELECT value_int FROM documind_meta WHERE key = 'questions_answered' LIMIT 1");
        return Number(res.rows[0]?.value_int ?? 0);
    }
    async savePdfBinary(documentId, filename, buffer) {
        if (!hasBlobCredentials()) {
            if (isVercelEnvironment()) {
                throw new StorageConfigError("Vercel Blob credentials are required to store PDF files durably on Vercel (configure OIDC with BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN).");
            }
            const uploadDir = path.resolve(process.cwd(), "uploads");
            if (!fs.existsSync(uploadDir))
                fs.mkdirSync(uploadDir, { recursive: true });
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
    async getPdfBinary(doc) {
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
            const chunks = [];
            const reader = result.stream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value)
                    chunks.push(value);
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
    async deletePdfBinary(documentId, filename, blobUrl) {
        if (blobUrl && hasBlobCredentials()) {
            try {
                await del(blobUrl, getBlobAuthOptions());
            }
            catch {
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
/**
 * Local development fallback used ONLY outside Vercel when DATABASE_URL is not configured.
 */
class LocalDevJsonStorage {
    baseDataDir = path.resolve(process.cwd(), "data");
    baseUploadDir = path.resolve(process.cwd(), "uploads");
    storePath = path.resolve(this.baseDataDir, "documind_store.json");
    store;
    constructor() {
        this.ensureDirs();
        this.store = this.loadStore();
    }
    ensureDirs() {
        if (!fs.existsSync(this.baseDataDir))
            fs.mkdirSync(this.baseDataDir, { recursive: true });
        if (!fs.existsSync(this.baseUploadDir))
            fs.mkdirSync(this.baseUploadDir, { recursive: true });
    }
    loadStore() {
        try {
            if (fs.existsSync(this.storePath)) {
                const raw = fs.readFileSync(this.storePath, "utf-8");
                const parsed = JSON.parse(raw);
                return {
                    documents: parsed.documents ?? {},
                    chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
                    conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
                    questions_answered: typeof parsed.questions_answered === "number" ? parsed.questions_answered : 0,
                };
            }
        }
        catch {
            // Recover cleanly on corrupted local store
        }
        return {
            documents: {},
            chunks: [],
            conversations: [],
            questions_answered: 0,
        };
    }
    saveStore() {
        this.ensureDirs();
        const tmpPath = `${this.storePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.store), "utf-8");
        fs.renameSync(tmpPath, this.storePath);
    }
    async init() { }
    getInfo() {
        return {
            storage_mode: "local-dev",
            vector_store: "local-dev-json",
            object_storage: "local-dev-fs",
            storage_label: "Local Dev Store (set DATABASE_URL & BLOB_READ_WRITE_TOKEN for production)",
        };
    }
    async listDocuments() {
        return Object.values(this.store.documents).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    }
    async getDocument(documentId) {
        return this.store.documents[documentId] ?? null;
    }
    async findIndexedBySha256(sha256) {
        for (const existing of Object.values(this.store.documents)) {
            if (existing.sha256 === sha256 && existing.status === "Indexed Successfully") {
                return existing;
            }
        }
        return null;
    }
    async insertDocument(doc) {
        this.store.documents[doc.id] = doc;
        this.saveStore();
    }
    async updateDocument(documentId, patch) {
        const existing = this.store.documents[documentId];
        if (!existing)
            return null;
        Object.assign(existing, patch);
        this.saveStore();
        return existing;
    }
    async insertChunks(chunks) {
        this.store.chunks.push(...chunks);
        this.saveStore();
    }
    async deleteDocument(documentId) {
        const existing = this.store.documents[documentId];
        if (!existing)
            return { deleted: false };
        delete this.store.documents[documentId];
        this.store.chunks = this.store.chunks.filter((c) => c.document_id !== documentId);
        this.saveStore();
        return { deleted: true, filename: existing.filename, blobUrl: existing.blob_url };
    }
    async searchSimilarChunks(queryEmbedding, topK, documentIds) {
        const scopeSet = documentIds && documentIds.length > 0 ? new Set(documentIds) : null;
        const candidates = this.store.chunks.filter((c) => {
            if (scopeSet && !scopeSet.has(c.document_id))
                return false;
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
    async getTotalChunksCount() {
        return this.store.chunks.length;
    }
    async getEmbeddingDimensions() {
        const first = this.store.chunks[0];
        return first && Array.isArray(first.embedding) && first.embedding.length > 0
            ? first.embedding.length
            : null;
    }
    async recordConversation(record) {
        this.store.conversations.push(record);
        if (this.store.conversations.length > 200) {
            this.store.conversations = this.store.conversations.slice(-200);
        }
        this.store.questions_answered += 1;
        this.saveStore();
    }
    async getHistory() {
        return this.store.conversations;
    }
    async clearHistory() {
        this.store.conversations = [];
        this.saveStore();
    }
    async getQuestionsAnswered() {
        return this.store.questions_answered;
    }
    async savePdfBinary(documentId, filename, buffer) {
        this.ensureDirs();
        const safeDiskPath = path.resolve(this.baseUploadDir, `${documentId}_${filename}`);
        if (!safeDiskPath.startsWith(this.baseUploadDir + path.sep)) {
            throw new Error("Invalid file path.");
        }
        fs.writeFileSync(safeDiskPath, buffer);
        return { blobUrl: null, blobPathname: null };
    }
    async getPdfBinary(doc) {
        const safeDiskPath = path.resolve(this.baseUploadDir, `${doc.id}_${doc.filename}`);
        if (safeDiskPath.startsWith(this.baseUploadDir + path.sep) && fs.existsSync(safeDiskPath)) {
            return {
                buffer: fs.readFileSync(safeDiskPath),
                contentType: "application/pdf",
            };
        }
        return null;
    }
    async deletePdfBinary(documentId, filename) {
        const safeDiskPath = path.resolve(this.baseUploadDir, `${documentId}_${filename}`);
        if (safeDiskPath.startsWith(this.baseUploadDir + path.sep) && fs.existsSync(safeDiskPath)) {
            fs.unlinkSync(safeDiskPath);
        }
    }
}
class UnconfiguredProductionStorage {
    missingMessage() {
        const missing = [];
        if (!process.env.DATABASE_URL?.trim())
            missing.push("DATABASE_URL");
        if (!hasBlobCredentials())
            missing.push("BLOB_STORE_ID (OIDC) or BLOB_READ_WRITE_TOKEN");
        return new StorageConfigError(`Production storage is not configured. Missing environment variable(s): ${missing.join(", ")}. Configure PostgreSQL and Vercel Blob in Vercel Project Settings.`);
    }
    async init() {
        throw this.missingMessage();
    }
    getInfo() {
        return {
            storage_mode: "production-durable",
            vector_store: "postgres-pgvector",
            object_storage: "vercel-blob",
            storage_label: "Missing DATABASE_URL / BLOB_STORE_ID",
        };
    }
    async listDocuments() { throw this.missingMessage(); }
    async getDocument() { throw this.missingMessage(); }
    async findIndexedBySha256() { throw this.missingMessage(); }
    async insertDocument() { throw this.missingMessage(); }
    async updateDocument() { throw this.missingMessage(); }
    async insertChunks() { throw this.missingMessage(); }
    async deleteDocument() { throw this.missingMessage(); }
    async searchSimilarChunks() { throw this.missingMessage(); }
    async getTotalChunksCount() { throw this.missingMessage(); }
    async getEmbeddingDimensions() { throw this.missingMessage(); }
    async recordConversation() { throw this.missingMessage(); }
    async getHistory() { throw this.missingMessage(); }
    async clearHistory() { throw this.missingMessage(); }
    async getQuestionsAnswered() { throw this.missingMessage(); }
    async savePdfBinary() { throw this.missingMessage(); }
    async getPdfBinary() { throw this.missingMessage(); }
    async deletePdfBinary() { throw this.missingMessage(); }
}
let cachedAdapter = null;
export function getStorageAdapter() {
    if (cachedAdapter)
        return cachedAdapter;
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
