import "dotenv/config";
import express from "express";
import multer from "multer";
import { formatGeminiError, GEMINI_EMBEDDING_MODEL, generateRagAnswer, generateWithoutRagAnswer, getGeminiChatModel, isGeminiConfigured, } from "./geminiClient.js";
import { CHUNK_OVERLAP_TOKENS, CHUNK_SIZE_TOKENS, ragEngine, } from "./ragEngine.js";
import { runWithBlobOidcContext, StorageConfigError } from "./storage.js";
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024,
        files: 10,
    },
});
function formatRouteError(err) {
    if (err instanceof StorageConfigError) {
        return { status: err.statusCode, message: err.message };
    }
    return formatGeminiError(err);
}
function extractOidcHeaderToken(req) {
    const raw = req.headers["x-vercel-oidc-token"];
    if (typeof raw === "string") {
        return raw.trim() || undefined;
    }
    if (Array.isArray(raw) && typeof raw[0] === "string") {
        return raw[0].trim() || undefined;
    }
    return undefined;
}
export function createApiApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use((req, _res, next) => {
        runWithBlobOidcContext(extractOidcHeaderToken(req), next);
    });
    app.use(express.json({ limit: "4mb" }));
    // Health & diagnostics endpoint
    app.get("/api/health", async (_req, res) => {
        try {
            await ragEngine.init();
            const [docs, chunksCount, embeddingDims] = await Promise.all([
                ragEngine.listDocuments(),
                ragEngine.getTotalChunksCount(),
                ragEngine.getEmbeddingDimensions(),
            ]);
            const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
            const storageInfo = ragEngine.getStorageInfo();
            res.json({
                status: "ok",
                backend: "node-express-rag",
                storage_mode: storageInfo.storage_mode,
                vector_store: storageInfo.vector_store,
                object_storage: storageInfo.object_storage,
                storage_file: storageInfo.storage_label,
                embedding_model: GEMINI_EMBEDDING_MODEL,
                embedding_dimensions: embeddingDims,
                gemini_model: getGeminiChatModel(),
                gemini_configured: isGeminiConfigured(),
                documents_count: docs.length,
                indexed_documents_count: indexedDocs.length,
                chunks_count: chunksCount,
                chunk_size_tokens: CHUNK_SIZE_TOKENS,
                chunk_overlap_tokens: CHUNK_OVERLAP_TOKENS,
            });
        }
        catch (err) {
            const formatted = formatRouteError(err);
            const storageInfo = ragEngine.getStorageInfo();
            res.status(formatted.status).json({
                status: "error",
                detail: formatted.message,
                backend: "node-express-rag",
                storage_mode: storageInfo.storage_mode,
                vector_store: storageInfo.vector_store,
                object_storage: storageInfo.object_storage,
                gemini_model: getGeminiChatModel(),
                gemini_configured: isGeminiConfigured(),
            });
        }
    });
    // List all documents
    app.get("/api/documents", async (_req, res) => {
        try {
            res.json({ documents: await ragEngine.listDocuments() });
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    // Upload & index PDF(s)
    app.post("/api/documents/upload", (req, res) => {
        const requestOidcToken = extractOidcHeaderToken(req);
        upload.array("files", 10)(req, res, (uploadErr) => {
            void runWithBlobOidcContext(requestOidcToken, async () => {
                if (uploadErr) {
                    const msg = uploadErr instanceof multer.MulterError && uploadErr.code === "LIMIT_FILE_SIZE"
                        ? "File exceeds the 25 MB upload limit."
                        : uploadErr instanceof Error
                            ? uploadErr.message
                            : "Upload validation failed.";
                    res.status(400).json({ detail: msg });
                    return;
                }
                const files = req.files || [];
                if (files.length === 0) {
                    res.status(400).json({ detail: "No PDF files were uploaded." });
                    return;
                }
                const processed = [];
                const errors = [];
                for (const file of files) {
                    try {
                        const doc = await ragEngine.processUploadedPdf(file.originalname, file.buffer);
                        processed.push(doc);
                    }
                    catch (err) {
                        const formatted = formatRouteError(err);
                        errors.push({
                            filename: file.originalname,
                            detail: formatted.message,
                        });
                    }
                }
                if (processed.length === 0 && errors.length > 0) {
                    let docsSnapshot = [];
                    try {
                        docsSnapshot = await ragEngine.listDocuments();
                    }
                    catch {
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
        }
        catch (err) {
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
            ? req.body.document_ids.filter((id) => typeof id === "string")
            : undefined;
        const topK = typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
            ? req.body.top_k
            : 5;
        try {
            const chunks = await ragEngine.retrieveChunks(question, topK, documentIds);
            const { answer, promptPreview } = await generateRagAnswer(question, chunks);
            await ragEngine.recordQuestion(question, answer, chunks);
            res.json({
                question,
                answer,
                sources: chunks,
                prompt_preview: promptPreview,
            });
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    // Side-by-side RAG vs Without RAG comparison
    const handleCompare = async (req, res) => {
        const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
        if (!question || question.length > 4000) {
            res.status(400).json({ detail: "Please provide a non-empty question under 4000 characters." });
            return;
        }
        const documentIds = Array.isArray(req.body?.document_ids)
            ? req.body.document_ids.filter((id) => typeof id === "string")
            : undefined;
        const topK = typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
            ? req.body.top_k
            : 5;
        try {
            const withoutRagPromise = generateWithoutRagAnswer(question).then((answer) => ({ ok: true, answer }), (err) => ({ ok: false, err }));
            const chunks = await ragEngine.retrieveChunks(question, topK, documentIds);
            const [withoutRagRes, withRagResult] = await Promise.all([
                withoutRagPromise,
                generateRagAnswer(question, chunks),
            ]);
            if (!withoutRagRes.ok) {
                throw withoutRagRes.err;
            }
            res.json({
                question,
                model: getGeminiChatModel(),
                without_rag: {
                    answer: withoutRagRes.answer,
                },
                with_rag: {
                    answer: withRagResult.answer,
                    sources: chunks,
                    prompt_preview: withRagResult.promptPreview,
                },
            });
        }
        catch (err) {
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
            ? req.body.document_ids.filter((id) => typeof id === "string")
            : undefined;
        const topK = typeof req.body?.top_k === "number" && req.body.top_k >= 1 && req.body.top_k <= 15
            ? req.body.top_k
            : 5;
        try {
            const [chunks, embeddingDims, totalChunks] = await Promise.all([
                ragEngine.retrieveChunks(question, topK, documentIds),
                ragEngine.getEmbeddingDimensions(),
                ragEngine.getTotalChunksCount(),
            ]);
            const { answer, promptPreview } = await generateRagAnswer(question, chunks);
            res.json({
                question,
                chunks,
                prompt_preview: promptPreview,
                answer,
                model: getGeminiChatModel(),
                embedding_model: GEMINI_EMBEDDING_MODEL,
                embedding_dimensions: embeddingDims,
                total_chunks_indexed: totalChunks,
                top_k: topK,
            });
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    // Chat history
    app.get("/api/chat/history", async (_req, res) => {
        try {
            res.json({ history: await ragEngine.getHistory() });
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    app.delete("/api/chat/history", async (_req, res) => {
        try {
            await ragEngine.clearHistory();
            res.json({ cleared: true });
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    // Dashboard statistics
    app.get("/api/dashboard/stats", async (_req, res) => {
        try {
            res.json(await ragEngine.getDashboardStats());
        }
        catch (err) {
            const formatted = formatRouteError(err);
            res.status(formatted.status).json({ detail: formatted.message });
        }
    });
    return app;
}
export const app = createApiApp();
