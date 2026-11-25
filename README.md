# DocuMind — AI-Powered Document Intelligence & RAG Platform

DocuMind is a Retrieval-Augmented Generation (RAG) web application built as a **single-project full-stack Vercel deployment** powered by **React 19 + TypeScript + Vite**, **Node.js + Express** (running as a Vercel Serverless Function under `/api`), **PostgreSQL (`pgvector`)** for durable vector & metadata persistence, **Vercel Blob** for durable PDF object storage, and configurable dual-provider AI (**Google Gemini** or **Cloudflare Workers AI**).

---

## 1. Production Architecture (Single-Project Vercel)

- **Frontend (Static CDN from `dist/`)**: React 19, TypeScript, Vite (`vite build` -> `dist/`), and Tailwind CSS v4.
- **API Backend (Vercel Serverless Function `api/index.ts`)**: Exports the Express application (`server/app.ts`) handling all `/api/*` endpoints via `vercel.json` rewrites.
- **PDF Processing**: `multer` (memory buffer upload) + `unpdf` (`extractText(..., { mergePages: false })`) for per-page text extraction, `%PDF` binary validation, and SHA-256 duplicate detection.
- **Chunking**: Splits extracted text per page into overlapping 500-word/token windows (`CHUNK_SIZE_TOKENS = 500`, `CHUNK_OVERLAP_TOKENS = 100`) preserving `{ chunk_id, document_id, filename, page_number, text, token_count }`.
- **Dual-Provider AI (`server/aiClient.ts`)**:
  - `AI_PROVIDER=gemini` (default): `gemini-embedding-2` (3072 dimensions) + `gemini-3.1-flash-lite` via `@google/genai`.
  - `AI_PROVIDER=cloudflare`: `@cf/baai/bge-m3` (1024 dimensions) + `@cf/google/gemma-4-26b-a4b-it` via Cloudflare Workers AI OpenAI-compatible REST API (`server/cloudflareClient.ts`).
- **Durable Metadata & Vector Store (PostgreSQL + `pgvector`)**: `server/storage.ts` stores original chunk text alongside separate provider columns (`embedding` 3072-d for Gemini and nullable `embedding_cf vector(1024)` for Cloudflare) and executes cosine similarity retrieval using native `pgvector` `<=>` distance against the active provider's vector column only.
- **Durable PDF Object Storage (`@vercel/blob`)**: Stores uploaded PDF files in Vercel Blob under `documind/<documentId>/<filename>` and deletes blobs automatically when documents are deleted or fail indexing.

*(Note: For local development outside Vercel when `DATABASE_URL` is not configured, `server.ts` serves Vite middleware alongside Express on port `3000` and falls back to local dev storage. On Vercel, `DATABASE_URL` and Vercel Blob OIDC (`BLOB_STORE_ID`) or `BLOB_READ_WRITE_TOKEN` are enforced.)*

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
Embedding Generation (Active AI_PROVIDER: Gemini gemini-embedding-2 OR Cloudflare @cf/baai/bge-m3)
  │
  ▼
Durable Vector & Metadata Persistence (PostgreSQL + pgvector)
  │
  ▼
User Question ─▶ Active Provider Query Embedding ─▶ pgvector Cosine Search (<=>) ─▶ Top-K Chunks
                                                                                        │
                                                                                        ▼
                                                         Active Chat Model with <retrieved_context>
                                                                                        │
                                                                                        ▼
                                                         Citation-Backed Answer + Source Filenames & Pages
```

---

## 3. Safe Cloudflare Workers AI Migration & Rollback

Existing Gemini embeddings (`embedding` 3072-d) and original chunk text (`documind_chunks.text`) are preserved throughout the transition, and application startup **never** runs automatic `ALTER TABLE`, `UPDATE`, or index creation against existing tables.

1. **Explicit Idempotent SQL Migration** (run manually only after pre-checks):
   - Execute Sections A & B of `migrations/001_cloudflare_embeddings.sql` against the target database to add `embedding_model`, make `embedding` nullable (so new Cloudflare uploads do not require Gemini), and add `embedding_cf vector(1024)` + `embedding_cf_model`.
2. **Resumable Cloudflare Backfill** (defaults to `--dry-run`):
   - Preview pending chunks: `npm run reembed:cloudflare`
   - Execute backfill in small batches: `npm run reembed:cloudflare -- --execute --batch-size=5`
   - After backfill completes, run Section C of `migrations/001_cloudflare_embeddings.sql` to create the HNSW index on `embedding_cf`.
3. **Cutover & Verification**:
   - Set `AI_PROVIDER=cloudflare` (with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`) and verify `/api/health`.
4. **Full Rollback Support**:
   - Before switching `AI_PROVIDER` back to `gemini`, backfill any chunks uploaded while Cloudflare was active (`embedding IS NULL`):
     - Dry run: `npm run reembed:gemini`
     - Execute: `npm run reembed:gemini -- --execute --batch-size=5`
   - Then set `AI_PROVIDER=gemini` to restore Gemini retrieval and generation with zero lost documents.

### Preview & Production Isolation

- **Never point Vercel Preview deployments at the Production `DATABASE_URL` or Production Blob store.**
- Configure a separate Neon database branch (e.g., `preview`) and separate Preview Blob store in Vercel **Environment Variables → Preview**.
- Both `scripts/reembed-cloudflare.ts` and `scripts/reembed-gemini.ts` refuse to run when `VERCEL_ENV=preview` unless `--allow-preview` is explicitly passed.

---

## 4. Deploying to Vercel (Single Project)

DocuMind deploys as **one unified Vercel project** using `vercel.json` (no separate backend deployment and no Python runtime).

### Vercel Project Settings
- **Framework Preset**: `Vite`
- **Root Directory**: `./` (repository root)
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm install` (default)
- **Node.js Version**: `20.x` or `22.x`

### Required Vercel Storage & Environment Variables
In your Vercel Project Dashboard (**Storage** and **Settings → Environment Variables**), configure:

1. **Managed PostgreSQL with `pgvector`** (e.g., Neon Postgres via Vercel Marketplace, Supabase Postgres, or Vercel Postgres):
   - Set `DATABASE_URL` (connection string with SSL enabled, e.g. `postgresql://user:pass@host/db?sslmode=require`).
2. **Vercel Blob Store** (Vercel Dashboard → **Storage → Create Database → Blob**):
   - Connecting a private Blob store uses Vercel OIDC (`BLOB_STORE_ID` + OIDC token via `x-vercel-oidc-token` / `VERCEL_OIDC_TOKEN`), or falls back to `BLOB_READ_WRITE_TOKEN` if OIDC is unavailable.
   - Optional: `BLOB_ACCESS` (`private` or `public`, defaults to `private`).
3. **AI Provider Configuration**:
   - `AI_PROVIDER` — `"gemini"` (default) or `"cloudflare"`
   - **Gemini**: `GEMINI_API_KEY`, optional `GEMINI_MODEL` (defaults to `gemini-3.1-flash-lite`)
   - **Cloudflare Workers AI**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_CHAT_MODEL` (defaults to `@cf/google/gemma-4-26b-a4b-it`), optional `CLOUDFLARE_EMBEDDING_MODEL` (defaults to `@cf/baai/bge-m3`)

> **Note on Vercel Function Payload Limits:** Vercel Serverless Functions enforce a 4.5 MB HTTP request body limit per upload request. Keep individual PDF uploads under 4.5 MB when uploading through Vercel Functions.

---

## 5. Local Development & Verification Commands

```bash
# Install dependencies
npm install

# Run full-stack local development server (Express API + Vite middleware on port 3000)
npm run dev

# Type-check TypeScript
npm run lint

# Run AI dual-provider & storage isolation unit tests
npm run test:ai

# Build production frontend bundle into dist/
npm run build

# Start standalone Node production server (serves dist/ + /api)
npm start
```

---

## 6. API Endpoints (Served Under `/api`)

- `GET /api/health` — Backend status, active AI provider, active vector & object storage adapters, embedding/chat models, and chunk counts
- `GET /api/documents` — List all uploaded/indexed documents
- `GET /api/documents/:documentId` — Get metadata and indexing status for one document
- `POST /api/documents/upload` — Multipart PDF upload (`files`), Vercel Blob upload, text extraction, chunking, embedding, and PostgreSQL indexing
- `DELETE /api/documents/:documentId` — Delete document metadata, cascade-delete vectors/chunks, and remove the PDF from Vercel Blob
- `POST /api/chat/ask` — Embed query, run cosine similarity Top-K retrieval, and generate grounded AI answer
- `POST /api/chat/compare` (alias `POST /api/rag/compare`) — Side-by-side Without-RAG vs. With-RAG comparison using the same active LLM
- `POST /api/retrieval/inspect` — Return ranked chunks, similarity scores, `<retrieved_context>` payload, and grounded AI answer
- `GET /api/chat/history` & `DELETE /api/chat/history` — Fetch or clear conversation history
- `GET /api/dashboard/stats` — Live workspace metrics and recent activity
