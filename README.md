# DocuMind — AI-Powered Document Intelligence & RAG Platform

DocuMind is a Retrieval-Augmented Generation (RAG) web application built as a **single-project full-stack Vercel deployment** powered by **React 19 + TypeScript + Vite**, **Node.js + Express** (running as a Vercel Serverless Function under `/api`), **PostgreSQL (`pgvector`)** for durable vector & metadata persistence, **Vercel Blob** for durable PDF object storage, and **Cloudflare Workers AI** for all embeddings and chat generation.

---

## 1. Production Architecture (Single-Project Vercel)

- **Frontend (Static CDN from `dist/`)**: React 19, TypeScript, Vite (`vite build` -> `dist/`), and Tailwind CSS v4.
- **API Backend (Vercel Serverless Function `api/index.ts`)**: Exports the Express application (`server/app.ts`) handling all `/api/*` endpoints via `vercel.json` rewrites.
- **PDF Processing**: `multer` (memory buffer upload) + `unpdf` (`extractText(..., { mergePages: false })`) for per-page text extraction, `%PDF` binary validation, and SHA-256 duplicate detection.
- **Chunking**: Splits extracted text per page into overlapping 500-word/token windows (`CHUNK_SIZE_TOKENS = 500`, `CHUNK_OVERLAP_TOKENS = 100`) preserving `{ chunk_id, document_id, filename, page_number, text, token_count }`.
- **Cloudflare Workers AI (`server/cloudflareClient.ts` + `server/aiClient.ts`)**:
  - **Chat Model**: `@cf/meta/llama-4-scout-17b-16e-instruct` via `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`
  - **Embedding Model**: `@cf/baai/bge-m3` (1,024 dimensions) via `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/embeddings`
- **Durable Metadata & Vector Store (PostgreSQL + `pgvector`)**: `server/storage.ts` stores document metadata, extracted chunk text, and 1,024-dimensional Cloudflare embeddings in `embedding_cf vector(1024)` (`embedding_cf_model = '@cf/baai/bge-m3'`). Cosine similarity retrieval runs native `pgvector` `<=>` distance strictly against `embedding_cf` rows with matching 1,024-d dimensions.
- **Durable PDF Object Storage (`@vercel/blob`)**: Stores uploaded PDF files in Vercel Blob under `documind/<documentId>/<filename>` via Vercel OIDC (`BLOB_STORE_ID` + `BLOB_ACCESS=private`) and removes blobs when documents are deleted or fail indexing.

*(Note: For local development outside Vercel when `DATABASE_URL` is not configured, `server.ts` serves Vite middleware alongside Express on port `3000` and uses local `.local-data` storage. On Vercel, `DATABASE_URL` and Vercel Blob OIDC (`BLOB_STORE_ID`) or `BLOB_READ_WRITE_TOKEN` are enforced.)*

---

## 2. RAG Workflow

```text
PDF Upload (.pdf, SHA-256 deduplication)
  │
  ├──▶ Durable PDF Binary Storage (Vercel Blob via @vercel/blob)
  │
  ▼
Per-Page Text Extraction (unpdf)
  │
  ▼
Chunking (500-token window, 100-token overlap + filename & page metadata)
  │
  ▼
Embedding Generation (Cloudflare Workers AI @cf/baai/bge-m3, 1024 dimensions)
  │
  ▼
Durable Vector & Metadata Persistence (PostgreSQL + pgvector embedding_cf)
  │
  ▼
User Question ─▶ Cloudflare @cf/baai/bge-m3 Query Embedding ─▶ pgvector Cosine Search (<=>) ─▶ Top-K Chunks
                                                                                                  │
                                                                                                  ▼
                                                   Cloudflare @cf/meta/llama-4-scout-17b-16e-instruct
                                                                                                  │
                                                                                                  ▼
                                                   Citation-Backed Answer + Source Filenames & Pages
```

---

## 3. Safe 1,024-Dimension Vector Migration & Re-indexing

Existing documents, uploaded Vercel Blob PDFs, and chunk text (`documind_chunks.text`) are preserved during schema migration. Application startup **never** runs automatic `ALTER TABLE`, `UPDATE`, or HNSW index creation against existing tables.

1. **Explicit Idempotent SQL Migration** (run manually in Neon SQL Editor after reviewing Section A pre-checks):
   - Execute Section B of `migrations/001_cloudflare_embeddings.sql` against the target database branch to make legacy `embedding` nullable and ensure `embedding_cf vector(1024)` + `embedding_cf_model` exist.
2. **Resumable, Idempotent Cloudflare Re-indexing** (defaults to safe read-only `--dry-run`):
   - Inspect target database and pending chunks/documents: `npm run reembed:cloudflare`
   - Preview branch backfill (with explicit target host, database name, and isolation guards):
     ```bash
     TARGET_ENV=preview npm run reembed:cloudflare -- --execute --allow-preview --expected-host=<preview-host> --expected-db=neondb --batch-size=5
     ```
   - Production backfill (after Preview verification, with explicit confirmation):
     ```bash
     TARGET_ENV=production npm run reembed:cloudflare -- --execute --confirm-production --expected-host=<prod-host> --expected-db=neondb --batch-size=5
     ```
   - `scripts/reembed-cloudflare.ts` re-embeds chunks missing `embedding_cf` from stored `documind_chunks.text`, and can also re-index existing `documind_documents` that have zero stored chunks by reading their stored PDF binary (`blob_url` / local upload), extracting text, generating 1024-d `@cf/baai/bge-m3` vectors, storing chunks in a transaction, and marking the document `"Indexed Successfully"` only after vectors commit.
3. **Post-Backfill Vector Index**:
   - After `missing_cloudflare_chunks = 0`, execute Section C of `migrations/001_cloudflare_embeddings.sql` to create `idx_documind_chunks_embedding_cf_hnsw`.

### Preview & Production Isolation

- **Never point Vercel Preview deployments at the Production `DATABASE_URL` or Production Blob store.**
- Configure an isolated Neon Preview branch and separate Preview Blob store in Vercel **Environment Variables → Preview**.
- Both `PostgresBlobStorage.init()` (`server/storage.ts`) and `scripts/reembed-cloudflare.ts` refuse Preview operations if the target database matches Production identifiers.

---

## 4. Deploying to Vercel (Single Project)

DocuMind deploys as **one unified Vercel project** using `vercel.json`.

### Vercel Project Settings
- **Framework Preset**: `Vite`
- **Root Directory**: `./` (repository root)
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm install` (default)
- **Node.js Version**: `20.x` or `22.x`

### Required Vercel Storage & Environment Variables
In Vercel **Settings → Environment Variables**, configure:

1. **Cloudflare Workers AI**:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN` (scoped with Workers AI Read/Edit permissions)
   - Optional: `CLOUDFLARE_CHAT_MODEL` (defaults to `@cf/meta/llama-4-scout-17b-16e-instruct`)
   - Optional: `CLOUDFLARE_EMBEDDING_MODEL` (defaults to `@cf/baai/bge-m3`)
2. **Managed PostgreSQL with `pgvector`** (e.g., Neon Postgres):
   - `DATABASE_URL` (separate values for Production vs. Preview branches)
3. **Vercel Blob Store**:
   - `BLOB_STORE_ID` + `BLOB_ACCESS=private` (uses Vercel OIDC tokens automatically; optional `BLOB_READ_WRITE_TOKEN` fallback only when OIDC is unavailable).

> **Note on Vercel Function Payload Limits:** Vercel Serverless Functions enforce a 4.5 MB HTTP request body limit per upload request. Keep individual PDF uploads under 4.5 MB when uploading through Vercel Functions.

---

## 5. Local Development & Verification Commands

```bash
# Install dependencies
npm install

# Run full-stack local development server (Express API + Vite middleware on port 3000)
npm run dev

# Type-check TypeScript (frontend, server, and Vercel API entry point)
npm run lint

# Run Cloudflare Workers AI & database isolation tests
npm run test:ai

# Build production frontend bundle into dist/
npm run build

# Start standalone Node production server (serves dist/ + /api)
npm start
```

---

## 6. API Endpoints (Served Under `/api`)

- `GET /api/health` — Application & database status, Cloudflare Workers AI configuration/connectivity, active models (`@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/baai/bge-m3`), `fallback_enabled: false`, and chunk counts
- `GET /api/documents` — List all uploaded/indexed documents
- `GET /api/documents/:documentId` — Get metadata and indexing status for one document
- `GET /api/documents/:documentId/download` — Stream stored PDF securely from private Vercel Blob via OIDC
- `POST /api/documents/upload` — Multipart PDF upload (`files`), Blob storage, text extraction, chunking, `@cf/baai/bge-m3` embedding, and PostgreSQL indexing
- `DELETE /api/documents/:documentId` — Delete document metadata, cascade-delete vectors/chunks, and remove the PDF from Vercel Blob
- `POST /api/chat/ask` — Embed query with `@cf/baai/bge-m3`, run cosine similarity Top-K retrieval (`top_k=3` default), and generate a citation-backed answer via `@cf/meta/llama-4-scout-17b-16e-instruct`
- `POST /api/chat/compare` (alias `POST /api/rag/compare`) — Side-by-side Without-RAG vs. With-RAG comparison using `@cf/meta/llama-4-scout-17b-16e-instruct`
- `POST /api/retrieval/inspect` — Return ranked chunks, similarity scores, `<retrieved_context>` payload, and grounded answer
- `GET /api/chat/history` & `DELETE /api/chat/history` — Fetch or clear conversation history
- `GET /api/dashboard/stats` — Live workspace metrics and recent activity
