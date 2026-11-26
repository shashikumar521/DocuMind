import crypto from "crypto";
import "dotenv/config";
import express, { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import {
  checkAiProviderConnectivity,
  formatAiError,
  generateDocumentComparison,
  generateRagAnswer,
  generateWithoutRagAnswerWithMeta,
  getActiveAiProvider,
  getActiveChatModel,
  getActiveEmbeddingModel,
  getCompareTotalBudgetMs,
  isAiConfigured,
  VERCEL_REQUEST_DEADLINE_MS,
} from "./aiClient.js";
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_TOKENS,
  DocumentCompareValidationError,
  ragEngine,
} from "./ragEngine.js";
import { DEFAULT_RAG_TOP_K } from "./ragPrompt.js";
import {
  runWithBlobOidcContext,
  sanitizeDatabaseErrorMessage,
  StorageConfigError,
} from "./storage.js";

export const JSON_BODY_MAX_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 4_000;
const MAX_DOCUMENT_ID_CHARS = 128;
const MAX_COMPARE_DOCUMENT_IDS = 4;
const MAX_SCOPE_DOCUMENT_IDS = 25;

const DISALLOWED_INLINE_BODY_KEYS = new Set([
  "file",
  "files",
  "pdf",
  "pdfs",
  "base64",
  "pdf_base64",
  "data",
  "data_url",
  "content",
  "contents",
  "document_text",
  "extracted_text",
  "raw_text",
  "text",
  "documents",
  "doc_a_text",
  "doc_b_text",
  "document_a_text",
  "document_b_text",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

function formatRouteError(err: unknown): { status: number; message: string } {
  if (err instanceof StorageConfigError || err instanceof DocumentCompareValidationError) {
    return { status: err.statusCode, message: sanitizeDatabaseErrorMessage(err.message) };
  }
  const formatted = formatAiError(err);
  return {
    status: formatted.status,
    message: sanitizeDatabaseErrorMessage(formatted.message),
  };
}

function isPayloadTooLargeError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { type?: unknown; status?: unknown; statusCode?: unknown; name?: unknown };
  return (
    record.type === "entity.too.large" ||
    record.status === 413 ||
    record.statusCode === 413 ||
    record.name === "PayloadTooLargeError"
  );
}

function validateNoInlineDocumentPayload(body: unknown): { status: number; detail: string } | null {
  if (body === undefined || body === null) {
    return { status: 400, detail: "Request body must be a JSON object." };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, detail: "Request body must be a JSON object." };
  }

  const record = body as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (val === undefined || val === null) continue;
    const lowerKey = key.trim().toLowerCase();
    if (!DISALLOWED_INLINE_BODY_KEYS.has(lowerKey)) continue;

    const isEmpty =
      (typeof val === "string" && val.trim().length === 0) ||
      (Array.isArray(val) && val.length === 0);
    if (isEmpty) continue;

    const approxSize = typeof val === "string" ? val.length : JSON.stringify(val).length;
    return {
      status: approxSize > 8_192 ? 413 : 400,
      detail:
        "Do not send PDF files, base64 data, or extracted document text in comparison requests. Upload PDFs first and pass uploaded document_ids instead.",
    };
  }

  const qRaw =
    typeof record.question === "string"
      ? record.question
      : typeof record.focus_question === "string"
      ? record.focus_question
      : "";
  if (qRaw) {
    const trimmed = qRaw.trim();
    if (/^data:application\/pdf|;base64,|%PDF-/i.test(trimmed)) {
      return {
        status: trimmed.length > 8_192 ? 413 : 400,
        detail:
          "Embedded PDF or base64 data is not allowed in the question field. Pass uploaded document_ids instead.",
      };
    }
    if (trimmed.length > MAX_QUESTION_CHARS) {
      return {
        status: trimmed.length > 16_384 ? 413 : 400,
        detail: `Question or comparison focus exceeds the ${MAX_QUESTION_CHARS}-character limit (received ${trimmed.length} characters).`,
      };
    }
  }

  return null;
}

function validateDocumentIdsList(
  rawIds: unknown,
  options: { min: number; max: number; requireDistinct: boolean }
): { ok: true; ids: string[] } | { ok: false; status: number; detail: string } {
  if (!Array.isArray(rawIds)) {
    return {
      ok: false,
      status: 400,
      detail: "document_ids must be an array of uploaded document IDs.",
    };
  }
  if (rawIds.length > options.max) {
    return {
      ok: false,
      status: 400,
      detail: `At most ${options.max} document_ids may be included in a single request.`,
    };
  }

  const cleaned: string[] = [];
  for (const item of rawIds) {
    if (typeof item !== "string") {
      return { ok: false, status: 400, detail: "Every entry in document_ids must be a string ID." };
    }
    const id = item.trim();
    if (!id || id.length > MAX_DOCUMENT_ID_CHARS || /\s/.test(id)) {
      return {
        ok: false,
        status: 400,
        detail: "Each document ID must be a valid non-empty identifier without whitespace.",
      };
    }
    cleaned.push(id);
  }

  const uniqueIds = Array.from(new Set(cleaned));
  if (options.requireDistinct && uniqueIds.length < options.min) {
    return {
      ok: false,
      status: 400,
      detail: `Please select at least ${options.min} distinct uploaded documents to compare.`,
    };
  }
  if (uniqueIds.length < options.min) {
    return {
      ok: false,
      status: 400,
      detail: `At least ${options.min} uploaded document_ids are required.`,
    };
  }

  return { ok: true, ids: uniqueIds };
}

function extractOidcHeaderToken(req: Request): string | undefined {
  const raw = req.headers["x-vercel-oidc-token"];
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0].trim() || undefined;
  }
  return undefined;
}

export function createApiApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    runWithBlobOidcContext(extractOidcHeaderToken(req), next);
  });
  app.use("/api", (req, res, next) => {
    if (req.path === "/documents/upload") {
      next();
      return;
    }
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > JSON_BODY_MAX_BYTES) {
      res.status(413).json({
        detail: `Request payload is too large (${Math.ceil(contentLength / 1024)} KB exceeds the ${Math.floor(JSON_BODY_MAX_BYTES / 1024)} KB JSON limit). Send uploaded document_ids instead of PDF files, base64 data, or extracted document text.`,
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit: JSON_BODY_MAX_BYTES }));

  // Health & diagnostics endpoint: clearly separates application/database health
  // from external Cloudflare Workers AI provider connectivity.
  app.get("/api/health", async (req, res) => {
    const aiProvider = getActiveAiProvider();
    const chatModel = getActiveChatModel();
    const embeddingModel = getActiveEmbeddingModel();
    const aiConfigured = isAiConfigured();
    const forceRefresh = req.query.refresh === "1";

    const providerConnectivityPromise = checkAiProviderConnectivity({ forceRefresh });

    try {
      await ragEngine.init();
      const [docs, chunksCount, embeddingDims, migrationStatus, providerConnectivity] = await Promise.all([
        ragEngine.listDocuments(),
        ragEngine.getTotalChunksCount(),
        ragEngine.getEmbeddingDimensions(),
        ragEngine.getMigrationStatus(),
        providerConnectivityPromise,
      ]);
      const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
      const storageInfo = ragEngine.getStorageInfo();

      const schemaReady = migrationStatus
        ? migrationStatus.has_embedding_cf_column && migrationStatus.embedding_nullable
        : true;
      const migrationComplete = migrationStatus
        ? schemaReady && migrationStatus.missing_cloudflare_chunks === 0
        : true;
      const overallStatus =
        providerConnectivity.reachable && schemaReady ? "ok" : "degraded";

      res.json({
        status: overallStatus,
        app_status: "ok",
        database_checked: true,
        database_healthy: true,
        backend: "node-express-rag",
        ai_provider: aiProvider,
        chat_model: chatModel,
        embedding_model: embeddingModel,
        fallback_enabled: false,
        ai_configured: aiConfigured,
        provider_status: providerConnectivity.status,
        provider_connectivity: providerConnectivity,
        migration_ready: schemaReady,
        migration_complete: migrationComplete,
        migration_status: migrationStatus,
        storage_mode: storageInfo.storage_mode,
        vector_store: storageInfo.vector_store,
        object_storage: storageInfo.object_storage,
        storage_file: storageInfo.storage_label,
        embedding_dimensions: embeddingDims,
        documents_count: docs.length,
        indexed_documents_count: indexedDocs.length,
        chunks_count: chunksCount,
        chunk_size_tokens: CHUNK_SIZE_TOKENS,
        chunk_overlap_tokens: CHUNK_OVERLAP_TOKENS,
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      const storageInfo = ragEngine.getStorageInfo();
      const providerConnectivity = await providerConnectivityPromise.catch(() => ({
        configured: aiConfigured,
        checked: false,
        reachable: false,
        status: aiConfigured ? ("unreachable" as const) : ("unconfigured" as const),
      }));
      res.status(formatted.status).json({
        status: "error",
        app_status: "error",
        database_checked: true,
        database_healthy: false,
        detail: formatted.message,
        backend: "node-express-rag",
        ai_provider: aiProvider,
        chat_model: chatModel,
        embedding_model: embeddingModel,
        fallback_enabled: false,
        ai_configured: aiConfigured,
        provider_status: providerConnectivity.status,
        provider_connectivity: providerConnectivity,
        storage_mode: storageInfo.storage_mode,
        vector_store: storageInfo.vector_store,
        object_storage: storageInfo.object_storage,
      });
    }
  });

  // List all documents
  app.get("/api/documents", async (_req, res) => {
    try {
      res.json({ documents: await ragEngine.listDocuments() });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Get single document
  app.get("/api/documents/:documentId", async (req, res) => {
    try {
      const doc = await ragEngine.getDocument(req.params.documentId);
      if (!doc) {
        res.status(404).json({ detail: "Document not found." });
        return;
      }
      res.json({ document: doc });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Secure server-side PDF download/preview (proxies private Vercel Blob via OIDC)
  app.get("/api/documents/:documentId/download", async (req, res) => {
    try {
      const result = await ragEngine.getDocumentBinary(req.params.documentId);
      if (!result) {
        res.status(404).json({ detail: "Document PDF not found." });
        return;
      }

      const disposition = req.query.download === "1" ? "attachment" : "inline";
      const safeName = result.doc.filename.replace(/["\\\r\n]/g, "_");
      res.setHeader("Content-Type", result.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(result.buffer);
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Upload & index PDF(s)
  app.post("/api/documents/upload", (req, res) => {
    const requestOidcToken = extractOidcHeaderToken(req);
    upload.array("files", 10)(req, res, (uploadErr: unknown) => {
      void runWithBlobOidcContext(requestOidcToken, async () => {
        if (uploadErr) {
          const msg =
            uploadErr instanceof multer.MulterError && uploadErr.code === "LIMIT_FILE_SIZE"
              ? "File exceeds the 25 MB upload limit."
              : uploadErr instanceof Error
              ? uploadErr.message
              : "Upload validation failed.";
          res.status(400).json({ detail: msg });
          return;
        }

        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) {
          res.status(400).json({ detail: "No PDF files were uploaded." });
          return;
        }

        const processed = [];
        const errors: { filename: string; detail: string }[] = [];

        for (const file of files) {
          try {
            const doc = await ragEngine.processUploadedPdf(file.originalname, file.buffer);
            processed.push(doc);
          } catch (err: unknown) {
            const formatted = formatRouteError(err);
            errors.push({
              filename: file.originalname,
              detail: formatted.message,
            });
          }
        }

        if (processed.length === 0 && errors.length > 0) {
          let docsSnapshot: unknown[] = [];
          try {
            docsSnapshot = await ragEngine.listDocuments();
          } catch {
            docsSnapshot = [];
          }
          res.status(400).json({
            detail: errors.map((e) => `${e.filename}: ${e.detail}`).join(" | "),
            errors,
            documents: docsSnapshot,
          });
          return;
        }

        res.status(errors.length > 0 ? 207 : 200).json({
          documents: processed,
          errors,
        });
      });
    });
  });

  // Delete document, associated vectors, and stored PDF object
  app.delete("/api/documents/:documentId", async (req, res) => {
    try {
      const deleted = await ragEngine.deleteDocument(req.params.documentId);
      if (!deleted) {
        res.status(404).json({ detail: "Document not found." });
        return;
      }
      res.json({ deleted: true, document_id: req.params.documentId });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // RAG Document Chat Ask
  app.post("/api/chat/ask", async (req, res) => {
    const inlineError = validateNoInlineDocumentPayload(req.body);
    if (inlineError) {
      res.status(inlineError.status).json({ detail: inlineError.detail });
      return;
    }

    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    let documentIds: string[] | undefined;
    if (req.body?.document_ids !== undefined) {
      const checked = validateDocumentIdsList(req.body.document_ids, {
        min: 0,
        max: MAX_SCOPE_DOCUMENT_IDS,
        requireDistinct: false,
      });
      if (!checked.ok) {
        res.status(checked.status).json({ detail: checked.detail });
        return;
      }
      documentIds = checked.ids.length > 0 ? checked.ids : undefined;
    }
    const topK =
      typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
        ? req.body.top_k
        : DEFAULT_RAG_TOP_K;

    const requestId = crypto.randomUUID();
    const deadlineMs = Date.now() + VERCEL_REQUEST_DEADLINE_MS;

    try {
      const retrievalStart = Date.now();
      const chunks = await ragEngine.retrieveChunks(question, topK, documentIds, {
        deadlineMs,
        requestId,
      });
      const retrievalDurationMs = Date.now() - retrievalStart;
      const ragResult = await generateRagAnswer(question, chunks, {
        deadlineMs,
        requestId,
        endpoint: "/api/chat/ask",
        retrievalDurationMs,
      });
      await ragEngine.recordQuestion(question, ragResult.answer, chunks);
      res.json({
        question,
        ai_provider: ragResult.provider,
        model: ragResult.model,
        answer: ragResult.answer,
        sources: chunks,
        prompt_preview: ragResult.promptPreview,
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Side-by-side RAG vs Without RAG comparison
  const handleCompare = async (req: Request, res: Response) => {
    const inlineError = validateNoInlineDocumentPayload(req.body);
    if (inlineError) {
      res.status(inlineError.status).json({ detail: inlineError.detail });
      return;
    }

    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    let documentIds: string[] | undefined;
    if (req.body?.document_ids !== undefined) {
      const checked = validateDocumentIdsList(req.body.document_ids, {
        min: 0,
        max: MAX_SCOPE_DOCUMENT_IDS,
        requireDistinct: false,
      });
      if (!checked.ok) {
        res.status(checked.status).json({ detail: checked.detail });
        return;
      }
      documentIds = checked.ids.length > 0 ? checked.ids : undefined;
    }
    const topK =
      typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
        ? req.body.top_k
        : DEFAULT_RAG_TOP_K;

    const requestId = crypto.randomUUID();
    const deadlineMs = Date.now() + VERCEL_REQUEST_DEADLINE_MS;

    try {
      const totalBudgetMs = getCompareTotalBudgetMs();
      const retrievalStart = Date.now();
      const chunks = await ragEngine.retrieveChunks(question, topK, documentIds, {
        deadlineMs,
        requestId,
      });
      const retrievalDurationMs = Date.now() - retrievalStart;
      const [withoutRagResult, withRagResult] = await Promise.all([
        generateWithoutRagAnswerWithMeta(question, {
          totalBudgetMs,
          deadlineMs,
          requestId,
          endpoint: req.path,
          retrievalDurationMs,
        }),
        generateRagAnswer(question, chunks, {
          totalBudgetMs,
          deadlineMs,
          requestId,
          endpoint: req.path,
          retrievalDurationMs,
        }),
      ]);
      res.json({
        question,
        ai_provider: withRagResult.provider,
        model: withRagResult.model,
        without_rag: {
          answer: withoutRagResult.answer,
          ai_provider: withoutRagResult.provider,
          model: withoutRagResult.model,
        },
        with_rag: {
          answer: withRagResult.answer,
          ai_provider: withRagResult.provider,
          model: withRagResult.model,
          sources: chunks,
          prompt_preview: withRagResult.promptPreview,
        },
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  };

  app.post("/api/chat/compare", handleCompare);
  app.post("/api/rag/compare", handleCompare);

  // Compare uploaded documents strictly by document IDs (chunks fetched & optimized server-side)
  app.post("/api/documents/compare", async (req, res) => {
    const inlineError = validateNoInlineDocumentPayload(req.body);
    if (inlineError) {
      res.status(inlineError.status).json({ detail: inlineError.detail });
      return;
    }

    const rawDocIds =
      req.body?.document_ids !== undefined
        ? req.body.document_ids
        : req.body?.document_a_id || req.body?.document_b_id
        ? [req.body.document_a_id, req.body.document_b_id]
        : undefined;

    const checkedIds = validateDocumentIdsList(rawDocIds, {
      min: 2,
      max: MAX_COMPARE_DOCUMENT_IDS,
      requireDistinct: true,
    });
    if (!checkedIds.ok) {
      res.status(checkedIds.status).json({ detail: checkedIds.detail });
      return;
    }

    const rawQuestion =
      typeof req.body?.question === "string"
        ? req.body.question
        : typeof req.body?.focus_question === "string"
        ? req.body.focus_question
        : "";
    const question = rawQuestion.trim();
    if (question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({
        detail: `Comparison focus question must be under ${MAX_QUESTION_CHARS} characters.`,
      });
      return;
    }

    const topKPerDoc =
      typeof req.body?.top_k === "number" && Number.isFinite(req.body.top_k)
        ? Math.max(1, Math.min(6, Math.floor(req.body.top_k)))
        : 4;

    const requestId = crypto.randomUUID();
    const deadlineMs = Date.now() + VERCEL_REQUEST_DEADLINE_MS;

    try {
      const retrievalStart = Date.now();
      const { documents, chunksByDocument, allSources } =
        await ragEngine.retrieveComparisonChunksForDocuments(checkedIds.ids, {
          question: question || undefined,
          topKPerDoc,
          deadlineMs,
          requestId,
        });
      const retrievalDurationMs = Date.now() - retrievalStart;

      const compareResult = await generateDocumentComparison(
        {
          question: question || undefined,
          documents: documents.map((d) => ({
            id: d.id,
            filename: d.filename,
            pages: d.pages,
          })),
          chunksByDocument,
        },
        {
          totalBudgetMs: getCompareTotalBudgetMs(),
          deadlineMs,
          requestId,
          endpoint: "/api/documents/compare",
          retrievalDurationMs,
        }
      );

      res.json({
        ai_provider: compareResult.provider,
        model: compareResult.model,
        question: question || "Side-by-side document comparison",
        documents: documents.map((d) => ({
          id: d.id,
          filename: d.filename,
          pages: d.pages,
          chunks_count: d.chunks_count,
          retrieved_chunks: chunksByDocument.get(d.id)?.length ?? 0,
        })),
        comparison: compareResult.comparison,
        sources: allSources,
        prompt_preview: compareResult.promptPreview,
        context_stats: {
          original_chunks: compareResult.contextStats.originalChunks,
          optimized_chunks: compareResult.contextStats.optimizedChunks,
          context_chars: compareResult.contextStats.contextChars,
          max_context_chars: compareResult.contextStats.maxContextChars,
        },
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Inspect RAG retrieval pipeline
  app.post("/api/retrieval/inspect", async (req, res) => {
    const inlineError = validateNoInlineDocumentPayload(req.body);
    if (inlineError) {
      res.status(inlineError.status).json({ detail: inlineError.detail });
      return;
    }

    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    let documentIds: string[] | undefined;
    if (req.body?.document_ids !== undefined) {
      const checked = validateDocumentIdsList(req.body.document_ids, {
        min: 0,
        max: MAX_SCOPE_DOCUMENT_IDS,
        requireDistinct: false,
      });
      if (!checked.ok) {
        res.status(checked.status).json({ detail: checked.detail });
        return;
      }
      documentIds = checked.ids.length > 0 ? checked.ids : undefined;
    }
    const topK =
      typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
        ? req.body.top_k
        : DEFAULT_RAG_TOP_K;

    const requestId = crypto.randomUUID();
    const deadlineMs = Date.now() + VERCEL_REQUEST_DEADLINE_MS;

    try {
      const retrievalStart = Date.now();
      const [chunks, embeddingDims, totalChunks] = await Promise.all([
        ragEngine.retrieveChunks(question, topK, documentIds, {
          deadlineMs,
          requestId,
        }),
        ragEngine.getEmbeddingDimensions(),
        ragEngine.getTotalChunksCount(),
      ]);
      const retrievalDurationMs = Date.now() - retrievalStart;
      const ragResult = await generateRagAnswer(question, chunks, {
        deadlineMs,
        requestId,
        endpoint: "/api/retrieval/inspect",
        retrievalDurationMs,
      });
      res.json({
        question,
        chunks,
        prompt_preview: ragResult.promptPreview,
        answer: ragResult.answer,
        ai_provider: ragResult.provider,
        model: ragResult.model,
        embedding_model: getActiveEmbeddingModel(),
        embedding_dimensions: embeddingDims,
        total_chunks_indexed: totalChunks,
        top_k: topK,
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Chat history
  app.get("/api/chat/history", async (_req, res) => {
    try {
      res.json({ history: await ragEngine.getHistory() });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  app.delete("/api/chat/history", async (_req, res) => {
    try {
      await ragEngine.clearHistory();
      res.json({ cleared: true });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Dashboard statistics
  app.get("/api/dashboard/stats", async (_req, res) => {
    try {
      res.json(await ragEngine.getDashboardStats());
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // JSON 404 fallback for unmatched /api routes (does not intercept SPA routes)
  app.use("/api", (_req, res) => {
    res.status(404).json({ detail: "API endpoint not found." });
  });

  // Scoped JSON error handler for oversized payloads, malformed JSON, or unexpected Express errors on /api routes
  app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isPayloadTooLargeError(err)) {
      res.status(413).json({
        detail: `Request payload is too large (exceeds the ${Math.floor(JSON_BODY_MAX_BYTES / 1024)} KB JSON limit). Send uploaded document_ids instead of PDF files, base64 data, or extracted document text.`,
      });
      return;
    }
    if (
      err instanceof SyntaxError &&
      "status" in err &&
      (err as { status?: number }).status === 400
    ) {
      res.status(400).json({ detail: "Invalid JSON request body." });
      return;
    }
    const formatted = formatRouteError(err);
    res.status(formatted.status).json({ detail: formatted.message });
  });

  return app;
}

export const app = createApiApp();
