import "dotenv/config";
import express, { Request, Response } from "express";
import multer from "multer";
import path from "path";
import { createServer as createViteServer } from "vite";
import {
  formatGeminiError,
  GEMINI_EMBEDDING_MODEL,
  generateRagAnswer,
  generateWithoutRagAnswer,
  getGeminiChatModel,
  isGeminiConfigured,
} from "./server/geminiClient.ts";
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_TOKENS,
  ragEngine,
} from "./server/ragEngine.ts";

const PORT = 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

async function startServer() {
  const app = express();

  app.use(express.json({ limit: "4mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    const docs = ragEngine.listDocuments();
    const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
    res.json({
      status: "ok",
      backend: "node-express-rag",
      vector_store: "json-disk-vector-store",
      embedding_model: GEMINI_EMBEDDING_MODEL,
      embedding_dimensions: ragEngine.getEmbeddingDimensions(),
      gemini_model: getGeminiChatModel(),
      gemini_configured: isGeminiConfigured(),
      documents_count: docs.length,
      indexed_documents_count: indexedDocs.length,
      chunks_count: ragEngine.getTotalChunksCount(),
      chunk_size_tokens: CHUNK_SIZE_TOKENS,
      chunk_overlap_tokens: CHUNK_OVERLAP_TOKENS,
      storage_file: "data/documind_store.json",
    });
  });

    // List all documents
    app.get("/api/documents", (_req, res) => {
      res.json({ documents: ragEngine.listDocuments() });
    });

    // Get single document
    app.get("/api/documents/:documentId", (req, res) => {
      const doc = ragEngine.getDocument(req.params.documentId);
      if (!doc) {
        res.status(404).json({ detail: "Document not found." });
        return;
      }
      res.json({ document: doc });
    });

    // Upload & index PDF(s)
    app.post("/api/documents/upload", (req, res) => {
      upload.array("files", 10)(req, res, async (uploadErr: unknown) => {
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
            const formatted = formatGeminiError(err);
            errors.push({
              filename: file.originalname,
              detail: formatted.message,
            });
          }
        }

        if (processed.length === 0 && errors.length > 0) {
          res.status(400).json({
            detail: errors.map((e) => `${e.filename}: ${e.detail}`).join(" | "),
            errors,
            documents: ragEngine.listDocuments(),
          });
          return;
        }

        res.status(errors.length > 0 ? 207 : 200).json({
          documents: processed,
          errors,
        });
      });
    });

    // Delete document and associated vectors
    app.delete("/api/documents/:documentId", (req, res) => {
      const deleted = ragEngine.deleteDocument(req.params.documentId);
      if (!deleted) {
        res.status(404).json({ detail: "Document not found." });
        return;
      }
      res.json({ deleted: true, document_id: req.params.documentId });
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
          : 5;

      try {
        const chunks = await ragEngine.retrieveChunks(question, topK, documentIds);
        const { answer, promptPreview } = await generateRagAnswer(question, chunks);
        ragEngine.recordQuestion(question, answer, chunks);
        res.json({
          question,
          answer,
          sources: chunks,
          prompt_preview: promptPreview,
        });
      } catch (err: unknown) {
        const formatted = formatGeminiError(err);
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
          : 5;

      try {
        const chunks = await ragEngine.retrieveChunks(question, topK, documentIds);
        const withoutRag = await generateWithoutRagAnswer(question);
        const withRagResult = await generateRagAnswer(question, chunks);
        res.json({
          question,
          model: getGeminiChatModel(),
          without_rag: {
            answer: withoutRag,
          },
          with_rag: {
            answer: withRagResult.answer,
            sources: chunks,
            prompt_preview: withRagResult.promptPreview,
          },
        });
      } catch (err: unknown) {
        const formatted = formatGeminiError(err);
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
          : 5;

      try {
        const chunks = await ragEngine.retrieveChunks(question, topK, documentIds);
        const { answer, promptPreview } = await generateRagAnswer(question, chunks);
        res.json({
          question,
          chunks,
          prompt_preview: promptPreview,
          answer,
          model: getGeminiChatModel(),
          embedding_model: GEMINI_EMBEDDING_MODEL,
          embedding_dimensions: ragEngine.getEmbeddingDimensions(),
          total_chunks_indexed: ragEngine.getTotalChunksCount(),
          top_k: topK,
        });
      } catch (err: unknown) {
        const formatted = formatGeminiError(err);
        res.status(formatted.status).json({ detail: formatted.message });
      }
    });

    // Chat history
    app.get("/api/chat/history", (_req, res) => {
      res.json({ history: ragEngine.getHistory() });
    });

    app.delete("/api/chat/history", (_req, res) => {
      ragEngine.clearHistory();
      res.json({ cleared: true });
    });

    // Dashboard statistics
    app.get("/api/dashboard/stats", (_req, res) => {
      res.json(ragEngine.getDashboardStats());
    });

  // Vite middleware in development, static dist/ in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`DocuMind server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
