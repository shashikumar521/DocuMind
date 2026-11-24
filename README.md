# DocuMind — AI-Powered Document Question Answering with RAG

DocuMind is a Retrieval-Augmented Generation (RAG) web application running inside AI Studio on **Node.js + Express**, **React 19 + TypeScript + Vite**, and **Google Gemini**. Users can upload PDF documents, index their contents into persistent vector storage, ask natural-language questions grounded strictly in uploaded files, inspect retrieved context, and compare RAG vs. Without RAG responses side by side.

---

## 1. Architecture Overview (Active AI Studio Runtime)

- **Frontend**: React 19, TypeScript, Vite, and Tailwind CSS v4 (preserving the DocuMind design system across Light, Dark, and System themes).
- **Backend Server**: Node.js + Express (`server.ts`, `server/`) running on port `3000` with Vite middleware in development and static `dist/` serving in production.
- **PDF Processing**: `multer` (25 MB limit per file, up to 10 files per upload) + `unpdf` (`extractText(..., { mergePages: false })`) for per-page text extraction, `%PDF` binary validation, and SHA-256 duplicate prevention.
- **Chunking**: Splits extracted text per page into overlapping 500-word/token windows (`CHUNK_SIZE_TOKENS = 500`, `CHUNK_OVERLAP_TOKENS = 100`) preserving `{ chunk_id, document_id, filename, page_number, text, token_count }`.
- **Embeddings**: Google Gemini Embedding API (`gemini-embedding-2`) via `@google/genai`.
- **Persistent Vector Storage**: Local disk JSON store (`data/documind_store.json`, written atomically via temp-file rename) alongside uploaded PDF binaries in `uploads/`.
- **Semantic Retrieval**: Exact cosine similarity search across indexed chunk embeddings returning the Top-K matching chunks (default `5`, configurable to `3`, `5`, or `8` in Settings).
- **Answer Generation & Comparison**: Google Gemini (`gemini-4-hydrogen` via `@google/genai`) used consistently for grounded document Q&A, RAG pipeline inspection, and side-by-side Without-RAG vs. With-RAG evaluation.

---

## 2. RAG Workflow

```text
PDF Upload (.pdf, <= 25 MB, SHA-256 deduplication)
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
Persistent Disk Vector Store (data/documind_store.json)
  │
  ▼
User Question ─▶ Query Embedding ─▶ Cosine Similarity Search ─▶ Top-K Chunks
                                                                    │
                                                                    ▼
                                     Gemini (gemini-4-hydrogen) with <retrieved_context>
                                                                    │
                                                                    ▼
                                     Citation-Backed Answer + Source Filenames & Pages
```

---

## 3. Features

- **Document Upload & Management**: Drag-and-drop multi-PDF upload, binary and duplicate validation, live pipeline status stages (`Uploaded` → `Extracting Text` → `Chunking` → `Generating Embeddings` → `Indexing Vectors` → `Indexed Successfully`), and full deletion removing both the PDF binary and all stored chunks/vectors.
- **AI Document Chat**: Select active indexed PDFs, ask questions, view Gemini responses with inline citations (`[Filename.pdf, p. N]`), and expand retrieved passages with similarity scores.
- **Retrieval & Source References**: Inspect the exact ranked chunks, chunk IDs, cosine similarity scores, distance metrics, and the `<retrieved_context>` prompt payload sent to Gemini.
- **RAG vs. Without RAG Comparison**: Evaluates the same question using the same Gemini model (`gemini-4-hydrogen`) both without document context and with top-K retrieved passages.
- **Workspace Dashboard & Settings**: Live document, page, chunk, and Q&A counters, plus Light/Dark/System theme switching and Top-K depth controls.

---

## 4. Environment Variables

Configure via AI Studio **Secrets** (or `.env` for local Node.js runs; see `.env.example`):

- `GEMINI_API_KEY` — **Required.** Used server-side for Gemini embeddings (`gemini-embedding-2`) and Gemini chat/comparison (`gemini-4-hydrogen`).
- `GEMINI_MODEL` — Optional override for chat generation (defaults to `gemini-4-hydrogen`; retired model IDs automatically fall back to `gemini-4-hydrogen`).
- `APP_URL` — Automatically injected by AI Studio at runtime.

---

## 5. Installation & Runtime Commands

```bash
# Install Node.js dependencies
npm install

# Run full-stack development server (Express API + Vite SPA on port 3000)
npm run dev

# Type-check TypeScript
npm run lint

# Build production frontend bundle
npm run build

# Start production server
npm start
```

---

## 6. API Endpoints

- `GET /api/health` — Backend status, vector store type, embedding/chat model IDs, API key status, and indexed chunk count
- `GET /api/documents` — List all uploaded/indexed documents
- `GET /api/documents/:documentId` — Get metadata and status for one document
- `POST /api/documents/upload` — Multipart PDF upload (`files`), extraction, chunking, embedding, and persistent indexing
- `DELETE /api/documents/:documentId` — Delete document binary, metadata, and associated vector chunks
- `POST /api/chat/ask` — Embed query, run cosine similarity Top-K retrieval, and generate grounded Gemini answer
- `POST /api/chat/compare` (alias `POST /api/rag/compare`) — Live Without-RAG vs. With-RAG comparison using the same Gemini model
- `POST /api/retrieval/inspect` — Return ranked chunks, similarity scores, prompt payload, and grounded Gemini answer
- `GET /api/chat/history` & `DELETE /api/chat/history` — Fetch or clear conversation history
- `GET /api/dashboard/stats` — Live workspace metrics and recent activity
