# DocuMind — AI-Powered Document Intelligence & RAG Platform

DocuMind is a Retrieval-Augmented Generation (RAG) web application built as a **single-project full-stack Vercel deployment** powered by **React 19 + TypeScript + Vite**, **Node.js + Express** (running as a Vercel Serverless Function under `/api`), **PostgreSQL (`pgvector`)** for durable vector & metadata persistence, **Vercel Blob** for durable PDF object storage, and **Google Gemini** (`gemini-embedding-2` and `gemini-3.1-flash-lite`).

---

## 1. Production Architecture (Single-Project Vercel)

- **Frontend (Static CDN from `dist/`)**: React 19, TypeScript, Vite (`vite build` -> `dist/`), and Tailwind CSS v4.
- **API Backend (Vercel Serverless Function `api/index.ts`)**: Exports the Express application (`server/app.ts`) handling all `/api/*` endpoints via `vercel.json` rewrites.
- **PDF Processing**: `multer` (memory buffer upload) + `unpdf` (`extractText(..., { mergePages: false })`) for per-page text extraction, `%PDF` binary validation, and SHA-256 duplicate detection.
- **Chunking**: Splits extracted text per page into overlapping 500-word/token windows (`CHUNK_SIZE_TOKENS = 500`, `CHUNK_OVERLAP_TOKENS = 100`) preserving `{ chunk_id, document_id, filename, page_number, text, token_count }`.
- **Embeddings**: Google Gemini Embedding API (`gemini-embedding-2`, 3072 dimensions) via `@google/genai` on the server.
- **Durable Metadata & Vector Store (PostgreSQL + `pgvector`)**: `server/storage.ts` automatically creates `documind_documents`, `documind_chunks` (`vector` column), `documind_conversations`, and `documind_meta` (see `server/schema.sql`), and executes cosine similarity retrieval using native `pgvector` `<=>` distance (`ORDER BY embedding <=> $1::vector ASC LIMIT $N`).
- **Durable PDF Object Storage (`@vercel/blob`)**: Stores uploaded PDF files in Vercel Blob under `documind/<documentId>/<filename>` and deletes blobs automatically when documents are deleted or fail indexing.
- **Grounded Answer Generation & Comparison**: Google Gemini (`gemini-3.1-flash-lite`) used consistently for grounded document Q&A, pipeline inspection, and side-by-side Without-RAG vs. With-RAG evaluation.

*(Note: For local development outside Vercel when `DATABASE_URL` is not configured, `server.ts` serves Vite middleware alongside Express on port `3000` and falls back to local dev storage. On Vercel, `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are enforced.)*

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
Embedding Generation (Gemini gemini-embedding-2)
  │
  ▼
Durable Vector & Metadata Persistence (PostgreSQL + pgvector)
  │
  ▼
User Question ─▶ Query Embedding ─▶ pgvector Cosine Search (<=>) ─▶ Top-K Chunks
                                                                      │
                                                                      ▼
                                       Gemini (gemini-3.1-flash-lite) with <retrieved_context>
                                                                      │
                                                                      ▼
                                       Citation-Backed Answer + Source Filenames & Pages
```

---

## 3. Deploying to Vercel (Single Project)

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
   - DocuMind automatically enables `CREATE EXTENSION IF NOT EXISTS vector;` and bootstraps its tables on first request (`server/schema.sql`).
2. **Vercel Blob Store** (Vercel Dashboard → **Storage → Create Database → Blob**):
   - Connecting a Blob store automatically injects `BLOB_READ_WRITE_TOKEN`.
   - Optional: `BLOB_ACCESS` (`public` or `private`, defaults to `public`; automatically adapts to your Blob store access mode).
3. **Google Gemini API Key**:
   - `GEMINI_API_KEY` — **Required.** Server-side only; never exposed to the browser.
   - `GEMINI_MODEL` — Optional override (defaults to `gemini-3.1-flash-lite`).

> **Note on Vercel Function Payload Limits:** Vercel Serverless Functions enforce a 4.5 MB HTTP request body limit per upload request. Keep individual PDF uploads under 4.5 MB when uploading through Vercel Functions.

---

## 4. Environment Variables Reference

See `.env.example`:

- `GEMINI_API_KEY` — Server-side Google Gemini API key
- `GEMINI_MODEL` — Gemini chat model ID (`gemini-3.1-flash-lite`)
- `DATABASE_URL` — PostgreSQL connection string (`pgvector` enabled)
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token
- `BLOB_ACCESS` — Optional (`public` or `private`)
- `APP_URL` — Application base URL

---

## 5. Local Development & Verification Commands

```bash
# Install dependencies
npm install

# Run full-stack local development server (Express API + Vite middleware on port 3000)
npm run dev

# Type-check TypeScript
npm run lint

# Build production frontend bundle into dist/
npm run build

# Start standalone Node production server (serves dist/ + /api)
npm start
```

---

## 6. API Endpoints (Served Under `/api`)

- `GET /api/health` — Backend status, active vector & object storage adapters, embedding/chat models, and chunk counts
- `GET /api/documents` — List all uploaded/indexed documents
- `GET /api/documents/:documentId` — Get metadata and indexing status for one document
- `POST /api/documents/upload` — Multipart PDF upload (`files`), Vercel Blob upload, text extraction, chunking, embedding, and PostgreSQL indexing
- `DELETE /api/documents/:documentId` — Delete document metadata, cascade-delete vectors/chunks, and remove the PDF from Vercel Blob
- `POST /api/chat/ask` — Embed query, run cosine similarity Top-K retrieval, and generate grounded Gemini answer
- `POST /api/chat/compare` (alias `POST /api/rag/compare`) — Side-by-side Without-RAG vs. With-RAG comparison using the same Gemini model
- `POST /api/retrieval/inspect` — Return ranked chunks, similarity scores, `<retrieved_context>` payload, and grounded Gemini answer
- `GET /api/chat/history` & `DELETE /api/chat/history` — Fetch or clear conversation history
- `GET /api/dashboard/stats` — Live workspace metrics and recent activity
