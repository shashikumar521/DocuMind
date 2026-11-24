import crypto from "crypto";
import fs from "fs";
import path from "path";
import { extractText } from "unpdf";
import { generateEmbeddings, RetrievedChunkRef } from "./geminiClient.ts";

export type ProcessingStatus =
  | "Uploaded"
  | "Extracting Text"
  | "Chunking"
  | "Generating Embeddings"
  | "Indexing Vectors"
  | "Indexed Successfully"
  | "Failed";

export interface DocumentRecord {
  id: string;
  filename: string;
  size_bytes: number;
  pages: number;
  chunks_count: number;
  status: ProcessingStatus;
  progress: number;
  error_message: string | null;
  sha256: string;
  uploaded_at: string;
}

export interface StoredChunk {
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  token_count: number;
  embedding: number[];
}

export interface ConversationRecord {
  id: string;
  question: string;
  answer: string;
  sources: RetrievedChunkRef[];
  created_at: string;
}

interface PersistedStore {
  documents: Record<string, DocumentRecord>;
  chunks: StoredChunk[];
  conversations: ConversationRecord[];
  questions_answered: number;
}

export const CHUNK_SIZE_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 100;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const BASE_DATA_DIR = path.resolve(process.cwd(), "data");
const BASE_UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const STORE_PATH = path.resolve(BASE_DATA_DIR, "documind_store.json");

function ensureDirs() {
  if (!fs.existsSync(BASE_DATA_DIR)) fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  if (!fs.existsSync(BASE_UPLOAD_DIR)) fs.mkdirSync(BASE_UPLOAD_DIR, { recursive: true });
}

export function sanitizeFilename(rawName: string): string {
  const base = path.basename(rawName || "document.pdf");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "document.pdf";
}

function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function chunkPageText(
  text: string,
  pageNumber: number,
  documentId: string,
  filename: string
): Omit<StoredChunk, "embedding">[] {
  const words = tokenizeWords(text);
  if (words.length === 0) return [];

  const step = Math.max(1, CHUNK_SIZE_TOKENS - CHUNK_OVERLAP_TOKENS);
  const result: Omit<StoredChunk, "embedding">[] = [];
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
    if (idx + CHUNK_SIZE_TOKENS >= words.length) break;
    idx += step;
  }
  return result;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

class RagEngine {
  private store: PersistedStore;

  constructor() {
    ensureDirs();
    this.store = this.loadStore();
  }

  private loadStore(): PersistedStore {
    if (fs.existsSync(STORE_PATH)) {
      try {
        const raw = fs.readFileSync(STORE_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PersistedStore>;
        return {
          documents: parsed.documents ?? {},
          chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
          conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
          questions_answered: typeof parsed.questions_answered === "number" ? parsed.questions_answered : 0,
        };
      } catch {
        // Fallback to clean store if file is unreadable
      }
    }
    return {
      documents: {},
      chunks: [],
      conversations: [],
      questions_answered: 0,
    };
  }

  private saveStore(): void {
    ensureDirs();
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2), "utf-8");
    fs.renameSync(tmpPath, STORE_PATH);
  }

  listDocuments(): DocumentRecord[] {
    return Object.values(this.store.documents).sort((a, b) =>
      b.uploaded_at.localeCompare(a.uploaded_at)
    );
  }

  getDocument(documentId: string): DocumentRecord | null {
    return this.store.documents[documentId] ?? null;
  }

  getTotalChunksCount(): number {
    return this.store.chunks.length;
  }

  getEmbeddingDimensions(): number | null {
    const firstWithEmbedding = this.store.chunks.find(
      (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0
    );
    return firstWithEmbedding ? firstWithEmbedding.embedding.length : null;
  }

  private updateStatus(
    documentId: string,
    status: ProcessingStatus,
    progress: number,
    extra: Partial<Pick<DocumentRecord, "error_message" | "pages" | "chunks_count">> = {}
  ) {
    const doc = this.store.documents[documentId];
    if (!doc) return;
    doc.status = status;
    doc.progress = progress;
    if (extra.error_message !== undefined) doc.error_message = extra.error_message;
    if (extra.pages !== undefined) doc.pages = extra.pages;
    if (extra.chunks_count !== undefined) doc.chunks_count = extra.chunks_count;
    this.saveStore();
  }

  async processUploadedPdf(
    originalName: string,
    buffer: Buffer
  ): Promise<DocumentRecord> {
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

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    for (const existing of Object.values(this.store.documents)) {
      if (existing.sha256 === sha256 && existing.status === "Indexed Successfully") {
        throw new Error(
          `Duplicate document prevented: "${filename}" matches already indexed "${existing.filename}".`
        );
      }
    }

    const documentId = crypto.randomUUID();
    const safeDiskPath = path.resolve(BASE_UPLOAD_DIR, `${documentId}_${filename}`);
    if (!safeDiskPath.startsWith(BASE_UPLOAD_DIR + path.sep)) {
      throw new Error("Invalid file path.");
    }
    fs.writeFileSync(safeDiskPath, buffer);

    const record: DocumentRecord = {
      id: documentId,
      filename,
      size_bytes: buffer.length,
      pages: 0,
      chunks_count: 0,
      status: "Uploaded",
      progress: 10,
      error_message: null,
      sha256,
      uploaded_at: new Date().toISOString(),
    };
    this.store.documents[documentId] = record;
    this.saveStore();

    try {
      this.updateStatus(documentId, "Extracting Text", 25);
      const extracted = await extractText(new Uint8Array(buffer), { mergePages: false });
      const totalPages = extracted.totalPages || 0;
      const pageTexts = Array.isArray(extracted.text) ? extracted.text : [];

      if (totalPages === 0) {
        throw new Error("The uploaded PDF contains zero pages.");
      }

      const nonEmptyPages: { pageNum: number; text: string }[] = [];
      for (let i = 0; i < pageTexts.length; i++) {
        const cleaned = (pageTexts[i] ?? "").replace(/\s+/g, " ").trim();
        if (cleaned.length > 0) {
          nonEmptyPages.push({ pageNum: i + 1, text: cleaned });
        }
      }

      if (nonEmptyPages.length === 0) {
        throw new Error(
          "No extractable text found in PDF. Empty or image-only scanned PDFs cannot be indexed without OCR."
        );
      }

      this.updateStatus(documentId, "Chunking", 50, { pages: totalPages });
      const rawChunks: Omit<StoredChunk, "embedding">[] = [];
      for (const page of nonEmptyPages) {
        rawChunks.push(...chunkPageText(page.text, page.pageNum, documentId, filename));
      }

      if (rawChunks.length === 0) {
        throw new Error("No valid text chunks could be created from the PDF.");
      }

      this.updateStatus(documentId, "Generating Embeddings", 75);
      const vectors = await generateEmbeddings(rawChunks.map((c) => c.text));

      this.updateStatus(documentId, "Indexing Vectors", 90);
      const storedChunks: StoredChunk[] = rawChunks.map((c, idx) => ({
        ...c,
        embedding: vectors[idx],
      }));
      this.store.chunks.push(...storedChunks);

      this.updateStatus(documentId, "Indexed Successfully", 100, {
        pages: totalPages,
        chunks_count: storedChunks.length,
      });

      return this.store.documents[documentId];
    } catch (err: unknown) {
      if (fs.existsSync(safeDiskPath)) {
        try {
          fs.unlinkSync(safeDiskPath);
        } catch {
          // Ignore cleanup error
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to process PDF.";
      this.updateStatus(documentId, "Failed", 0, { error_message: msg });
      throw err;
    }
  }

  deleteDocument(documentId: string): boolean {
    const existing = this.store.documents[documentId];
    if (!existing) return false;
    delete this.store.documents[documentId];
    this.store.chunks = this.store.chunks.filter((c) => c.document_id !== documentId);
    const safeDiskPath = path.resolve(BASE_UPLOAD_DIR, `${documentId}_${existing.filename}`);
    if (safeDiskPath.startsWith(BASE_UPLOAD_DIR + path.sep) && fs.existsSync(safeDiskPath)) {
      try {
        fs.unlinkSync(safeDiskPath);
      } catch {
        // Ignore file removal error
      }
    }
    this.saveStore();
    return true;
  }

  async retrieveChunks(
    question: string,
    topK = 5,
    documentIds?: string[]
  ): Promise<RetrievedChunkRef[]> {
    const indexedIds = new Set(
      Object.values(this.store.documents)
        .filter((d) => d.status === "Indexed Successfully")
        .map((d) => d.id)
    );
    if (indexedIds.size === 0) return [];

    if (documentIds !== undefined && documentIds.length === 0) return [];

    const allowedIds =
      documentIds && documentIds.length > 0
        ? new Set(documentIds.filter((id) => indexedIds.has(id)))
        : indexedIds;

    const candidateChunks = this.store.chunks.filter((c) => allowedIds.has(c.document_id));
    if (candidateChunks.length === 0) return [];

    const [queryEmbedding] = await generateEmbeddings([question]);
    const scored = candidateChunks.map((chunk) => {
      const similarity = Math.max(0, Math.min(1, cosineSimilarity(queryEmbedding, chunk.embedding)));
      const distance = Math.max(0, 1 - similarity);
      return {
        chunk,
        similarity,
        distance,
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, Math.max(1, Math.min(15, topK))).map((item, idx) => ({
      rank: idx + 1,
      chunk_id: item.chunk.chunk_id,
      document_id: item.chunk.document_id,
      filename: item.chunk.filename,
      page_number: item.chunk.page_number,
      text: item.chunk.text,
      distance: Number(item.distance.toFixed(4)),
      similarity: Number(item.similarity.toFixed(4)),
    }));
  }

  recordQuestion(question: string, answer: string, sources: RetrievedChunkRef[]) {
    this.store.questions_answered += 1;
    this.store.conversations.unshift({
      id: crypto.randomUUID(),
      question,
      answer,
      sources,
      created_at: new Date().toISOString(),
    });
    this.store.conversations = this.store.conversations.slice(0, 50);
    this.saveStore();
  }

  getHistory(): ConversationRecord[] {
    return this.store.conversations;
  }

  clearHistory(): void {
    this.store.conversations = [];
    this.saveStore();
  }

  getDashboardStats() {
    const docs = this.listDocuments();
    const indexedDocs = docs.filter((d) => d.status === "Indexed Successfully");
    return {
      total_documents: docs.length,
      indexed_documents: indexedDocs.length,
      total_pages_processed: indexedDocs.reduce((sum, d) => sum + d.pages, 0),
      total_chunks_indexed: indexedDocs.reduce((sum, d) => sum + d.chunks_count, 0),
      questions_answered: this.store.questions_answered,
      recent_documents: docs.slice(0, 8),
      recent_conversations: this.store.conversations.slice(0, 5),
    };
  }
}

export const ragEngine = new RagEngine();
