-- DocuMind PostgreSQL + pgvector production schema
-- Automatically applied at runtime when DATABASE_URL is configured.

CREATE EXTENSION IF NOT EXISTS vector;

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

CREATE INDEX IF NOT EXISTS idx_documind_documents_sha256
  ON documind_documents (sha256);

CREATE INDEX IF NOT EXISTS idx_documind_documents_uploaded_at
  ON documind_documents (uploaded_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_documind_chunks_document_id
  ON documind_chunks (document_id);

CREATE INDEX IF NOT EXISTS idx_documind_chunks_embedding_cf_hnsw
  ON documind_chunks USING hnsw (embedding_cf vector_cosine_ops)
  WHERE embedding_cf IS NOT NULL;

CREATE TABLE IF NOT EXISTS documind_conversations (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documind_conversations_created_at
  ON documind_conversations (created_at ASC);

CREATE TABLE IF NOT EXISTS documind_meta (
  key TEXT PRIMARY KEY,
  value_int BIGINT NOT NULL DEFAULT 0
);

INSERT INTO documind_meta (key, value_int)
VALUES ('questions_answered', 0)
ON CONFLICT (key) DO NOTHING;
