import crypto from "crypto";
import "dotenv/config";
import express, { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import {
  checkAiProviderConnectivity,
  formatAiError,
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
  ragEngine,
} from "./ragEngine.js";
import { DEFAULT_RAG_TOP_K } from "./ragPrompt.js";
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

function formatRouteError(err: unknown): { status: number; message: string } {
  if (err instanceof StorageConfigError) {
    return { status: err.statusCode, message: sanitizeDatabaseErrorMessage(err.message) };
  }
  const formatted = formatAiError(err);
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
      const [docs, chunksCount, embeddingDims, providerConnectivity] = await Promise.all([
        ragEngine.listDocuments(),
        ragEngine.getTotalChunksCount(),
        ragEngine.getEmbeddingDimensions(),
        providerConnectivityPromise,
      ]);
      const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
      const storageInfo = ragEngine.getStorageInfo();

      const overallStatus = providerConnectivity.reachable ? "ok" : "degraded";

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

    const documentIds = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.filter((id: unknown): id is string => typeof id === "string")
      : undefined;
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
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    const documentIds = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.filter((id: unknown): id is string => typeof id === "string")
      : undefined;
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

  // Inspect RAG retrieval pipeline
  app.post("/api/retrieval/inspect", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
      return;
    }

    const documentIds = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.filter((id: unknown): id is string => typeof id === "string")
      : undefined;
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
