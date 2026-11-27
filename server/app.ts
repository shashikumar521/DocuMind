import crypto from "crypto";
import "dotenv/config";
import express, { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import {
  AiBranch,
  CF_COMPARE_NO_RAG_SYSTEM_INSTRUCTION,
  CF_COMPARE_RAG_SYSTEM_INSTRUCTION,
  checkAiProviderConnectivity,
  CloudflareConfigError,
  formatAiError,
  generateRagAnswer,
  generateWithoutRagAnswerWithMeta,
  getActiveAiProvider,
  getActiveChatModel,
  getActiveEmbeddingModel,
  getCompareAttemptTimeoutMs,
  getCompareTotalBudgetMs,
  isAiConfigured,
  RetrievedChunkRef,
  VERCEL_REQUEST_DEADLINE_MS,
} from "./aiClient.js";
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_TOKENS,
  ragEngine,
} from "./ragEngine.js";
import {
  COMPARE_COMPACT_MAX_CHUNK_CHARS,
  COMPARE_COMPACT_MAX_CHUNKS,
  COMPARE_COMPACT_MAX_CONTEXT_CHARS,
  COMPARE_COMPACT_MAX_OUTPUT_TOKENS,
  COMPARE_MAX_TOP_K,
  COMPARE_NO_RAG_COMPACT_MAX_OUTPUT_TOKENS,
  COMPARE_NO_RAG_MAX_OUTPUT_TOKENS,
  COMPARE_RAG_MAX_CHUNK_CHARS,
  COMPARE_RAG_MAX_CHUNKS,
  COMPARE_RAG_MAX_CONTEXT_CHARS,
  COMPARE_RAG_MAX_OUTPUT_TOKENS,
  DEFAULT_RAG_TOP_K,
} from "./ragPrompt.js";
import {
  runWithBlobOidcContext,
  sanitizeDatabaseErrorMessage,
  StorageConfigError,
} from "./storage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

function formatRouteError(
  err: unknown,
  options: { branch?: AiBranch } = {}
): { status: number; message: string } {
  if (err instanceof StorageConfigError) {
    return { status: err.statusCode, message: sanitizeDatabaseErrorMessage(err.message) };
  }
  const formatted = formatAiError(err, options);
  return {
    status: formatted.status,
    message: sanitizeDatabaseErrorMessage(formatted.message),
  };
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

function parseDocumentIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = Array.from(
    new Set(
      raw
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

export function createApiApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    runWithBlobOidcContext(extractOidcHeaderToken(req), next);
  });
  app.use(express.json({ limit: "4mb" }));

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
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    const documentIds = parseDocumentIds(req.body?.document_ids);
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
        endpoint: "/api/chat/ask",
        branch: "chat",
        retrievalDurationMs,
      });
      await ragEngine.recordQuestion(question, ragResult.answer, chunks);
      res.json({
        request_id: requestId,
        question,
        document_ids: documentIds ?? [],
        top_k: topK,
        ai_provider: ragResult.provider,
        model: ragResult.model,
        embedding_model: getActiveEmbeddingModel(),
        embedding_dimensions: embeddingDims,
        total_chunks_indexed: totalChunks,
        answer: ragResult.answer,
        sources: chunks,
        prompt_preview: ragResult.promptPreview,
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err, { branch: "chat" });
      res.status(formatted.status).json({ detail: formatted.message });
    }
  });

  // Side-by-side RAG vs Without RAG comparison
  const handleCompare = async (req: Request, res: Response) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    const documentIds = parseDocumentIds(req.body?.document_ids);
    const requestedTopK =
      typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
        ? req.body.top_k
        : DEFAULT_RAG_TOP_K;
    const effectiveTopK = Math.min(requestedTopK, COMPARE_MAX_TOP_K);

    const requestId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    const totalBudgetMs = getCompareTotalBudgetMs();
    const attemptTimeoutMs = getCompareAttemptTimeoutMs();
    const compareDeadlineMs = Math.min(
      requestStartedAt + VERCEL_REQUEST_DEADLINE_MS,
      requestStartedAt + totalBudgetMs
    );
    const activeProvider = getActiveAiProvider();
    const activeChatModel = getActiveChatModel();
    let retrievedChunks: RetrievedChunkRef[] = [];

    try {
      const retrievalStart = Date.now();

      // Start the ungrounded Without-RAG call concurrently with retrieval without cross-canceling
      // the sibling branch if one side fails, enabling safe partial-branch recovery.
      const withoutRagPromise = generateWithoutRagAnswerWithMeta(question, {
        totalBudgetMs,
        attemptTimeoutMs,
        deadlineMs: compareDeadlineMs,
        requestId,
        endpoint: req.path,
        branch: "without_rag",
        maxTokens: COMPARE_NO_RAG_MAX_OUTPUT_TOKENS,
        compactMaxTokens: COMPARE_NO_RAG_COMPACT_MAX_OUTPUT_TOKENS,
        systemInstruction: CF_COMPARE_NO_RAG_SYSTEM_INSTRUCTION,
        promptTag: "compare-no-rag",
      });

      const withRagChainPromise = ragEngine
        .retrieveChunks(question, effectiveTopK, documentIds, {
          deadlineMs: compareDeadlineMs,
          requestId,
        })
        .then(async (chunks) => {
          retrievedChunks = chunks;
          const retrievalDurationMs = Date.now() - retrievalStart;
          const withRagResult = await generateRagAnswer(question, chunks, {
            totalBudgetMs,
            attemptTimeoutMs,
            deadlineMs: compareDeadlineMs,
            requestId,
            endpoint: req.path,
            branch: "with_rag",
            retrievalDurationMs,
            maxTokens: COMPARE_RAG_MAX_OUTPUT_TOKENS,
            compactMaxTokens: COMPARE_COMPACT_MAX_OUTPUT_TOKENS,
            promptOptions: {
              maxChunks: COMPARE_RAG_MAX_CHUNKS,
              maxChunkChars: COMPARE_RAG_MAX_CHUNK_CHARS,
              maxContextChars: COMPARE_RAG_MAX_CONTEXT_CHARS,
            },
            compactPromptOptions: {
              maxChunks: COMPARE_COMPACT_MAX_CHUNKS,
              maxChunkChars: COMPARE_COMPACT_MAX_CHUNK_CHARS,
              maxContextChars: COMPARE_COMPACT_MAX_CONTEXT_CHARS,
            },
            systemInstruction: CF_COMPARE_RAG_SYSTEM_INSTRUCTION,
            promptTag: "compare-rag",
          });
          return { chunks, withRagResult };
        });

      const [withoutSettled, withSettled] = await Promise.allSettled([
        withoutRagPromise,
        withRagChainPromise,
      ]);

      if (withoutSettled.status === "rejected" && withSettled.status === "rejected") {
        const withoutFormatted = formatRouteError(withoutSettled.reason, { branch: "without_rag" });
        const withFormatted = formatRouteError(withSettled.reason, { branch: "with_rag" });
        const primaryError =
          withFormatted.status !== 504 ? withFormatted : withoutFormatted;
        res.status(primaryError.status).json({ detail: primaryError.message });
        return;
      }

      if (withoutSettled.status === "rejected") {
        const errInfo = formatRouteError(withoutSettled.reason, { branch: "without_rag" });
        if (
          errInfo.status === 403 ||
          withoutSettled.reason instanceof StorageConfigError ||
          withoutSettled.reason instanceof CloudflareConfigError
        ) {
          res.status(errInfo.status).json({ detail: errInfo.message });
          return;
        }
      }

      if (withSettled.status === "rejected") {
        const errInfo = formatRouteError(withSettled.reason, { branch: "with_rag" });
        if (
          errInfo.status === 403 ||
          withSettled.reason instanceof StorageConfigError ||
          withSettled.reason instanceof CloudflareConfigError
        ) {
          res.status(errInfo.status).json({ detail: errInfo.message });
          return;
        }
      }

      const withoutBranch =
        withoutSettled.status === "fulfilled"
          ? {
              status: (withoutSettled.value.truncated ? "truncated" : "completed") as
                | "completed"
                | "truncated",
              answer: withoutSettled.value.answer,
              ai_provider: withoutSettled.value.provider,
              model: withoutSettled.value.model,
              finish_reason: withoutSettled.value.finishReason,
              truncated: withoutSettled.value.truncated,
            }
          : (() => {
              const formatted = formatRouteError(withoutSettled.reason, { branch: "without_rag" });
              return {
                status: "error" as const,
                answer: "",
                ai_provider: activeProvider,
                model: activeChatModel,
                finish_reason: null,
                truncated: false,
                error: formatted.message,
                timed_out: formatted.status === 504,
              };
            })();

      const withBranch =
        withSettled.status === "fulfilled"
          ? {
              status: (withSettled.value.withRagResult.truncated ? "truncated" : "completed") as
                | "completed"
                | "truncated",
              answer: withSettled.value.withRagResult.answer,
              ai_provider: withSettled.value.withRagResult.provider,
              model: withSettled.value.withRagResult.model,
              finish_reason: withSettled.value.withRagResult.finishReason,
              truncated: withSettled.value.withRagResult.truncated,
              sources: withSettled.value.chunks,
              prompt_preview: withSettled.value.withRagResult.promptPreview,
            }
          : (() => {
              const formatted = formatRouteError(withSettled.reason, { branch: "with_rag" });
              return {
                status: "error" as const,
                answer: "",
                ai_provider: activeProvider,
                model: activeChatModel,
                finish_reason: null,
                truncated: false,
                error: formatted.message,
                timed_out: formatted.status === 504,
                sources: retrievedChunks,
                prompt_preview: "",
              };
            })();

      const hasBranchError =
        withoutBranch.status === "error" || withBranch.status === "error";
      const hasTruncation =
        withoutBranch.status === "truncated" || withBranch.status === "truncated";

      res.json({
        request_id: requestId,
        question,
        document_ids: documentIds ?? [],
        top_k: effectiveTopK,
        ai_provider: activeProvider,
        model: activeChatModel,
        partial: hasBranchError,
        status: hasBranchError || hasTruncation ? "partial" : "completed",
        without_rag: withoutBranch,
        with_rag: withBranch,
      });
    } catch (err: unknown) {
      const formatted = formatRouteError(err);
      res.status(formatted.status).json({ detail: formatted.message });
    }
  };

  app.post("/api/chat/compare", handleCompare);
  app.post("/api/rag/compare", handleCompare);

  // Inspect RAG retrieval pipeline
  app.post("/api/retrieval/inspect", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    const documentIds = parseDocumentIds(req.body?.document_ids);
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
        branch: "inspect",
        retrievalDurationMs,
      });
      res.json({
        request_id: requestId,
        question,
        document_ids: documentIds ?? [],
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
      const formatted = formatRouteError(err, { branch: "inspect" });
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

  // Scoped JSON error handler for malformed JSON bodies or unexpected Express errors on /api routes
  app.use("/api", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
