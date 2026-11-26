-- ============================================================================
-- DocuMind Explicit Migration 001: Dual-Vector Support for Cloudflare Workers AI
-- Target Embedding Model: @cf/baai/bge-m3 (1,024 dimensions)
--
-- IMPORTANT:
--   - Do NOT run automatically at application startup.
--   - Execute explicitly in Neon SQL Editor ONLY after reviewing pre-checks.
--   - Existing 3,072-d Gemini vectors (`embedding`) and `text` are preserved.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SECTION A: PRE-MIGRATION READ-ONLY CHECKS (Run first and review output)
-- ----------------------------------------------------------------------------
-- SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- SELECT status, COUNT(*) FROM documind_documents GROUP BY status;
-- SELECT
--   COUNT(*) AS total_chunks,
--   COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS chunks_with_legacy_vec,
--   COUNT(*) FILTER (WHERE text IS NOT NULL AND length(trim(text)) > 0) AS chunks_with_text,
--   MIN(vector_dims(embedding)) AS min_dims,
--   MAX(vector_dims(embedding)) AS max_dims
-- FROM documind_chunks;

-- ----------------------------------------------------------------------------
-- SECTION B: IDEMPOTENT ADDITIVE SCHEMA MIGRATION (Preserves all existing rows)
-- ----------------------------------------------------------------------------
BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE documind_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Allow Cloudflare-only uploads to store chunks in embedding_cf without populating legacy `embedding`.
ALTER TABLE documind_chunks
  ALTER COLUMN embedding DROP NOT NULL;

ALTER TABLE documind_chunks
  ADD COLUMN IF NOT EXISTS embedding_cf vector(1024);

ALTER TABLE documind_chunks
  ADD COLUMN IF NOT EXISTS embedding_cf_model TEXT;

COMMIT;

-- ----------------------------------------------------------------------------
-- SECTION C: POST-BACKFILL VECTOR INDEX (Run AFTER reembed-cloudflare completes)
-- ----------------------------------------------------------------------------
-- CREATE INDEX IF NOT EXISTS idx_documind_chunks_embedding_cf_hnsw
--   ON documind_chunks USING hnsw (embedding_cf vector_cosine_ops)
--   WHERE embedding_cf IS NOT NULL;

-- ----------------------------------------------------------------------------
-- SECTION D: POST-MIGRATION VERIFICATION QUERIES (Read-only)
-- ----------------------------------------------------------------------------
-- SELECT column_name, data_type, udt_name, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'documind_chunks'
-- ORDER BY ordinal_position;
--
-- SELECT
--   COUNT(*) AS total_chunks,
--   COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS legacy_chunks,
--   COUNT(*) FILTER (WHERE embedding_cf IS NOT NULL) AS cloudflare_chunks,
--   COUNT(*) FILTER (WHERE embedding_cf IS NULL) AS pending_cloudflare_chunks
-- FROM documind_chunks;

-- ----------------------------------------------------------------------------
-- SECTION E: FAILURE RECOVERY NOTES
-- ----------------------------------------------------------------------------
-- 1. If Section B fails inside BEGIN...COMMIT, PostgreSQL automatically rolls back
--    the transaction and leaves `documind_chunks` unchanged.
-- 2. Re-indexing via `npm run reembed:cloudflare` is resumable and idempotent:
--    re-run with `--execute` to finish any remaining rows where `embedding_cf IS NULL`.
-- 3. Do NOT drop `embedding` or `embedding_cf` columns until Production verification
--    confirms 100% of active chunks have 1,024-d `@cf/baai/bge-m3` vectors.
