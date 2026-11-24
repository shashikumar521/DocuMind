import crypto from "crypto";
import path from "path";
import { extractText, getDocumentProxy } from "unpdf";
import { generateEmbeddings } from "./geminiClient.js";
import { getStorageAdapter, } from "./storage.js";
export const CHUNK_SIZE_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 100;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export function sanitizeFilename(rawName) {
    const base = path.basename(rawName || "document.pdf");
    const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned || "document.pdf";
}
function tokenizeWords(text) {
    return text.trim().split(/\s+/).filter(Boolean);
}
function chunkPageText(text, pageNumber, documentId, filename) {
    const words = tokenizeWords(text);
    if (words.length === 0)
        return [];
    const step = Math.max(1, CHUNK_SIZE_TOKENS - CHUNK_OVERLAP_TOKENS);
    const result = [];
    let idx = 0;
    let chunkIndex = 0;
    while (idx < words.length) {
        const window = words.slice(idx, idx + CHUNK_SIZE_TOKENS);
        const chunkText = window.join(" ").trim();
        if (chunkText.length > 0) {
            result.push({
                chunk_id: `${documentId}_p${pageNumber}_c${chunkIndex}`,
                document_id: documentId,
                filename,
                page_number: pageNumber,
                text: chunkText,
                token_count: window.length,
            });
            chunkIndex += 1;
        }
        if (idx + CHUNK_SIZE_TOKENS >= words.length)
            break;
        idx += step;
    }
    return result;
}
class RagEngine {
    get storage() {
        return getStorageAdapter();
    }
    async init() {
        await this.storage.init();
    }
    getStorageInfo() {
        return this.storage.getInfo();
    }
    async listDocuments() {
        return this.storage.listDocuments();
    }
    async getDocument(documentId) {
        return this.storage.getDocument(documentId);
    }
    async getDocumentBinary(documentId) {
        const doc = await this.storage.getDocument(documentId);
        if (!doc)
            return null;
        const binary = await this.storage.getPdfBinary(doc);
        if (!binary)
            return null;
        return { doc, ...binary };
    }
    async getTotalChunksCount() {
        return this.storage.getTotalChunksCount();
    }
    async getEmbeddingDimensions() {
        return this.storage.getEmbeddingDimensions();
    }
    async updateStatus(documentId, status, progress, extra = {}) {
        await this.storage.updateDocument(documentId, {
            status,
            progress,
            ...extra,
        });
    }
    async processUploadedPdf(originalName, buffer) {
        const filename = sanitizeFilename(originalName);
        if (!filename.toLowerCase().endsWith(".pdf")) {
            throw new Error(`"${filename}" is an unsupported file type. Only PDF files are accepted.`);
        }
        if (buffer.length === 0) {
            throw new Error(`"${filename}" is empty (0 bytes).`);
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
            throw new Error(`"${filename}" exceeds the 25 MB upload size limit.`);
        }
        if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") {
            throw new Error(`"${filename}" is not a valid PDF document.`);
        }
        await this.storage.init();
        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
        const existing = await this.storage.findIndexedBySha256(sha256);
        if (existing) {
            throw new Error(`Duplicate document prevented: "${filename}" matches already indexed "${existing.filename}".`);
        }
        const documentId = crypto.randomUUID();
        const binaryRef = await this.storage.savePdfBinary(documentId, filename, buffer);
        const record = {
            id: documentId,
            filename,
            size_bytes: buffer.length,
            pages: 0,
            chunks_count: 0,
            status: "Uploaded",
            progress: 10,
            error_message: null,
            sha256,
            blob_url: binaryRef.blobUrl,
            blob_pathname: binaryRef.blobPathname,
            uploaded_at: new Date().toISOString(),
        };
        await this.storage.insertDocument(record);
        try {
            await this.updateStatus(documentId, "Extracting Text", 25);
            const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
            let extracted;
            try {
                extracted = await extractText(pdf, { mergePages: false });
            }
            finally {
                await pdf.loadingTask?.destroy?.();
            }
            const totalPages = extracted.totalPages || 0;
            const pageTexts = Array.isArray(extracted.text) ? extracted.text : [];
            if (totalPages === 0) {
                throw new Error("The uploaded PDF contains zero pages.");
            }
            const nonEmptyPages = [];
            for (let i = 0; i < pageTexts.length; i++) {
                const cleaned = (pageTexts[i] ?? "").replace(/\s+/g, " ").trim();
                if (cleaned.length > 0) {
                    nonEmptyPages.push({ pageNum: i + 1, text: cleaned });
                }
            }
            if (nonEmptyPages.length === 0) {
                throw new Error("No extractable text found in PDF. Empty or image-only scanned PDFs cannot be indexed without OCR.");
            }
            await this.updateStatus(documentId, "Chunking", 50, { pages: totalPages });
            const rawChunks = [];
            for (const page of nonEmptyPages) {
                rawChunks.push(...chunkPageText(page.text, page.pageNum, documentId, filename));
            }
            if (rawChunks.length === 0) {
                throw new Error("No valid text chunks could be created from the PDF.");
            }
            await this.updateStatus(documentId, "Generating Embeddings", 75);
            const vectors = await generateEmbeddings(rawChunks.map((c) => c.text));
            await this.updateStatus(documentId, "Indexing Vectors", 90);
            const storedChunks = rawChunks.map((c, idx) => ({
                ...c,
                embedding: vectors[idx],
            }));
            await this.storage.insertChunks(storedChunks);
            await this.updateStatus(documentId, "Indexed Successfully", 100, {
                pages: totalPages,
                chunks_count: storedChunks.length,
            });
            const updated = await this.storage.getDocument(documentId);
            return updated ?? {
                ...record,
                status: "Indexed Successfully",
                progress: 100,
                pages: totalPages,
                chunks_count: storedChunks.length,
            };
        }
        catch (err) {
            await this.storage.deletePdfBinary(documentId, filename, binaryRef.blobUrl);
            const msg = err instanceof Error ? err.message : "Failed to process PDF.";
            await this.updateStatus(documentId, "Failed", 0, {
                error_message: msg,
                blob_url: null,
                blob_pathname: null,
            });
            throw err;
        }
    }
    async deleteDocument(documentId) {
        const result = await this.storage.deleteDocument(documentId);
        if (!result.deleted)
            return false;
        await this.storage.deletePdfBinary(documentId, result.filename || "document.pdf", result.blobUrl);
        return true;
    }
    async retrieveChunks(question, topK = 5, documentIds) {
        const [queryEmbedding] = await generateEmbeddings([question]);
        return this.storage.searchSimilarChunks(queryEmbedding, topK, documentIds);
    }
    async recordQuestion(question, answer, sources) {
        const entry = {
            id: crypto.randomUUID(),
            question,
            answer,
            sources,
            created_at: new Date().toISOString(),
        };
        await this.storage.recordConversation(entry);
        return entry;
    }
    async getHistory() {
        return this.storage.getHistory();
    }
    async clearHistory() {
        await this.storage.clearHistory();
    }
    async getDashboardStats() {
        const [docs, totalChunks, history, questionsAnswered] = await Promise.all([
            this.storage.listDocuments(),
            this.storage.getTotalChunksCount(),
            this.storage.getHistory(),
            this.storage.getQuestionsAnswered(),
        ]);
        const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
        const totalPages = indexedDocs.reduce((sum, d) => sum + (d.pages || 0), 0);
        return {
            total_documents: docs.length,
            indexed_documents: indexedDocs.length,
            total_pages_processed: totalPages,
            total_chunks_indexed: totalChunks,
            questions_answered: questionsAnswered,
            recent_documents: docs.slice(0, 6),
            recent_conversations: history.slice(-6).reverse(),
        };
    }
}
export const ragEngine = new RagEngine();
