import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { createApiApp } from "../server/app.js";
import {
  embedQuery,
  formatAiError,
  generateEmbeddings,
  generateRagAnswer,
  generateWithoutRagAnswer,
  getActiveAiProvider,
  getActiveChatModel,
  getActiveEmbeddingModel,
  getExpectedEmbeddingDimensions,
} from "../server/aiClient.js";
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
import { chunkPageText } from "../server/ragEngine.js";
import {
  buildOptimizedRagPrompt,
  RAG_MAX_CONTEXT_CHARS,
  RAG_MAX_OUTPUT_TOKENS,
} from "../server/ragPrompt.js";
import {
  assertPreviewDatabaseIsolation,
  ChunkMigrationStats,
  DatabaseIdentity,
  DocumentRecord,
  LocalDevJsonStorage,
  PostgresBlobStorage,
  sanitizeDatabaseErrorMessage,
  StorageConfigError,
  StoredChunk,
} from "../server/storage.js";
import {
  ReembedCloudflareStorage,
  runReembedCloudflare,
} from "./reembed-cloudflare.js";

function unitVec(dims: number, hotIndex: number): number[] {
  const v = new Array<number>(dims).fill(0);
  v[hotIndex] = 1;
  return v;
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
  initialDocs?: DocumentRecord[];
}) {
  const rows: TestChunkRow[] = (options.initialChunks ?? []).map((r) => ({ ...r }));
  const docs: DocumentRecord[] = (options.initialDocs ?? []).map((d) => ({ ...d }));
  const executedQueries: string[] = [];
  let closed = false;

  const runQuery = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    executedQueries.push(normalized);

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

    if (normalized.includes("SELECT vector_dims(embedding_cf) AS dims")) {
      const firstCf = rows.find((r) => r.embedding_cf !== null);
      if (!firstCf?.embedding_cf) return { rows: [], rowCount: 0 };
      const parsed = JSON.parse(firstCf.embedding_cf) as number[];
      return { rows: [{ dims: parsed.length }], rowCount: 1 };
    }

    if (normalized.includes("embedding_cf <=>")) {
      const embeddingModel = String(params[0] ?? "@cf/baai/bge-m3");
      const expectedDims = Number(params[1] ?? 1024);
      const queryVec = JSON.parse(String(params[params.length - 2])) as number[];
      const topK = Number(params[params.length - 1] ?? 3);

      const matches = rows
        .filter((r) => {
          if (r.embedding_cf === null) return false;
          if (r.embedding_cf_model !== embeddingModel) return false;
          const vec = JSON.parse(r.embedding_cf) as number[];
          return vec.length === expectedDims;
        })
        .map((r) => {
          const vec = JSON.parse(r.embedding_cf!) as number[];
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < vec.length; i++) {
            dot += vec[i] * queryVec[i];
            normA += vec[i] * vec[i];
            normB += queryVec[i] * queryVec[i];
          }
          const sim = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
          return {
            chunk_id: r.chunk_id,
            document_id: r.document_id,
            filename: r.filename,
            page_number: r.page_number,
            text: r.text,
            similarity: sim,
            distance: 1 - sim,
          };
        })
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);

      return { rows: matches, rowCount: matches.length };
    }

    if (normalized.includes("AS missing_cloudflare_chunks FROM documind_chunks")) {
      const total = rows.length;
      const legacy = rows.filter((r) => r.embedding !== null).length;
      const cf = rows.filter((r) => r.embedding_cf !== null).length;
      const missingCf = rows.filter((r) => r.embedding_cf === null).length;
      return {
        rows: [
          {
            total_chunks: total,
            legacy_chunks: legacy,
            cloudflare_chunks: cf,
            missing_cloudflare_chunks: missingCf,
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

    if (normalized.includes("FROM documind_documents d WHERE NOT EXISTS")) {
      const limit = Number(params[0] ?? 5);
      const missingDocs = docs
        .filter((d) => !rows.some((r) => r.document_id === d.id))
        .slice(0, limit);
      return { rows: missingDocs, rowCount: missingDocs.length };
    }

    if (normalized.includes("UPDATE documind_documents d SET status = 'Indexed Successfully'")) {
      let updated = 0;
      for (const doc of docs) {
        const docChunks = rows.filter((r) => r.document_id === doc.id);
        if (
          docChunks.length > 0 &&
          docChunks.every((c) => c.embedding_cf !== null) &&
          (doc.status !== "Indexed Successfully" || doc.progress < 100 || doc.chunks_count !== docChunks.length)
        ) {
          doc.status = "Indexed Successfully";
          doc.progress = 100;
          doc.error_message = null;
          doc.chunks_count = docChunks.length;
          updated += 1;
        }
      }
      return { rows: [], rowCount: updated };
    }

    if (normalized.includes("SET embedding_cf = $1")) {
      const [vec, model, chunkId] = params as [string, string, string];
      const target = rows.find((r) => r.chunk_id === chunkId && r.embedding_cf === null);
      if (!target) return { rows: [], rowCount: 0 };
      target.embedding_cf = vec;
      target.embedding_cf_model = model;
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes("INSERT INTO documind_chunks")) {
      const [chunkId, docId, filename, pageNumber, text, tokenCount, vec, model] = params as [
        string,
        string,
        string,
        number,
        string,
        number,
        string,
        string,
      ];
      const existing = rows.find((r) => r.chunk_id === chunkId);
      if (existing) {
        existing.text = text;
        existing.token_count = tokenCount;
        existing.embedding_cf = vec;
        existing.embedding_cf_model = model;
      } else {
        rows.push({
          chunk_id: chunkId,
          document_id: docId,
          filename,
          page_number: pageNumber,
          text,
          token_count: tokenCount,
          embedding: null,
          embedding_model: null,
          embedding_cf: vec,
          embedding_cf_model: model,
        });
      }
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
    docs,
    executedQueries,
    isClosed: () => closed,
  };
}

function createMockBackfillStorage(options: {
  identity: DatabaseIdentity;
  initialChunks?: Array<{
    chunk_id: string;
    document_id?: string;
    text: string;
    hasLegacy: boolean;
    hasCf: boolean;
  }>;
  missingChunkDocs?: Array<{
    doc: DocumentRecord;
    pdfBuffer?: Buffer;
  }>;
}): {
  storage: ReembedCloudflareStorage;
  getWriteCount: () => number;
  chunks: Array<{ chunk_id: string; document_id: string; text: string; hasLegacy: boolean; hasCf: boolean }>;
  docs: DocumentRecord[];
} {
  let writeCount = 0;
  const chunks = (options.initialChunks ?? []).map((c) => ({
    ...c,
    document_id: c.document_id ?? "doc-1",
  }));
  const docs = (options.missingChunkDocs ?? []).map((m) => ({ ...m.doc }));
  const pdfMap = new Map<string, Buffer>(
    (options.missingChunkDocs ?? [])
      .filter((m): m is { doc: DocumentRecord; pdfBuffer: Buffer } => Boolean(m.pdfBuffer))
      .map((m) => [m.doc.id, m.pdfBuffer])
  );

  const computeStats = (): ChunkMigrationStats => ({
    total_chunks: chunks.length,
    legacy_chunks: chunks.filter((c) => c.hasLegacy).length,
    cloudflare_chunks: chunks.filter((c) => c.hasCf).length,
    missing_cloudflare_chunks: chunks.filter((c) => !c.hasCf).length,
    has_embedding_cf_column: true,
    has_embedding_model_column: true,
    has_embedding_cf_model_column: true,
    embedding_nullable: true,
    pgvector_enabled: true,
  });

  const storage: ReembedCloudflareStorage = {
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
    fetchDocumentsWithMissingChunks: async (limit: number) =>
      docs.filter((d) => !chunks.some((c) => c.document_id === d.id)).slice(0, limit),
    getPdfBinary: async (doc: DocumentRecord) => {
      const buf = pdfMap.get(doc.id);
      return buf ? { buffer: buf, contentType: "application/pdf" } : null;
    },
    insertChunks: async (newChunks: StoredChunk[]) => {
      writeCount += newChunks.length;
      for (const c of newChunks) {
        if (!chunks.some((existing) => existing.chunk_id === c.chunk_id)) {
          chunks.push({
            chunk_id: c.chunk_id,
            document_id: c.document_id,
            text: c.text,
            hasLegacy: false,
            hasCf: Boolean(c.embedding_cf?.length),
          });
        }
      }
    },
    updateDocument: async (docId, patch) => {
      const target = docs.find((d) => d.id === docId);
      if (!target) return null;
      Object.assign(target, patch);
      return target;
    },
    markCompleteDocumentsIndexed: async () => {
      let updated = 0;
      for (const doc of docs) {
        const docChunks = chunks.filter((c) => c.document_id === doc.id);
        if (docChunks.length > 0 && docChunks.every((c) => c.hasCf) && doc.status !== "Indexed Successfully") {
          doc.status = "Indexed Successfully";
          doc.progress = 100;
          doc.chunks_count = docChunks.length;
          updated += 1;
        }
      }
      return updated;
    },
    close: async () => {},
  };

  return { storage, getWriteCount: () => writeCount, chunks, docs };
}

async function runCloudflareOnlyCoreTests() {
  const prevEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_CHAT_MODEL: process.env.CLOUDFLARE_CHAT_MODEL,
    CLOUDFLARE_EMBEDDING_MODEL: process.env.CLOUDFLARE_EMBEDDING_MODEL,
  };

  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-test-account-9999";
    process.env.CLOUDFLARE_API_TOKEN = "Bearer cf-secret-api-token-xyz";
    delete process.env.CLOUDFLARE_CHAT_MODEL;
    delete process.env.CLOUDFLARE_EMBEDDING_MODEL;

    // 1. Cloudflare-only provider & model defaults (deprecated overrides auto-upgrade)
    assert.equal(getActiveAiProvider(), "cloudflare");
    assert.equal(getActiveChatModel(), "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.equal(getActiveEmbeddingModel(), "@cf/baai/bge-m3");
    assert.equal(getExpectedEmbeddingDimensions(), 1024);

    for (const retiredModel of [
      "@cf/meta/llama-3.1-8b-instruct-fp8",
      "@cf/meta/llama-3.1-8b-instruct-fast",
    ]) {
      process.env.CLOUDFLARE_CHAT_MODEL = retiredModel;
      assert.equal(getActiveChatModel(), CLOUDFLARE_CHAT_MODEL);
    }
    delete process.env.CLOUDFLARE_CHAT_MODEL;

    // 2. Cloudflare embeddings generation (@cf/baai/bge-m3, 1024d, sorting, deduplication)
    clearCloudflareCachesForTest();
    let embedCalls = 0;
    setCloudflareFetchForTest(async (input, init) => {
      const url = String(input);
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/cf-test-account-9999/ai/v1/embeddings"
      );
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer cf-secret-api-token-xyz");
      embedCalls += 1;
      const body = JSON.parse(String(init?.body)) as { model: string; input: string | string[] };
      assert.equal(body.model, CLOUDFLARE_EMBEDDING_MODEL);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
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
    assert.deepEqual(vectors[0], vectors[2]);

    // 3. Embedding dimension validation rejects != 1024d
    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: new Array(3072).fill(0.01) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    await assert.rejects(
      () => generateEmbeddings(["wrong-dims"]),
      /dimension mismatch/i
    );

    // 4. Query embedding generation + caching + in-flight deduplication
    clearCloudflareCachesForTest();
    let queryEmbedCalls = 0;
    setCloudflareFetchForTest(async () => {
      queryEmbedCalls += 1;
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: unitVec(1024, 2) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const [q1, q2] = await Promise.all([
      embedQuery("What is the retention window?"),
      embedQuery("What is the retention window?"),
    ]);
    assert.equal(queryEmbedCalls, 1, "Concurrent identical queries must deduplicate");
    assert.equal(q1.length, 1024);
    assert.deepEqual(q1, q2);

    // 5. Cloudflare chat generation + RAG Q&A + citation preservation
    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async (input, init) => {
      const url = String(input);
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/cf-test-account-9999/ai/v1/chat/completions"
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        max_tokens: number;
        temperature: number;
        stream: boolean;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
      assert.equal(body.max_tokens, CLOUDFLARE_CHAT_MAX_TOKENS);
      assert.equal(body.stream, false);
      assert.ok(body.temperature <= 0.2);
      const userPrompt = body.messages[1].content;
      const isRag = userPrompt.includes("<retrieved_context>");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: isRag
                  ? "Audit logs must be retained for 365 days [Security_Policy.pdf, p. 4]."
                  : "General ungrounded answer.",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const ragResult = await generateRagAnswer("How long must audit logs be retained?", [
      {
        rank: 1,
        chunk_id: "doc_p4_c0",
        document_id: "doc",
        filename: "Security_Policy.pdf",
        page_number: 4,
        text: "Audit logs must be retained for 365 days in immutable storage.",
        similarity: 0.95,
        distance: 0.05,
      },
    ]);
    assert.equal(ragResult.provider, "cloudflare");
    assert.equal(ragResult.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.ok(ragResult.answer.includes("[Security_Policy.pdf, p. 4]"));
    assert.ok(ragResult.promptPreview.includes("File: Security_Policy.pdf | Page: 4"));

    const noRagAnswer = await generateWithoutRagAnswer("How long must audit logs be retained?");
    assert.equal(noRagAnswer, "General ungrounded answer.");

    // 6. Prompt optimization: overlap stripping + duplicate suppression + context cap
    const overlapWords = Array.from({ length: 18 }, (_, i) => `word${i}`).join(" ");
    const bulkyText = "Compliance detail ".repeat(220);
    const optimized = buildOptimizedRagPrompt("Summarize retention rules", [
      {
        rank: 1,
        chunk_id: "d1_p1_c0",
        document_id: "d1",
        filename: "Security.pdf",
        page_number: 1,
        text: `Encryption is AES-256 at rest. ${overlapWords}`,
        similarity: 0.95,
        distance: 0.05,
      },
      {
        rank: 2,
        chunk_id: "d1_p1_c1",
        document_id: "d1",
        filename: "Security.pdf",
        page_number: 1,
        text: `${overlapWords} Key rotation occurs every 90 days.`,
        similarity: 0.91,
        distance: 0.09,
      },
      {
        rank: 3,
        chunk_id: "d1_p1_c0_dup",
        document_id: "d1",
        filename: "Security.pdf",
        page_number: 1,
        text: `Encryption is AES-256 at rest. ${overlapWords}`,
        similarity: 0.90,
        distance: 0.10,
      },
      {
        rank: 4,
        chunk_id: "d2_p3_c0",
        document_id: "d2",
        filename: "Compliance.pdf",
        page_number: 3,
        text: bulkyText,
        similarity: 0.85,
        distance: 0.15,
      },
    ]);
    assert.ok(optimized.contextChars <= RAG_MAX_CONTEXT_CHARS);
    assert.ok(!optimized.promptPreview.includes("d1_p1_c0_dup"));
    assert.ok(optimized.promptPreview.includes("Key rotation occurs every 90 days"));

    // 7. Auth failures (401/403), rate limit retries vs neuron quota exhaustion, and timeouts
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
    let rateAttempts = 0;
    setCloudflareFetchForTest(async () => {
      rateAttempts += 1;
      if (rateAttempts === 1) {
        return new Response(
          JSON.stringify({ errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] }),
          { status: 429, headers: { "retry-after-ms": "40" } }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Recovered after retry." } }] }),
        { status: 200 }
      );
    });
    const recovered = await generateCloudflareRagAnswer("retry test", [
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
    ]);
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
    assert.equal(quotaAttempts, 1, "Daily neuron exhaustion must fail fast");

    clearCloudflareCachesForTest();
    setCloudflareFetchForTest(async () => {
      const timeoutErr = new Error("Cloudflare Workers AI request timed out after 15000ms.");
      timeoutErr.name = "AbortError";
      throw timeoutErr;
    });
    await assert.rejects(
      () => generateCloudflareWithoutRagAnswer("timeout test"),
      (err) => formatAiError(err).status === 504
    );

    // Expired deadline fails fast with zero network calls
    clearCloudflareCachesForTest();
    let expiredNetworkCalls = 0;
    setCloudflareFetchForTest(async () => {
      expiredNetworkCalls += 1;
      return new Response("{}", { status: 200 });
    });
    await assert.rejects(
      () =>
        generateRagAnswer("Expired deadline test?", [], {
          deadlineMs: Date.now() - 50,
          maxAttempts: 1,
        }).then(() => generateCloudflareWithoutRagAnswer("Expired deadline", { deadlineMs: Date.now() - 50 })),
      (err) => formatAiError(err).status === 504
    );
    assert.equal(expiredNetworkCalls, 0);

    // 8. Secret redaction across HTTP errors and [ai.telemetry] logs
    clearCloudflareCachesForTest();
    const capturedTelemetry: string[] = [];
    const origInfo = console.info;
    const origError = console.error;
    console.info = (...args: unknown[]) => capturedTelemetry.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => capturedTelemetry.push(args.map(String).join(" "));
    try {
      setCloudflareFetchForTest(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Failure calling https://api.cloudflare.com/client/v4/accounts/cf-test-account-9999/ai/v1 with Bearer cf-secret-api-token-xyz on postgresql://user:dbsecret99@ep-test.neon.tech/neondb",
            },
          }),
          { status: 503 }
        );
      });

      let caught: unknown;
      try {
        await generateRagAnswer(
          "Secret check?",
          [
            {
              rank: 1,
              chunk_id: "c1",
              document_id: "d1",
              filename: "Doc.pdf",
              page_number: 1,
              text: "Secret redaction test passage.",
              similarity: 0.9,
              distance: 0.1,
            },
          ],
          { maxAttempts: 1, requestId: "req-cf-redaction-1" }
        );
      } catch (err) {
        caught = err;
      }

      const formatted = formatAiError(caught);
      assert.equal(formatted.status, 503);
      const allOutput = `${formatted.message}\n${capturedTelemetry.join("\n")}`;
      assert.ok(!allOutput.includes("cf-secret-api-token-xyz"));
      assert.ok(!allOutput.includes("cf-test-account-9999"));
      assert.ok(!allOutput.includes("dbsecret99"));
      assert.ok(
        capturedTelemetry.some(
          (line) => line.includes("[ai.telemetry]") && line.includes("req-cf-redaction-1")
        )
      );
    } finally {
      console.info = origInfo;
      console.error = origError;
    }

    console.log("PASS: Cloudflare Workers AI core, error handling, timeouts, and redaction tests passed (8/8).");
  } finally {
    setCloudflareFetchForTest(null);
    clearCloudflareCachesForTest();
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

async function runStorageRetrievalAndSafetyTests() {
  const previewUrl = "postgresql://user:supersecret@ep-preview-branch.neon.tech/documind_preview";
  const prodMockUrl = "postgresql://produser:topsecret@ep-main-prod-mock.neon.tech/neondb";

  // 9. PDF chunking + LocalDevJsonStorage indexing & 1024d retrieval (ignoring legacy 3072d rows)
  const sampleChunks = chunkPageText(
    "Cloudflare Workers AI runs BGE-M3 embeddings at 1024 dimensions.",
    1,
    "doc-chunk-1",
    "Architecture.pdf"
  );
  assert.equal(sampleChunks.length, 1);
  assert.equal(sampleChunks[0].filename, "Architecture.pdf");
  assert.equal(sampleChunks[0].page_number, 1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "documind-cf-test-"));
  try {
    const store = new LocalDevJsonStorage(path.join(tmpDir, "store.json"));
    await store.insertDocument({
      id: "doc-legacy-only",
      filename: "LegacyUnmigrated.pdf",
      size_bytes: 512,
      pages: 1,
      chunks_count: 1,
      status: "Indexed Successfully",
      progress: 100,
      error_message: null,
      sha256: "legacy123",
      uploaded_at: new Date().toISOString(),
    });
    await store.insertChunks([
      {
        chunk_id: "doc-legacy-only_p1_c0",
        document_id: "doc-legacy-only",
        filename: "LegacyUnmigrated.pdf",
        page_number: 1,
        text: "Legacy 3072d chunk without embedding_cf",
        token_count: 6,
        embedding: unitVec(3072, 0),
        embedding_model: "legacy-3072",
        embedding_cf: null,
        embedding_cf_model: null,
      },
    ]);

    await store.insertDocument({
      id: "doc-cf",
      filename: "CloudflareGuide.pdf",
      size_bytes: 1024,
      pages: 1,
      chunks_count: 1,
      status: "Indexed Successfully",
      progress: 100,
      error_message: null,
      sha256: "cf123",
      uploaded_at: new Date().toISOString(),
    });
    await store.insertChunks([
      {
        chunk_id: "doc-cf_p1_c0",
        document_id: "doc-cf",
        filename: "CloudflareGuide.pdf",
        page_number: 1,
        text: "Indexed strictly with 1024d @cf/baai/bge-m3.",
        token_count: 7,
        embedding: null,
        embedding_model: null,
        embedding_cf: unitVec(1024, 0),
        embedding_cf_model: "@cf/baai/bge-m3",
      },
    ]);

    const hits = await store.searchSimilarChunks(unitVec(1024, 0), 3, undefined, {
      provider: "cloudflare",
      embeddingModel: "@cf/baai/bge-m3",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].chunk_id, "doc-cf_p1_c0");
    assert.equal(await store.getEmbeddingDimensions(), 1024);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 10. PostgreSQL vector retrieval strictly queries embedding_cf (1024d) & validates query dims
  {
    const testDb = createInMemoryPostgresTestPool({
      databaseName: "documind_preview",
      initialChunks: [
        {
          chunk_id: "legacy_row",
          document_id: "doc_legacy",
          filename: "Old.pdf",
          page_number: 1,
          text: "Legacy unmigrated row",
          token_count: 3,
          embedding: JSON.stringify(unitVec(3072, 0)),
          embedding_model: "legacy-3072",
          embedding_cf: null,
          embedding_cf_model: null,
        },
        {
          chunk_id: "cf_row",
          document_id: "doc_cf",
          filename: "New.pdf",
          page_number: 2,
          text: "Cloudflare BGE-M3 chunk",
          token_count: 4,
          embedding: null,
          embedding_model: null,
          embedding_cf: JSON.stringify(unitVec(1024, 0)),
          embedding_cf_model: "@cf/baai/bge-m3",
        },
      ],
    });
    const pgStorage = new PostgresBlobStorage(previewUrl, testDb.pool);
    const pgHits = await pgStorage.searchSimilarChunks(unitVec(1024, 0), 3, undefined, {
      provider: "cloudflare",
      embeddingModel: "@cf/baai/bge-m3",
    });
    assert.equal(pgHits.length, 1);
    assert.equal(pgHits[0].chunk_id, "cf_row");
    assert.ok(
      testDb.executedQueries.some((q) => q.includes("embedding_cf <=>")),
      "PostgreSQL retrieval must query embedding_cf <=>"
    );
    await assert.rejects(
      () => pgStorage.searchSimilarChunks(unitVec(3072, 0), 3),
      /Vector dimension mismatch/i
    );
  }

  // 11. Database identity, Preview isolation, Production guards, and resumable/idempotent backfill
  {
    const mock = createMockBackfillStorage({
      identity: {
        hostname: "ep-main-prod-mock.neon.tech",
        urlDatabaseName: "neondb",
        serverDatabaseName: "neondb",
        serverVersion: "16.4",
      },
      initialChunks: [{ chunk_id: "c1", text: "alpha", hasLegacy: true, hasCf: false }],
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

    assert.throws(
      () =>
        assertPreviewDatabaseIsolation(prodMockUrl, {
          VERCEL_ENV: "preview",
          PRODUCTION_DATABASE_HOST: "ep-main-prod-mock.neon.tech",
        }),
      (err) => err instanceof StorageConfigError
    );

    const testDb = createInMemoryPostgresTestPool({
      databaseName: "documind_preview",
      initialDocs: [
        {
          id: "doc1",
          filename: "Legacy.pdf",
          size_bytes: 1000,
          pages: 1,
          chunks_count: 1,
          status: "Generating Embeddings",
          progress: 75,
          error_message: null,
          sha256: "sha1",
          uploaded_at: new Date().toISOString(),
        },
      ],
      initialChunks: [
        {
          chunk_id: "doc1_p1_c0",
          document_id: "doc1",
          filename: "Legacy.pdf",
          page_number: 1,
          text: "Legacy text preserved for Cloudflare re-embedding",
          token_count: 7,
          embedding: "[1,0]",
          embedding_model: "legacy-3072",
          embedding_cf: null,
          embedding_cf_model: null,
        },
      ],
    });

    const stats = await runReembedCloudflare({
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
      logger: () => {},
    });

    assert.equal(stats.cloudflare_chunks, 1);
    assert.equal(stats.missing_cloudflare_chunks, 0);
    assert.equal(testDb.docs[0].status, "Indexed Successfully");
    assert.equal(testDb.rows[0].embedding_cf_model, "@cf/baai/bge-m3");
    assert.ok(testDb.isClosed());

    // Re-running is idempotent (0 new embedding/write calls when already complete)
    let rerunEmbedCalls = 0;
    const idempotentStats = await runReembedCloudflare({
      argv: [
        "--execute",
        "--allow-preview",
        "--expected-host=ep-preview-branch.neon.tech",
        "--expected-db=documind_preview",
      ],
      env: { TARGET_ENV: "preview", VERCEL_ENV: "preview", DATABASE_URL: previewUrl },
      createStorage: (dbUrl) => new PostgresBlobStorage(dbUrl, testDb.pool),
      embedTexts: async (texts) => {
        rerunEmbedCalls += 1;
        return texts.map(() => unitVec(1024, 0));
      },
      logger: () => {},
    });
    assert.equal(rerunEmbedCalls, 0);
    assert.equal(idempotentStats.cloudflare_chunks, 1);
    assert.equal(idempotentStats.missing_cloudflare_chunks, 0);
  }

  // 12. pg.Pool idle error listener & connection string secret sanitization
  {
    const emitter = new EventEmitter();
    const fakePool = Object.assign(emitter, {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      end: async () => {},
    }) as unknown as Pool;

    new PostgresBlobStorage(previewUrl, fakePool);
    assert.equal(emitter.listenerCount("error"), 1);
    assert.equal(
      sanitizeDatabaseErrorMessage("failed postgresql://neondb_owner:mysecretpw@ep-x.neon.tech/neondb"),
      "failed postgresql://***@ep-x.neon.tech/neondb"
    );
  }

  console.log("PASS: Storage retrieval, 1024d migration safety, and backfill tests passed (4/4).");
}

async function runHttpApiAndHealthTests() {
  const prevEnv = {
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  };

  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-http-account";
    process.env.CLOUDFLARE_API_TOKEN = "cf-http-token";
    clearCloudflareCachesForTest();

    setCloudflareFetchForTest(async (input, init) => {
      const url = String(input);
      if (url.includes("/ai/models/search")) {
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/ai/v1/embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ index: 0, embedding: unitVec(1024, 0) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      assert.ok(url.endsWith("/ai/v1/chat/completions"));
      const body = JSON.parse(String(init?.body)) as { model: string };
      assert.equal(body.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "HTTP Cloudflare Llama 4 Scout response." } }],
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

      // 13a. /api/health when app + DB + Cloudflare provider probe succeed
      const healthResp = await realFetch(`${baseUrl}/api/health`);
      assert.equal(healthResp.status, 200);
      const healthBody = (await healthResp.json()) as {
        status: string;
        app_status: string;
        database_checked: boolean;
        database_healthy: boolean;
        ai_provider: string;
        chat_model: string;
        embedding_model: string;
        fallback_enabled: boolean;
        provider_status: string;
        provider_connectivity: { checked: boolean; reachable: boolean; status: string };
      };
      assert.equal(healthBody.status, "ok");
      assert.equal(healthBody.app_status, "ok");
      assert.equal(healthBody.database_checked, true);
      assert.equal(healthBody.database_healthy, true);
      assert.equal(healthBody.ai_provider, "cloudflare");
      assert.equal(healthBody.chat_model, "@cf/meta/llama-4-scout-17b-16e-instruct");
      assert.equal(healthBody.embedding_model, "@cf/baai/bge-m3");
      assert.equal(healthBody.fallback_enabled, false);
      assert.equal(healthBody.provider_status, "reachable");
      assert.equal(healthBody.provider_connectivity.checked, true);
      assert.equal(healthBody.provider_connectivity.reachable, true);

      // 13b. /api/health distinguishes healthy app from unreachable Cloudflare provider
      setCloudflareFetchForTest(async (input) => {
        const url = String(input);
        if (url.includes("/ai/models/search")) {
          return new Response(
            JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }),
            { status: 401 }
          );
        }
        return new Response("{}", { status: 200 });
      });
      const degradedResp = await realFetch(`${baseUrl}/api/health?refresh=1`);
      assert.equal(degradedResp.status, 200);
      const degradedBody = (await degradedResp.json()) as {
        status: string;
        app_status: string;
        provider_status: string;
      };
      assert.equal(degradedBody.app_status, "ok");
      assert.equal(degradedBody.status, "degraded");
      assert.equal(degradedBody.provider_status, "unreachable");

      // Restore working mock for compare & inspect routes
      setCloudflareFetchForTest(async (input) => {
        const url = String(input);
        if (url.endsWith("/ai/v1/embeddings")) {
          return new Response(
            JSON.stringify({ data: [{ index: 0, embedding: unitVec(1024, 0) }] }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "HTTP Cloudflare Llama 4 Scout response." } }],
          }),
          { status: 200 }
        );
      });

      const compareResp = await realFetch(`${baseUrl}/api/chat/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Verify Cloudflare compare route" }),
      });
      assert.equal(compareResp.status, 200);
      const compareBody = (await compareResp.json()) as {
        ai_provider: string;
        model: string;
        without_rag: { answer: string; ai_provider: string; model: string };
      };
      assert.equal(compareBody.ai_provider, "cloudflare");
      assert.equal(compareBody.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
      assert.equal(compareBody.without_rag.ai_provider, "cloudflare");
      assert.equal(compareBody.without_rag.answer, "HTTP Cloudflare Llama 4 Scout response.");

      const inspectResp = await realFetch(`${baseUrl}/api/retrieval/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Verify default topK=3" }),
      });
      assert.equal(inspectResp.status, 200);
      const inspectBody = (await inspectResp.json()) as {
        top_k: number;
        ai_provider: string;
        embedding_model: string;
      };
      assert.equal(inspectBody.top_k, 3);
      assert.equal(inspectBody.ai_provider, "cloudflare");
      assert.equal(inspectBody.embedding_model, "@cf/baai/bge-m3");

      console.log("PASS: Express /api/health, /api/chat/compare, and /api/retrieval/inspect tests passed (2/2).");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  } finally {
    setCloudflareFetchForTest(null);
    clearCloudflareCachesForTest();
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
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
  await runCloudflareOnlyCoreTests();
  await runStorageRetrievalAndSafetyTests();
  await runHttpApiAndHealthTests();
  await runOptionalLiveCloudflareSmokeTest();
}

main().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exitCode = 1;
});
