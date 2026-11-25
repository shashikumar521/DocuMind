# DocuMind — Cloudflare Workers AI Deployment & Preview Verification Guide

## 1. Git Branch & Deployment Strategy (`preview-db-test`)

Because this workspace archive does not include `.git` history, apply these changes onto a dedicated branch (`preview-db-test`) in your local clone of `https://github.com/shashikumar521/documind` — **never push directly to `main`** before Preview verification passes.

```bash
# In your local git clone of shashikumar521/documind:
git fetch origin
git checkout -b preview-db-test

# Extract documind-preview-db-test.zip over the repo working tree, then verify:
git status
npm install
npm run lint
npm run build
npm run test:ai

git add -A
git commit -m "Migrate DocuMind permanently to Cloudflare Workers AI"
git push -u origin preview-db-test
```

Pushing `preview-db-test` triggers an isolated **Vercel Preview** deployment.

---

## 2. Vercel Environment Variables (Preview & Production)

### Remove Legacy Variables
Remove unused legacy AI variables from **Vercel Project Settings → Environment Variables** once verified:
- `AI_PROVIDER`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`

### Required Variables
Keep existing database & Blob variables intact (do not overwrite Production `DATABASE_URL` with Preview):
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (Workers AI Read/Edit token)
- `CLOUDFLARE_CHAT_MODEL` (optional, defaults to `@cf/meta/llama-4-scout-17b-16e-instruct`)
- `CLOUDFLARE_EMBEDDING_MODEL` (optional, defaults to `@cf/baai/bge-m3`)
- `DATABASE_URL` (Production -> Neon main branch; Preview -> Neon Preview branch)
- `BLOB_ACCESS=private`
- `BLOB_STORE_ID` (Vercel OIDC authentication; optional `BLOB_READ_WRITE_TOKEN` fallback)

---

## 3. Database Migration & Safe Backfill (Preview First, Then Production)

1. Open the **Neon SQL Editor** for the target branch (**Preview** first).
2. Run Section A pre-checks in `migrations/001_cloudflare_embeddings.sql`.
3. Run Section B of `migrations/001_cloudflare_embeddings.sql` (idempotent; preserves existing `documind_documents` and `documind_chunks.text`).
4. Run a read-only dry run:
   ```bash
   DATABASE_URL="<preview-url>" npm run reembed:cloudflare -- --allow-preview
   ```
5. Execute the resumable 1,024-d (`@cf/baai/bge-m3`) backfill on **Preview**:
   ```bash
   TARGET_ENV=preview DATABASE_URL="<preview-url>" CLOUDFLARE_ACCOUNT_ID="<id>" CLOUDFLARE_API_TOKEN="<token>" \
     npm run reembed:cloudflare -- --execute --allow-preview --expected-host="<preview-host>" --expected-db=neondb --batch-size=5
   ```
6. Run Section C of `migrations/001_cloudflare_embeddings.sql` to create `idx_documind_chunks_embedding_cf_hnsw`.
7. Verify `/api/health` on the Preview URL:
   - `"status": "ok"`, `"app_status": "ok"`, `"database_healthy": true`
   - `"ai_provider": "cloudflare"`
   - `"chat_model": "@cf/meta/llama-4-scout-17b-16e-instruct"`
   - `"embedding_model": "@cf/baai/bge-m3"`
   - `"fallback_enabled": false`
   - `"embedding_dimensions": 1024`
8. Test PDF upload, AI Document Chat, RAG Comparison, and Pipeline Inspector on Preview.
9. Only after Preview passes 100%, run the same steps against Production with `--confirm-production` and `TARGET_ENV=production`, then merge `preview-db-test` → `main` via Pull Request.
