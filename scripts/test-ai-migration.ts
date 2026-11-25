import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApiApp } from "../server/app.js";
import {
  DualProviderFailureError,
  embedQuery,
  formatAiError,
  GEMINI_EMBEDDING_DIMENSIONS,
  generateEmbeddings,
  generateRagAnswer,
  generateWithoutRagAnswer,
  generateWithoutRagAnswerWithMeta,
  getActiveAiProvider,
  getActiveChatModel,
  getActiveEmbeddingModel,
  getExpectedEmbeddingDimensions,
} from "../server/aiClient.js";
import {
  clearGeminiCachesForTest,
  setGeminiFetchForTest,
} from "../server/geminiClient.js";
import {
  clearCloudflareCachesForTest,
  CLOUDFLARE_CHAT_MAX_TOKENS,
  CLOUDFLARE_CHAT_MODEL,
  CLOUDFLARE_EMBEDDING_MODEL,
  formatCloudflareError,
  generateCloudflareEmbeddings,
  generateCloudflareRagAnswer,
  generateCloudflareWithoutRagAnswer,
  setCloudflareFetchForTest,
} from "../server/cloudflareClient.js";
import type { Pool } from "pg";
import {
  assertPreviewDatabaseIsolation,
  ChunkMigrationStats,
  DatabaseIdentity,
  LocalDevJsonStorage,
  PostgresBlobStorage,
  sanitizeDatabaseErrorMessage,
  StorageConfigError,
} from "../server/storage.js";
import {
  ReembedCloudflareStorage,
  runReembedCloudflare,
} from "./reembed-cloudflare.js";
import {
  ReembedGeminiStorage,
  runReembedGemini,
} from "./reembed-gemini.js";

function unitVec(dims: number, hotIndex: number): number[] {
  const v = new Array<number>(dims).fill(0);
  v[hotIndex] = 1;
  return v;
}

async function runSimulatedTests() {
  const prevEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_CHAT_MODEL: process.env.CLOUDFLARE_CHAT_MODEL,
    CLOUDFLARE_EMBEDDING_MODEL: process.env.CLOUDFLARE_EMBEDDING_MODEL,
  };

  try {
    // 1. Default provider must be Gemini
    delete process.env.AI_PROVIDER;
    assert.equal(getActiveAiProvider(), "gemini");
    assert.equal(getActiveChatModel(), "gemini-3.1-flash-lite");
    assert.equal(getActiveEmbeddingModel(), "gemini-embedding-2");
    assert.equal(getExpectedEmbeddingDimensions(), GEMINI_EMBEDDING_DIMENSIONS);

    // 2. Switching AI_PROVIDER=cloudflare selects verified Cloudflare models & 1024 dims
    process.env.AI_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    delete process.env.CLOUDFLARE_CHAT_MODEL;
    delete process.env.CLOUDFLARE_EMBEDDING_MODEL;

    assert.equal(getActiveAiProvider(), "cloudflare");
    assert.equal(getActiveChatModel(), CLOUDFLARE_CHAT_MODEL);
    assert.equal(getActiveEmbeddingModel(), CLOUDFLARE_EMBEDDING_MODEL);
    assert.equal(getExpectedEmbeddingDimensions(), 1024);

    // 3. Simulated Cloudflare embeddings + index sorting + deduplication
    clearCloudflareCachesForTest();
    let embedCalls = 0;
    setCloudflareFetchForTest(async (input, init) => {
      const url = String(input);
      assert.ok(url.endsWith("/ai/v1/embeddings"));
      embedCalls += 1;
      const body = JSON.parse(String(init?.body)) as { model: string; input: string | string[] };
      assert.equal(body.model, "@cf/baai/bge-m3");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      // Return reversed order with index to verify deterministic sorting
      const data = inputs
        .map((_, idx) => ({
          index: idx,
          embedding: unitVec(1024, idx),
        }))
        .reverse();
      return new Response(JSON.stringify({ object: "list", data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const vectors = await generateCloudflareEmbeddings(["alpha", "beta", "alpha"]);
    assert.equal(embedCalls, 1, "Duplicate chunk text should be embedded once");
    assert.equal(vectors.length, 3);
    assert.equal(vectors[0].length, 1024);
    assert.equal(vectors[0][0], 1);
    assert.equal(vectors[1][1], 1);
    assert.deepEqual(vectors[0], vectors[2]);

    // 4. Dimension mismatch guard
    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    await assert.rejects(
      () => generateEmbeddings(["wrong-dims"], "cloudflare"),
      /dimension mismatch/i
    );

    // 5. Simulated Cloudflare RAG & Without-RAG chat completions + max_tokens check
    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        max_tokens: number;
        temperature: number;
        stream: boolean;
        messages: Array<{ role: string; content: string }>;
      };
      if (url.endsWith("/ai/v1/embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: unitVec(1024, 0) }] }),
          { status: 200 }
        );
      }
      assert.ok(url.endsWith("/ai/v1/chat/completions"));
      assert.equal(body.model, "@cf/google/gemma-4-26b-a4b-it");
      assert.equal(body.max_tokens, CLOUDFLARE_CHAT_MAX_TOKENS);
      assert.equal(body.stream, false);
      assert.ok(body.temperature <= 0.2);
      assert.equal(body.messages[0].role, "system");
      const userPrompt = body.messages[1].content;
      const isRag = userPrompt.includes("<retrieved_context>");
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: isRag
                  ? "Grounded answer with citation [Spec.pdf, p. 2]."
                  : "General ungrounded answer.",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const queryVec = await embedQuery("What is the retention policy?", "cloudflare");
    assert.equal(queryVec.length, 1024);

    const ragRes = await generateRagAnswer(
      "What is the retention policy?",
      [
        {
          rank: 1,
          chunk_id: "doc1_p2_c0",
          document_id: "doc1",
          filename: "Spec.pdf",
          page_number: 2,
          text: "Retention period is 30 days.",
          similarity: 0.94,
          distance: 0.06,
        },
      ],
      { provider: "cloudflare" }
    );
    assert.ok(ragRes.answer.includes("[Spec.pdf, p. 2]"));
    const noRagRes = await generateWithoutRagAnswer("What is the retention policy?", {
      provider: "cloudflare",
    });
    assert.equal(noRagRes, "General ungrounded answer.");

    // 6. Error classification: Auth 401/403, Model 404, Retryable 429, Daily Neuron exhaustion 429
    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }),
        { status: 401 }
      );
    });
    await assert.rejects(
      () => generateCloudflareWithoutRagAnswer("auth test"),
      (err) => formatCloudflareError(err).status === 403
    );

    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ errors: [{ code: 7000, message: "No such model" }] }),
        { status: 404 }
      );
    });
    await assert.rejects(
      () => generateCloudflareWithoutRagAnswer("model test"),
      (err) => formatCloudflareError(err).status === 400
    );

    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ errors: [{ code: 5028, message: "Model has been deprecated" }] }),
        { status: 410 }
      );
    });
    await assert.rejects(
      () => generateCloudflareWithoutRagAnswer("deprecated model test"),
      (err) => formatCloudflareError(err).status === 410 && /unavailable/i.test(formatCloudflareError(err).message)
    );

    clearCloudflareCachesForTest();
    let rateAttempts = 0;
    setCloudflareFetchForTest(async () => {
      rateAttempts += 1;
      if (rateAttempts === 1) {
        return new Response(
          JSON.stringify({ errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] }),
          { status: 429, headers: { "retry-after-ms": "50" } }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Recovered after retry." } }] }),
        { status: 200 }
      );
    });
    const recovered = await generateCloudflareRagAnswer(
      "retry test",
      [
        {
          rank: 1,
          chunk_id: "c1",
          document_id: "d1",
          filename: "A.pdf",
          page_number: 1,
          text: "Sample",
          similarity: 0.9,
          distance: 0.1,
        },
      ]
    );
    assert.equal(rateAttempts, 2);
    assert.equal(recovered.answer, "Recovered after retry.");

    clearCloudflareCachesForTest();
    let quotaAttempts = 0;
    setCloudflareFetchForTest(async () => {
      quotaAttempts += 1;
      return new Response(
        JSON.stringify({
          errors: [{ code: 4006, message: "Daily free allocation of 10000 neurons exceeded" }],
        }),
        { status: 429 }
      );
    });
    await assert.rejects(
      () => generateCloudflareWithoutRagAnswer("quota test"),
      (err) => formatCloudflareError(err).status === 429
    );
    assert.equal(quotaAttempts, 1, "Daily neuron quota exhaustion must fail fast without retrying");

    // 7. Dual-vector isolation & rollback simulation in LocalDevJsonStorage
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "documind-test-"));
    try {
      const store = new LocalDevJsonStorage(path.join(tmpDir, "store.json"));
      await store.insertDocument({
        id: "doc-1",
        filename: "Legacy.pdf",
        size_bytes: 1024,
        pages: 1,
        chunks_count: 1,
        status: "Indexed Successfully",
        progress: 100,
        error_message: null,
        sha256: "abc123",
        uploaded_at: new Date().toISOString(),
      });
      // Legacy chunk has Gemini 3072d AND backfilled Cloudflare 1024d
      await store.insertChunks([
        {
          chunk_id: "doc-1_p1_c0",
          document_id: "doc-1",
          filename: "Legacy.pdf",
          page_number: 1,
          text: "Legacy Gemini chunk text",
          token_count: 4,
          embedding: unitVec(3072, 0),
          embedding_model: "gemini-embedding-2",
          embedding_cf: unitVec(1024, 0),
          embedding_cf_model: "@cf/baai/bge-m3",
        },
      ]);
      // New doc uploaded under Cloudflare has ONLY 1024d embedding_cf
      await store.insertDocument({
        id: "doc-2",
        filename: "CloudflareNew.pdf",
        size_bytes: 2048,
        pages: 1,
        chunks_count: 1,
        status: "Indexed Successfully",
        progress: 100,
        error_message: null,
        sha256: "def456",
        uploaded_at: new Date().toISOString(),
      });
      await store.insertChunks([
        {
          chunk_id: "doc-2_p1_c0",
          document_id: "doc-2",
          filename: "CloudflareNew.pdf",
          page_number: 1,
          text: "New Cloudflare-only chunk text",
          token_count: 5,
          embedding: null,
          embedding_model: null,
          embedding_cf: unitVec(1024, 0),
          embedding_cf_model: "@cf/baai/bge-m3",
        },
      ]);

      const cfHits = await store.searchSimilarChunks(unitVec(1024, 0), 5, undefined, {
        provider: "cloudflare",
        embeddingModel: "@cf/baai/bge-m3",
      });
      assert.equal(cfHits.length, 2, "Cloudflare search returns both legacy-backfilled and new chunks");

      const geminiRollbackHits = await store.searchSimilarChunks(unitVec(3072, 0), 5, undefined, {
        provider: "gemini",
        embeddingModel: "gemini-embedding-2",
      });
      assert.equal(
        geminiRollbackHits.length,
        1,
        "Gemini rollback safely ignores NULL embedding rows instead of mixing dimensions"
      );
      assert.equal(geminiRollbackHits[0].chunk_id, "doc-1_p1_c0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log("PASS: All simulated Cloudflare & dual-provider migration tests passed (7/7).");
  } finally {
    setCloudflareFetchForTest(null);
    clearCloudflareCachesForTest();
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

interface TestChunkRow {
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  token_count: number;
  embedding: string | null;
  embedding_model: string | null;
  embedding_cf: string | null;
  embedding_cf_model: string | null;
}

function createInMemoryPostgresTestPool(options: {
  databaseName: string;
  serverVersion?: string;
  initialChunks?: TestChunkRow[];
}) {
  const rows: TestChunkRow[] = (options.initialChunks ?? []).map((r) => ({ ...r }));
  let closed = false;

  const runQuery = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (
      normalized === "BEGIN" ||
      normalized === "COMMIT" ||
      normalized === "ROLLBACK" ||
      normalized.startsWith("CREATE EXTENSION") ||
      normalized.startsWith("CREATE TABLE") ||
      normalized.startsWith("CREATE INDEX") ||
      normalized.startsWith("INSERT INTO documind_meta")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes("SELECT current_database()")) {
      return {
        rows: [
          {
            current_database: options.databaseName,
            server_version: options.serverVersion ?? "16.4 (Test)",
          },
        ],
        rowCount: 1,
      };
    }

    if (normalized.includes("FROM information_schema.columns")) {
      return {
        rows: [
          { column_name: "chunk_id", is_nullable: "NO" },
          { column_name: "document_id", is_nullable: "NO" },
          { column_name: "filename", is_nullable: "NO" },
          { column_name: "page_number", is_nullable: "NO" },
          { column_name: "text", is_nullable: "NO" },
          { column_name: "token_count", is_nullable: "NO" },
          { column_name: "embedding", is_nullable: "YES" },
          { column_name: "embedding_model", is_nullable: "YES" },
          { column_name: "embedding_cf", is_nullable: "YES" },
          { column_name: "embedding_cf_model", is_nullable: "YES" },
        ],
        rowCount: 10,
      };
    }

    if (normalized.includes("AS missing_gemini_chunks FROM documind_chunks")) {
      const total = rows.length;
      const gemini = rows.filter((r) => r.embedding !== null).length;
      const cf = rows.filter((r) => r.embedding_cf !== null).length;
      const missingCf = rows.filter((r) => r.embedding_cf === null).length;
      const missingGemini = rows.filter((r) => r.embedding === null && r.embedding_cf !== null).length;
      return {
        rows: [
          {
            total_chunks: total,
            gemini_chunks: gemini,
            cloudflare_chunks: cf,
            missing_cloudflare_chunks: missingCf,
            missing_gemini_chunks: missingGemini,
          },
        ],
        rowCount: 1,
      };
    }

    if (normalized.includes("WHERE embedding_cf IS NULL ORDER BY chunk_id ASC")) {
      const limit = Number(params[0] ?? 5);
      const pending = rows
        .filter((r) => r.embedding_cf === null)
        .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id))
        .slice(0, limit)
        .map((r) => ({ chunk_id: r.chunk_id, text: r.text }));
      return { rows: pending, rowCount: pending.length };
    }

    if (normalized.includes("SET embedding_cf = $1")) {
      const [vec, model, chunkId] = params as [string, string, string];
      const target = rows.find((r) => r.chunk_id === chunkId && r.embedding_cf === null);
      if (!target) return { rows: [], rowCount: 0 };
      target.embedding_cf = vec;
      target.embedding_cf_model = model;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("WHERE embedding IS NULL ORDER BY chunk_id ASC")) {
      const limit = Number(params[0] ?? 5);
      const pending = rows
        .filter((r) => r.embedding === null)
        .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id))
        .slice(0, limit)
        .map((r) => ({ chunk_id: r.chunk_id, text: r.text }));
      return { rows: pending, rowCount: pending.length };
    }

    if (normalized.includes("SET embedding = $1")) {
      const [vec, modelOrId, maybeId] = params as [string, string, string?];
      const chunkId = maybeId ?? modelOrId;
      const model = maybeId ? modelOrId : null;
      const target = rows.find((r) => r.chunk_id === chunkId && r.embedding === null);
      if (!target) return { rows: [], rowCount: 0 };
      target.embedding = vec;
      if (model !== null) target.embedding_model = model;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected test SQL query: ${normalized}`);
  };

  const pool = {
    query: runQuery,
    connect: async () => ({
      query: runQuery,
      release: () => {},
    }),
    end: async () => {
      closed = true;
    },
  };

  return {
    pool: pool as unknown as Pool,
    rows,
    isClosed: () => closed,
  };
}

function createMockBackfillStorage(options: {
  identity: DatabaseIdentity;
  initialChunks?: Array<{
    chunk_id: string;
    text: string;
    hasGemini: boolean;
    hasCf: boolean;
  }>;
}): {
  storage: ReembedCloudflareStorage & ReembedGeminiStorage;
  getWriteCount: () => number;
  chunks: Array<{ chunk_id: string; text: string; hasGemini: boolean; hasCf: boolean }>;
} {
  let writeCount = 0;
  const chunks = (options.initialChunks ?? []).map((c) => ({ ...c }));

  const computeStats = (): ChunkMigrationStats => ({
    total_chunks: chunks.length,
    gemini_chunks: chunks.filter((c) => c.hasGemini).length,
    cloudflare_chunks: chunks.filter((c) => c.hasCf).length,
    missing_cloudflare_chunks: chunks.filter((c) => !c.hasCf).length,
    missing_gemini_chunks: chunks.filter((c) => !c.hasGemini && c.hasCf).length,
    has_embedding_cf_column: true,
    has_embedding_model_column: true,
    has_embedding_cf_model_column: true,
    embedding_nullable: true,
    pgvector_enabled: true,
  });

  const storage: ReembedCloudflareStorage & ReembedGeminiStorage = {
    inspectDatabaseIdentity: async () => options.identity,
    getChunkMigrationStats: async () => computeStats(),
    fetchChunksNeedingCloudflareEmbedding: async (limit: number) =>
      chunks
        .filter((c) => !c.hasCf)
        .slice(0, limit)
        .map((c) => ({ chunk_id: c.chunk_id, text: c.text })),
    saveCloudflareChunkEmbeddings: async (items) => {
      writeCount += items.length;
      let count = 0;
      for (const item of items) {
        const target = chunks.find((c) => c.chunk_id === item.chunk_id && !c.hasCf);
        if (target) {
          target.hasCf = true;
          count += 1;
        }
      }
      return count;
    },
    fetchChunksNeedingGeminiEmbedding: async (limit: number) =>
      chunks
        .filter((c) => !c.hasGemini)
        .slice(0, limit)
        .map((c) => ({ chunk_id: c.chunk_id, text: c.text })),
    saveGeminiChunkEmbeddings: async (items) => {
      writeCount += items.length;
      let count = 0;
      for (const item of items) {
        const target = chunks.find((c) => c.chunk_id === item.chunk_id && !c.hasGemini);
        if (target) {
          target.hasGemini = true;
          count += 1;
        }
      }
      return count;
    },
    close: async () => {},
  };

  return { storage, getWriteCount: () => writeCount, chunks };
}

async function runSafetyAndIsolationTests() {
  const previewUrl = "postgresql://user:supersecret@ep-preview-branch.neon.tech/documind_preview";
  const prodMockUrl = "postgresql://produser:topsecret@ep-main-prod-mock.neon.tech/neondb";

  // 1. Wrong expected hostname -> aborts before any write
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-preview-branch.neon.tech",
        urlDatabaseName: "documind_preview",
        serverDatabaseName: "documind_preview",
        serverVersion: "16.4",
      },
      initialChunks: [{ chunk_id: "c1", text: "alpha", hasGemini: true, hasCf: false }],
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: [
            "--execute",
            "--allow-preview",
            "--expected-host=ep-other-host.neon.tech",
            "--expected-db=documind_preview",
          ],
          env: { TARGET_ENV: "preview", DATABASE_URL: previewUrl },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(1024, 0)),
          logger: () => {},
        }),
      /host mismatch/i
    );
    assert.equal(mock.getWriteCount(), 0);
  }

  // 2. Wrong expected database name (URL mismatch AND server current_database() mismatch)
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-preview-branch.neon.tech",
        urlDatabaseName: "",
        serverDatabaseName: "actual_other_db",
        serverVersion: "16.4",
      },
      initialChunks: [{ chunk_id: "c1", text: "alpha", hasGemini: true, hasCf: false }],
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: [
            "--execute",
            "--allow-preview",
            "--expected-host=ep-preview-branch.neon.tech",
            "--expected-db=documind_preview",
          ],
          env: {
            TARGET_ENV: "preview",
            DATABASE_URL: "postgresql://user:supersecret@ep-preview-branch.neon.tech",
          },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(1024, 0)),
          logger: () => {},
        }),
      /Database name verification failed/i
    );
    assert.equal(mock.getWriteCount(), 0);
  }

  // 3. Preview targeting Production (CLI guard + runtime PostgresBlobStorage guard)
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-main-prod-mock.neon.tech",
        urlDatabaseName: "neondb",
        serverDatabaseName: "neondb",
        serverVersion: "16.4",
      },
      initialChunks: [{ chunk_id: "c1", text: "alpha", hasGemini: true, hasCf: false }],
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: [
            "--execute",
            "--allow-preview",
            "--expected-host=ep-main-prod-mock.neon.tech",
            "--expected-db=neondb",
          ],
          env: {
            TARGET_ENV: "preview",
            VERCEL_ENV: "preview",
            DATABASE_URL: prodMockUrl,
            PRODUCTION_DATABASE_HOST: "ep-main-prod-mock.neon.tech",
          },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(1024, 0)),
          logger: () => {},
        }),
      /identified as Production/i
    );
    assert.equal(mock.getWriteCount(), 0);

    // Runtime protection in server/storage.ts
    assert.throws(
      () =>
        assertPreviewDatabaseIsolation(prodMockUrl, {
          VERCEL_ENV: "preview",
          PRODUCTION_DATABASE_HOST: "ep-main-prod-mock.neon.tech",
        }),
      (err) => err instanceof StorageConfigError && /Production PostgreSQL target/i.test(err.message)
    );

    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevProdHost = process.env.PRODUCTION_DATABASE_HOST;
    try {
      process.env.VERCEL_ENV = "preview";
      process.env.PRODUCTION_DATABASE_HOST = "ep-main-prod-mock.neon.tech";
      const runtimeStorage = new PostgresBlobStorage(prodMockUrl, createInMemoryPostgresTestPool({ databaseName: "neondb" }).pool);
      await assert.rejects(() => runtimeStorage.init(), /Preview deployment refused/i);
    } finally {
      if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevVercelEnv;
      if (prevProdHost === undefined) delete process.env.PRODUCTION_DATABASE_HOST;
      else process.env.PRODUCTION_DATABASE_HOST = prevProdHost;
    }
  }

  // 4. Missing TARGET_ENV -> refuses --execute even if VERCEL_ENV is set
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-preview-branch.neon.tech",
        urlDatabaseName: "documind_preview",
        serverDatabaseName: "documind_preview",
        serverVersion: "16.4",
      },
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: [
            "--execute",
            "--allow-preview",
            "--expected-host=ep-preview-branch.neon.tech",
            "--expected-db=documind_preview",
          ],
          env: { VERCEL_ENV: "preview", DATABASE_URL: previewUrl },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(1024, 0)),
          logger: () => {},
        }),
      /TARGET_ENV is not set/i
    );
    assert.equal(mock.getWriteCount(), 0);
  }

  // 5. Missing --confirm-production -> refuses TARGET_ENV=production writes
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-main-prod-mock.neon.tech",
        urlDatabaseName: "neondb",
        serverDatabaseName: "neondb",
        serverVersion: "16.4",
      },
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: [
            "--execute",
            "--expected-host=ep-main-prod-mock.neon.tech",
            "--expected-db=neondb",
          ],
          env: { TARGET_ENV: "production", DATABASE_URL: prodMockUrl },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(1024, 0)),
          logger: () => {},
        }),
      /requires --confirm-production/i
    );
    await assert.rejects(
      () =>
        runReembedGemini({
          argv: [
            "--execute",
            "--expected-host=ep-main-prod-mock.neon.tech",
            "--expected-db=neondb",
          ],
          env: { TARGET_ENV: "production", DATABASE_URL: prodMockUrl },
          createStorage: () => mock.storage,
          embedTexts: async (t) => t.map(() => unitVec(3072, 0)),
          logger: () => {},
        }),
      /requires --confirm-production/i
    );
    assert.equal(mock.getWriteCount(), 0);
  }

  // 6. Conflicting Preview and Production flags -> rejected immediately
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-preview-branch.neon.tech",
        urlDatabaseName: "documind_preview",
        serverDatabaseName: "documind_preview",
        serverVersion: "16.4",
      },
    });
    await assert.rejects(
      () =>
        runReembedCloudflare({
          argv: ["--execute", "--allow-preview", "--confirm-production"],
          env: { TARGET_ENV: "preview", DATABASE_URL: previewUrl },
          createStorage: () => mock.storage,
          logger: () => {},
        }),
      /cannot be used together/i
    );
  }

  // 7. Dry-run behavior -> default when --execute omitted, works without TARGET_ENV, 0 writes, logs no secrets
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-preview-branch.neon.tech",
        urlDatabaseName: "documind_preview",
        serverDatabaseName: "documind_preview",
        serverVersion: "16.4",
      },
      initialChunks: [{ chunk_id: "c1", text: "alpha", hasGemini: true, hasCf: false }],
    });
    const logs: string[] = [];
    const stats = await runReembedCloudflare({
      argv: [],
      env: { DATABASE_URL: previewUrl },
      createStorage: () => mock.storage,
      logger: (line) => logs.push(line),
    });
    assert.equal(stats.missing_cloudflare_chunks, 1);
    assert.equal(mock.getWriteCount(), 0, "Dry-run must perform zero database writes");
    const joinedLogs = logs.join("\n");
    assert.ok(joinedLogs.includes("ep-preview-branch.neon.tech"));
    assert.ok(joinedLogs.includes("documind_preview"));
    assert.ok(!joinedLogs.includes("supersecret"), "Logs must never expose credentials");
  }

  // 8. Successful explicitly authorized Preview execution using an in-memory test PostgreSQL database
  {
    const testDb = createInMemoryPostgresTestPool({
      databaseName: "documind_preview",
      initialChunks: [
        {
          chunk_id: "doc1_p1_c0",
          document_id: "doc1",
          filename: "Legacy.pdf",
          page_number: 1,
          text: "Legacy Gemini chunk text",
          token_count: 4,
          embedding: "[1,0]",
          embedding_model: "gemini-embedding-2",
          embedding_cf: null,
          embedding_cf_model: null,
        },
        {
          chunk_id: "doc2_p1_c0",
          document_id: "doc2",
          filename: "CfOnly.pdf",
          page_number: 1,
          text: "Cloudflare only chunk text",
          token_count: 4,
          embedding: null,
          embedding_model: null,
          embedding_cf: `[${unitVec(1024, 0).join(",")}]`,
          embedding_cf_model: "@cf/baai/bge-m3",
        },
      ],
    });

    const previewLogs: string[] = [];
    const cfResult = await runReembedCloudflare({
      argv: [
        "--execute",
        "--allow-preview",
        "--expected-host=ep-preview-branch.neon.tech",
        "--expected-db=documind_preview",
        "--batch-size=2",
      ],
      env: {
        TARGET_ENV: "preview",
        VERCEL_ENV: "preview",
        DATABASE_URL: previewUrl,
      },
      createStorage: (dbUrl) => new PostgresBlobStorage(dbUrl, testDb.pool),
      embedTexts: async (texts) => texts.map((_, idx) => unitVec(1024, idx)),
      logger: (line) => previewLogs.push(line),
    });

    assert.equal(cfResult.cloudflare_chunks, 2);
    assert.equal(cfResult.missing_cloudflare_chunks, 0);
    assert.equal(testDb.rows[0].embedding, "[1,0]", "Existing Gemini vector must remain preserved");
    assert.equal(testDb.rows[0].embedding_cf_model, "@cf/baai/bge-m3");
    assert.ok(testDb.isClosed(), "Storage pool must be closed cleanly");
    assert.ok(!previewLogs.join("\n").includes("supersecret"));

    // Verify rollback script against the same isolated Preview test DB restores missing Gemini chunk
    const rollbackResult = await runReembedGemini({
      argv: [
        "--execute",
        "--allow-preview",
        "--expected-host=ep-preview-branch.neon.tech",
        "--expected-db=documind_preview",
        "--batch-size=2",
      ],
      env: {
        TARGET_ENV: "preview",
        VERCEL_ENV: "preview",
        DATABASE_URL: previewUrl,
      },
      createStorage: (dbUrl) => new PostgresBlobStorage(dbUrl, testDb.pool),
      embedTexts: async (texts) => texts.map((_, idx) => unitVec(3072, idx)),
      logger: () => {},
    });
    assert.equal(rollbackResult.gemini_chunks, 2);
    assert.equal(rollbackResult.missing_gemini_chunks, 0);
    assert.equal(testDb.rows[1].embedding_model, "gemini-embedding-2");
  }

  // 9. Successful explicitly authorized Production execution using mocks only (never real Production DB)
  {
    const mockProd = createMockBackfillStorage({
      identity: {
        hostname: "ep-main-prod-mock.neon.tech",
        urlDatabaseName: "neondb",
        serverDatabaseName: "neondb",
        serverVersion: "16.4",
      },
      initialChunks: [
        { chunk_id: "p1", text: "Chunk 1", hasGemini: true, hasCf: false },
        { chunk_id: "p2", text: "Chunk 2", hasGemini: true, hasCf: false },
      ],
    });
    const prodLogs: string[] = [];
    const prodStats = await runReembedCloudflare({
      argv: [
        "--execute",
        "--confirm-production",
        "--expected-host=ep-main-prod-mock.neon.tech",
        "--expected-db=neondb",
        "--batch-size=1",
      ],
      env: {
        TARGET_ENV: "production",
        DATABASE_URL: prodMockUrl,
        PRODUCTION_DATABASE_HOST: "ep-main-prod-mock.neon.tech",
        PRODUCTION_DATABASE_NAME: "neondb",
      },
      createStorage: () => mockProd.storage,
      embedTexts: async (texts) => texts.map(() => unitVec(1024, 0)),
      logger: (line) => prodLogs.push(line),
    });

    assert.equal(prodStats.cloudflare_chunks, 2);
    assert.equal(prodStats.missing_cloudflare_chunks, 0);
    assert.equal(mockProd.getWriteCount(), 2);
    const joinedProdLogs = prodLogs.join("\n");
    assert.ok(joinedProdLogs.includes("WARNING: Executing PRODUCTION backfill writes"));
    assert.ok(!joinedProdLogs.includes("topsecret"), "Production password must never be logged");
  }

  // 10. pg.Pool idle error listener & connection string secret sanitization
  {
    const emitter = new EventEmitter();
    const fakePool = Object.assign(emitter, {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      end: async () => {},
    }) as unknown as Pool;

    new PostgresBlobStorage(previewUrl, fakePool);
    assert.equal(
      emitter.listenerCount("error"),
      1,
      "PostgresBlobStorage must attach an error listener to pg.Pool for Neon serverless idle disconnects"
    );

    const origConsoleError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    try {
      emitter.emit("error", new Error("Connection error to postgresql://user:supersecret@ep-preview-branch.neon.tech/neondb"));
    } finally {
      console.error = origConsoleError;
    }
    assert.ok(!captured.join("\n").includes("supersecret"), "Pool error log must redact PostgreSQL password");
    assert.equal(
      sanitizeDatabaseErrorMessage("failed postgresql://neondb_owner:mysecretpw@ep-x.neon.tech/neondb"),
      "failed postgresql://***@ep-x.neon.tech/neondb"
    );
  }

  console.log("PASS: All database identity, Preview isolation, and Production safety tests passed (10/10).");
}

async function runDualProviderFallbackTests() {
  const prevEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_CHAT_MODEL: process.env.CLOUDFLARE_CHAT_MODEL,
    CLOUDFLARE_EMBEDDING_MODEL: process.env.CLOUDFLARE_EMBEDDING_MODEL,
  };

  const sampleChunks = [
    {
      rank: 1,
      chunk_id: "doc_policy_p4_c0",
      document_id: "doc_policy",
      filename: "Security_Policy.pdf",
      page_number: 4,
      text: "Audit logs must be retained for 365 days in immutable storage.",
      similarity: 0.96,
      distance: 0.04,
    },
  ];

  try {
    delete process.env.AI_PROVIDER;
    delete process.env.GEMINI_MODEL;
    delete process.env.CLOUDFLARE_CHAT_MODEL;
    delete process.env.CLOUDFLARE_EMBEDDING_MODEL;
    process.env.GEMINI_API_KEY = "AIzaTestFakeGeminiSecretKey1234567890";
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-test-account-9999";
    process.env.CLOUDFLARE_API_TOKEN = "Bearer cf-secret-api-token-xyz";

    // 1. Gemini success (Cloudflare must NOT be called)
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    let geminiCalls = 0;
    let cfCalls = 0;
    setGeminiFetchForTest(async () => {
      geminiCalls += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Audit logs are retained for 365 days [Security_Policy.pdf, p. 4]." }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    setCloudflareFetchForTest(async () => {
      cfCalls += 1;
      throw new Error("Cloudflare should not be called when Gemini succeeds");
    });

    const geminiSuccess = await generateRagAnswer(
      "How long must audit logs be retained?",
      sampleChunks,
      { maxAttempts: 1 }
    );
    assert.equal(geminiCalls, 1);
    assert.equal(cfCalls, 0);
    assert.equal(geminiSuccess.provider, "gemini");
    assert.equal(geminiSuccess.model, "gemini-3.1-flash-lite");
    assert.equal(geminiSuccess.fallbackUsed, false);
    assert.ok(geminiSuccess.answer.includes("[Security_Policy.pdf, p. 4]"));

    // 2. Gemini HTTP 429 rate limit -> automatic Cloudflare fallback preserves question & PDF context
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    cfCalls = 0;
    setGeminiFetchForTest(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded (RPM).",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    });
    setCloudflareFetchForTest(async (input, init) => {
      cfCalls += 1;
      const url = String(input);
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/cf-test-account-9999/ai/v1/chat/completions"
      );
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer cf-secret-api-token-xyz");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, "@cf/google/gemma-4-26b-a4b-it");
      assert.equal(body.stream, false);
      const userMsg = body.messages[1].content;
      assert.ok(userMsg.includes("How long must audit logs be retained?"));
      assert.ok(userMsg.includes("Security_Policy.pdf"));
      assert.ok(userMsg.includes("Page: 4"));
      assert.ok(userMsg.includes("365 days in immutable storage"));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Cloudflare fallback: Logs are retained 365 days [Security_Policy.pdf, p. 4].",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const fallback429 = await generateRagAnswer(
      "How long must audit logs be retained?",
      sampleChunks,
      { maxAttempts: 1 }
    );
    assert.equal(cfCalls, 1);
    assert.equal(fallback429.provider, "cloudflare");
    assert.equal(fallback429.model, "@cf/google/gemma-4-26b-a4b-it");
    assert.equal(fallback429.fallbackUsed, true);
    assert.ok(fallback429.answer.includes("[Security_Policy.pdf, p. 4]"));

    // 3. Gemini HTTP 503 temporary service unavailable -> automatic Cloudflare fallback
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    cfCalls = 0;
    setGeminiFetchForTest(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "The model is overloaded. Please try again later.",
            status: "UNAVAILABLE",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    });
    setCloudflareFetchForTest(async () => {
      cfCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Recovered via Cloudflare after 503 [Security_Policy.pdf, p. 4]." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const fallback503 = await generateRagAnswer(
      "What is the retention window?",
      sampleChunks,
      { maxAttempts: 1 }
    );
    assert.equal(cfCalls, 1);
    assert.equal(fallback503.provider, "cloudflare");
    assert.equal(fallback503.model, "@cf/google/gemma-4-26b-a4b-it");
    assert.equal(fallback503.fallbackUsed, true);
    assert.equal(fallback503.fallbackReason, "transient");
    assert.ok(fallback503.answer.includes("[Security_Policy.pdf, p. 4]"));

    // 3b. Stale deprecated CLOUDFLARE_CHAT_MODEL env override auto-upgrades to Gemma 4
    process.env.CLOUDFLARE_CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
    assert.equal(getActiveChatModel("cloudflare"), "@cf/google/gemma-4-26b-a4b-it");
    delete process.env.CLOUDFLARE_CHAT_MODEL;

    // 4. Gemini provider timeout -> automatic Cloudflare fallback (plus non-RAG fallback)
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    cfCalls = 0;
    setGeminiFetchForTest(async () => {
      const timeoutErr = new Error("Gemini API request timed out after 12000ms.");
      timeoutErr.name = "AbortError";
      throw timeoutErr;
    });
    setCloudflareFetchForTest(async () => {
      cfCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Recovered via Cloudflare after timeout." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const fallbackTimeout = await generateRagAnswer(
      "Timeout test question?",
      sampleChunks,
      { maxAttempts: 1 }
    );
    assert.equal(cfCalls, 1);
    assert.equal(fallbackTimeout.provider, "cloudflare");
    assert.equal(fallbackTimeout.fallbackUsed, true);
    assert.equal(fallbackTimeout.fallbackReason, "timeout");

    const noRagFallback = await generateWithoutRagAnswerWithMeta("General comparison query?", {
      maxAttempts: 1,
    });
    assert.equal(noRagFallback.provider, "cloudflare");
    assert.equal(noRagFallback.fallbackUsed, true);
    assert.equal(noRagFallback.answer, "Recovered via Cloudflare after timeout.");

    // 5. Both Gemini AND Cloudflare fail -> safe error message without exposing secrets
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    setGeminiFetchForTest(async () => {
      return new Response(
        JSON.stringify({ error: { code: 503, message: "Service unavailable", status: "UNAVAILABLE" } }),
        { status: 503 }
      );
    });
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }),
        { status: 401 }
      );
    });

    let dualFailureErr: unknown;
    try {
      await generateRagAnswer("Both fail question?", sampleChunks, { maxAttempts: 1 });
    } catch (err) {
      dualFailureErr = err;
    }
    assert.ok(dualFailureErr instanceof DualProviderFailureError);
    const formattedDual = formatAiError(dualFailureErr);
    assert.equal(formattedDual.status, 403);
    assert.ok(formattedDual.message.includes("gemini"));
    assert.ok(formattedDual.message.includes("cloudflare"));
    assert.ok(!formattedDual.message.includes("AIzaTestFakeGeminiSecretKey1234567890"));
    assert.ok(!formattedDual.message.includes("cf-secret-api-token-xyz"));
    assert.ok(!formattedDual.message.includes("cf-test-account-9999"));

    // 6. End-to-end Express HTTP route test (/api/health and /api/chat/compare under Gemini 503 -> Cloudflare fallback)
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    setGeminiFetchForTest(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.toLowerCase().includes("embedcontent")) {
        return new Response(
          JSON.stringify({ embeddings: [{ values: unitVec(3072, 0) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: { code: 503, message: "High demand", status: "UNAVAILABLE" } }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    });
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "HTTP fallback response from Cloudflare Gemma 4." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const expressApp = createApiApp();
    const server = http.createServer(expressApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind ephemeral test port");
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const realFetch = globalThis.fetch;

      const healthResp = await realFetch(`${baseUrl}/api/health`);
      assert.equal(healthResp.status, 200);
      const healthBody = (await healthResp.json()) as {
        ai_provider: string;
        fallback_provider: string | null;
        fallback_configured: boolean;
        fallback_chat_model: string;
      };
      assert.equal(healthBody.ai_provider, "gemini");
      assert.equal(healthBody.fallback_provider, "cloudflare");
      assert.equal(healthBody.fallback_configured, true);
      assert.equal(healthBody.fallback_chat_model, "@cf/google/gemma-4-26b-a4b-it");

      const compareResp = await realFetch(`${baseUrl}/api/chat/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Verify HTTP fallback under Gemini 503" }),
      });
      assert.equal(compareResp.status, 200);
      const compareBody = (await compareResp.json()) as {
        fallback_used: boolean;
        without_rag: { answer: string; ai_provider: string; model: string; fallback_used: boolean };
      };
      assert.equal(compareBody.fallback_used, true);
      assert.equal(compareBody.without_rag.ai_provider, "cloudflare");
      assert.equal(compareBody.without_rag.model, "@cf/google/gemma-4-26b-a4b-it");
      assert.equal(compareBody.without_rag.fallback_used, true);
      assert.equal(compareBody.without_rag.answer, "HTTP fallback response from Cloudflare Gemma 4.");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }

    console.log(
      "PASS: All dual-provider Gemini->Cloudflare fallback tests passed (6/6: success, 429, 503, timeout, dual failure, HTTP route)."
    );
  } finally {
    setGeminiFetchForTest(null);
    setCloudflareFetchForTest(null);
    clearGeminiCachesForTest();
    clearCloudflareCachesForTest();
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

async function runOptionalLiveCloudflareSmokeTest() {
  const hasCreds = Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
      process.env.CLOUDFLARE_API_TOKEN?.trim()
  );
  if (!hasCreds) {
    console.log(
      "SKIPPED LIVE CLOUDFLARE API TEST: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not configured in this environment."
    );
    return;
  }

  clearCloudflareCachesForTest();
  setCloudflareFetchForTest(null);
  const [vec] = await generateCloudflareEmbeddings(["DocuMind live smoke test"]);
  assert.equal(vec.length, 1024, "Live @cf/baai/bge-m3 must return 1024 dimensions");
  const answer = await generateCloudflareWithoutRagAnswer("Reply with exactly: OK");
  assert.ok(answer.length > 0);
  console.log("PASS: Live Cloudflare Workers AI embedding (1024d) and chat completion succeeded.");
}

async function main() {
  await runSimulatedTests();
  await runSafetyAndIsolationTests();
  await runDualProviderFallbackTests();
  await runOptionalLiveCloudflareSmokeTest();
}

main().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exitCode = 1;
});
