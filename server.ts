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
import { ragEngine } from "./server/ragEngine.ts";

const PORT = 3000;
const FASTAPI_BACKEND_URL = process.env.FASTAPI_BACKEND_URL?.trim().replace(/\/$/, "");
const FASTAPI_PROBE_TTL_MS = 5000;

let cachedFastApiProbe: { checkedAt: number; active: boolean; reason: string } | null = null;

async function probeFastApiBackend(): Promise<{ active: boolean; reason: string }> {
  if (!FASTAPI_BACKEND_URL) {
    return { active: false, reason: "FASTAPI_BACKEND_URL is not configured." };
  }
  const now = Date.now();
  if (cachedFastApiProbe && now - cachedFastApiProbe.checkedAt < FASTAPI_PROBE_TTL_MS) {
    return { active: cachedFastApiProbe.active, reason: cachedFastApiProbe.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${FASTAPI_BACKEND_URL}/api/health`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const reason = `FASTAPI_BACKEND_URL (${FASTAPI_BACKEND_URL}) returned HTTP ${res.status} instead of a python-fastapi health check.`;
      cachedFastApiProbe = { checkedAt: now, active: false, reason };
      return { active: false, reason };
    }
    const data = (await res.json().catch(() => null)) as { backend?: string } | null;
    if (data?.backend !== "python-fastapi") {
      const reason = `Target at ${FASTAPI_BACKEND_URL} did not identify as backend="python-fastapi".`;
      cachedFastApiProbe = { checkedAt: now, active: false, reason };
      return { active: false, reason };
    }
    const reason = `Connected to python-fastapi at ${FASTAPI_BACKEND_URL}.`;
    cachedFastApiProbe = { checkedAt: now, active: true, reason };
    return { active: true, reason };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Connection failed.";
    const reason = `FASTAPI_BACKEND_URL (${FASTAPI_BACKEND_URL}) unreachable: ${msg}`;
    cachedFastApiProbe = { checkedAt: now, active: false, reason };
    return { active: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function startServer() {
  const app = express();

  // Optional proxy to standalone Python FastAPI + ChromaDB + SentenceTransformers backend
  // Only proxies when FASTAPI_BACKEND_URL responds as backend="python-fastapi"
  app.use("/api", async (req: Request, res: Response, next) => {
    if (!FASTAPI_BACKEND_URL) {
      next();
      return;
    }
    const probe = await probeFastApiBackend();
    if (!probe.active) {
      next();
      return;
    }
    try {
      const targetUrl = `${FASTAPI_BACKEND_URL}/api${req.url}`;
      const headers: Record<string, string> = {};
      if (req.headers["content-type"]) {
        headers["content-type"] = String(req.headers["content-type"]);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const rawBody = hasBody ? await readRawBody(req) : undefined;
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: rawBody ? new Uint8Array(rawBody) : undefined,
      });
      const arrayBuf = await upstream.arrayBuffer();
      res.status(upstream.status);
      res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
      res.send(Buffer.from(arrayBuf));
    } catch (err: unknown) {
      cachedFastApiProbe = null;
      const msg = err instanceof Error ? err.message : "FastAPI backend unreachable.";
      res.status(502).json({ detail: `FastAPI proxy error: ${msg}` });
    }
  });

  app.use(express.json({ limit: "4mb" }));

  // Health check
  app.get("/api/health", async (_req, res) => {
    const probe = await probeFastApiBackend();
    res.json({
      status: "ok",
      backend: "node-express-rag",
      vector_store: "json-disk-vector-store",
      embedding_model: GEMINI_EMBEDDING_MODEL,
      gemini_model: getGeminiChatModel(),
      env_gemini_model: process.env.GEMINI_MODEL?.trim() || null,
      gemini_configured: isGeminiConfigured(),
      chunks_count: ragEngine.getTotalChunksCount(),
      fastapi_proxy_configured: Boolean(FASTAPI_BACKEND_URL),
      fastapi_proxy_active: probe.active,
      fastapi_proxy_note: probe.reason,
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
        const [withoutRag, withRagResult] = await Promise.all([
          generateWithoutRagAnswer(question),
          generateRagAnswer(question, chunks),
        ]);
        res.json({
          question,
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
