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
--   COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS chunks_with_gemini_vec,
--   COUNT(*) FILTER (WHERE text IS NOT NULL AND length(trim(text)) > 0) AS chunks_with_text,
--   MIN(vector_dims(embedding)) AS min_dims,
--   MAX(vector_dims(embedding)) AS max_dims
-- FROM documind_chunks;

-- ----------------------------------------------------------------------------
-- SECTION B: IDEMPOTENT ADDITIVE SCHEMA MIGRATION (Preserves all Gemini data)
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE documind_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

UPDATE documind_chunks
SET embedding_model = 'gemini-embedding-2'
WHERE embedding IS NOT NULL
  AND embedding_model IS NULL;

-- Allow new Cloudflare-only uploads to store chunks without requiring Gemini calls.
-- All pre-existing Gemini vectors in `embedding` remain untouched for rollback.
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
--   COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS gemini_chunks,
--   COUNT(*) FILTER (WHERE embedding_cf IS NOT NULL) AS cloudflare_chunks,
--   COUNT(*) FILTER (WHERE embedding_cf IS NULL) AS pending_cloudflare_chunks
-- FROM documind_chunks;

-- ----------------------------------------------------------------------------
-- SECTION E: FAILURE RECOVERY / ROLLBACK NOTES
-- ----------------------------------------------------------------------------
-- 1. If Section B fails inside BEGIN...COMMIT, PostgreSQL automatically rolls back
--    the transaction and leaves `documind_chunks` unchanged.
-- 2. To roll back application traffic at any point:
--    a) If new documents were uploaded under AI_PROVIDER=cloudflare, run:
--       npx tsx scripts/reembed-gemini.ts --execute
--       so every chunk has `embedding` populated.
--    b) Set AI_PROVIDER=gemini in Vercel Environment Variables and redeploy.
-- 3. Do NOT drop `embedding` or `embedding_cf` until the target provider has been
--    verified in Production.
