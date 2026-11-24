# DocuMind — AI-Powered Document Question Answering with RAG

DocuMind is a Retrieval-Augmented Generation (RAG) application that enables users to upload PDF documents, index their contents into vector embeddings, ask natural-language questions, and receive citation-backed answers grounded strictly in the uploaded files using Google Gemini.

---

## 1. Features

- **Multi-PDF Upload & Validation**: Drag-and-drop multiple PDFs (up to 25 MB each), validate binary headers and page count, prevent duplicate SHA-256 indexing, and delete documents along with their stored vectors.
- **Live Processing Pipeline Tracking**: Real backend status progression (`Uploaded` -> `Extracting Text` -> `Chunking` -> `Generating Embeddings` -> `Indexing in ChromaDB` -> `Indexed Successfully` / `Failed`).
- **Semantic Chunking & Vector Indexing**: Extracts text per page, splits into ~500-token chunks with ~100-token overlap while preserving filename and page metadata.
- **AI Document Chat with Citations**: Select specific indexed PDFs, ask questions, and view Gemini answers with expandable source passages, page numbers, and cosine similarity scores.
- **RAG vs. Without RAG Comparison**: Side-by-side live evaluation sending the exact same query to Gemini without document context vs. with retrieved document chunks.
- **RAG Pipeline Inspector**: Inspect the top retrieved chunks, chunk IDs, cosine similarity scores, and the exact prompt payload sent to Gemini.
- **Live Workspace Dashboard**: Real-time counts of uploaded documents, processed pages, indexed chunks, answered questions, and recent conversations.
- **Light / Dark / System Theme**: Full dual-theme support and configurable Top-K retrieval depth (`3`, `5`, or `8` chunks).

---

## 2. Technologies Used

### Frontend
- **React 19 + TypeScript + Vite**
- **Tailwind CSS v4** (preserving the DocuMind Stitch design system)
- **Material Symbols Outlined**

### Python Standalone Backend (`backend/`)
- **Python 3.11+ / FastAPI / Uvicorn**
- **pypdf** for per-page PDF text extraction
- **Sentence Transformers (`all-MiniLM-L6-v2`)** for 384-dimensional dense embeddings
- **ChromaDB (`PersistentClient`)** for local persistent vector storage
- **Google Gemini (`google-genai`)** for grounded answer generation

### AI Studio / Node.js Runtime Server (`server.ts`, `server/`)
- **Express + tsx** serving the Vite SPA on port `3000`
- **unpdf** for per-page PDF text extraction
- **Google Gemini (`@google/genai`)**: `gemini-embedding-2` for embeddings and `gemini-4-hydrogen` for answer generation, with persistent disk storage (`data/documind_store.json`) or optional proxy forwarding to the standalone Python FastAPI service via `FASTAPI_BACKEND_URL`.

---

## 3. RAG Architecture

```
PDF Upload ─▶ Text Extraction (per page) ─▶ 500-Token Chunking (100-token overlap)
                                                        │
                                                        ▼
User Question ─▶ Query Embedding ─▶ Cosine Similarity Search ─▶ Top-K Chunks
                                                        │
                                                        ▼
                                     Gemini Prompt (<retrieved_context> + Question)
                                                        │
                                                        ▼
                                      Citation-Backed Answer + Source Passages
```

---

## 4. Installation

### Option A: AI Studio / Full-Stack Node.js + Vite Runtime
1. Install Node.js dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables (copy `.env.example` to `.env` or set via AI Studio **Settings > Secrets**):
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

### Option B: Standalone Python FastAPI + ChromaDB + Sentence Transformers Backend
1. Create a Python virtual environment and install dependencies:
   ```bash
   cd backend
   python3 -m venv .venv
   source .venv/bin/activate   # On Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. Set `GEMINI_API_KEY` in `.env` at the project root or inside `backend/.env`.

---

## 5. Environment Variable Configuration

See `.env.example`:
- `GEMINI_API_KEY` — Required for Gemini API calls (and Gemini embeddings when using the Node runtime).
- `FASTAPI_BACKEND_URL` — Optional. Set to `http://127.0.0.1:8000` when running the Express frontend server against the standalone Python FastAPI + ChromaDB backend.
- `CHROMA_PERSIST_DIR` — Persistent directory for ChromaDB (`./chroma_db` by default).
- `EMBEDDING_MODEL` — Sentence Transformer model (`all-MiniLM-L6-v2`).
- `GEMINI_MODEL` — Gemini model ID (`gemini-4-hydrogen`).
- `MAX_UPLOAD_MB` — Maximum PDF upload size in MB (`25`).

---

## 6. How to Run Frontend and Backend

### Running in AI Studio / Full-Stack Mode (Single Command)
```bash
npm run dev
```
This starts the Express + Vite server on `http://localhost:3000`.

### Running with the Python FastAPI + ChromaDB Backend Locally
1. Start the Python FastAPI backend on port `8000`:
   ```bash
   cd backend
   uvicorn app.main:app --reload --port 8000
   ```
2. Start the frontend server pointing `/api/*` to FastAPI:
   ```bash
   FASTAPI_BACKEND_URL=http://127.0.0.1:8000 npm run dev
   ```
3. Open `http://localhost:3000` in your browser.

---

## 7. How to Upload PDF Documents

1. Navigate to **My Documents** from the left sidebar.
2. Drag and drop one or more `.pdf` files (or click **Browse PDF Files**).
3. Observe live status transitions until **Indexed Successfully** appears alongside the extracted page count and generated chunk count.
4. Click **Delete** on any document card to remove both the file and its indexed vectors.

---

## 8. How to Test Document Questions

1. Open **AI Chat** from the sidebar (or click **Preview & Chat** on an indexed document).
2. Select one or more indexed PDFs in the **Active Documents** panel.
3. Ask a question specific to your PDFs (or pick a suggested prompt).
4. Review the grounded Gemini response, expand any **Source N** citation to read the exact retrieved passage and page number, or open **Inspect Full RAG Pipeline** to view similarity scores and the prompt payload.

---

## 9. RAG vs. Without RAG Comparison

1. Open **RAG Comparison** from the sidebar.
2. Enter a question about specific details inside your uploaded PDFs (e.g., policy retention timelines, research metrics, or contract terms).
3. Click **Run Comparison**:
   - **Without RAG** sends the raw question directly to Gemini with no retrieval context.
   - **With RAG** retrieves the top-K matching chunks from your indexed PDFs and grounds Gemini's response with verifiable page citations.

---

## 10. Example Output & Verification

- **API Endpoints**:
  - `GET /api/health` — Backend status and indexed chunk count
  - `POST /api/documents/upload` — Multipart PDF upload, extraction, chunking, embedding, indexing
  - `GET /api/documents` — List all documents and statuses
  - `GET /api/documents/{document_id}` — Single document status
  - `DELETE /api/documents/{document_id}` — Delete document and its vectors
  - `POST /api/chat/ask` — Semantic search + grounded Gemini Q&A
  - `POST /api/chat/compare` — Live Without RAG vs. With RAG comparison
  - `POST /api/retrieval/inspect` — Full RAG pipeline inspection (top-K chunks, prompt, answer)
  - `GET /api/dashboard/stats` — Live workspace statistics
  - `GET /api/chat/history` & `DELETE /api/chat/history` — Conversation history management
