import {
  CompareResponse,
  ConversationTurn,
  DashboardStats,
  DocumentCompareResponse,
  DocuMindDocument,
  HealthStatus,
  RetrievalInspectResponse,
  RetrievedChunk,
} from "./types";

const MAX_QUESTION_CHARS = 4_000;

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        if (res.status === 413) {
          throw new Error(
            "Request payload is too large (413). Compare uploaded documents by their document IDs rather than sending PDF files or full text."
          );
        }
        throw new Error(`Server error (${res.status}): ${text.slice(0, 200)}`);
      }
    }
  }
  if (!res.ok) {
    const detail =
      (typeof data.detail === "string" && data.detail) ||
      (typeof data.message === "string" && data.message) ||
      `Request failed with status ${res.status}`;
    throw new Error(detail);
  }
  return data as unknown as T;
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch("/api/health");
  return parseResponse(res);
}

export async function fetchDocuments(): Promise<DocuMindDocument[]> {
  const res = await fetch("/api/documents");
  const data = await parseResponse<{ documents: DocuMindDocument[] }>(res);
  return data.documents || [];
}

export async function uploadPdfFiles(files: File[]): Promise<{
  documents: DocuMindDocument[];
  errors?: { filename: string; detail: string }[];
}> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const res = await fetch("/api/documents/upload", {
    method: "POST",
    body: formData,
  });
  return parseResponse(res);
}

export async function deleteDocumentById(documentId: string): Promise<void> {
  const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
  });
  await parseResponse(res);
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await fetch("/api/dashboard/stats");
  return parseResponse(res);
}

export async function fetchChatHistory(): Promise<ConversationTurn[]> {
  const res = await fetch("/api/chat/history");
  const data = await parseResponse<{ history: ConversationTurn[] }>(res);
  return data.history || [];
}

export async function clearChatHistoryApi(): Promise<void> {
  const res = await fetch("/api/chat/history", { method: "DELETE" });
  await parseResponse(res);
}

export async function askChatQuestion(params: {
  question: string;
  documentIds?: string[];
  topK?: number;
}): Promise<{
  question: string;
  answer: string;
  sources: RetrievedChunk[];
  prompt_preview: string;
}> {
  const res = await fetch("/api/chat/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      document_ids: params.documentIds && params.documentIds.length > 0 ? params.documentIds : undefined,
      top_k: params.topK ?? 3,
    }),
  });
  return parseResponse(res);
}

export async function compareRagQuestion(params: {
  question: string;
  documentIds?: string[];
  topK?: number;
}): Promise<CompareResponse> {
  const question = params.question.trim();
  if (!question || question.length > MAX_QUESTION_CHARS) {
    throw new Error(
      `Comparison question must be between 1 and ${MAX_QUESTION_CHARS} characters (currently ${question.length}).`
    );
  }
  const cleanDocIds = Array.isArray(params.documentIds)
    ? Array.from(new Set(params.documentIds.map((id) => id.trim()).filter(Boolean)))
    : undefined;

  const res = await fetch("/api/chat/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      document_ids: cleanDocIds && cleanDocIds.length > 0 ? cleanDocIds : undefined,
      top_k: params.topK ?? 3,
    }),
  });
  return parseResponse(res);
}

export async function compareDocumentsByIds(params: {
  documentIds: string[];
  question?: string;
  topK?: number;
}): Promise<DocumentCompareResponse> {
  const cleanIds = Array.from(
    new Set(
      (params.documentIds || [])
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    )
  );
  if (cleanIds.length < 2) {
    throw new Error("Please select at least 2 distinct indexed documents to compare.");
  }
  if (cleanIds.length > 4) {
    throw new Error("You can compare at most 4 documents at once.");
  }

  const question = (params.question ?? "").trim();
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(
      `Comparison focus prompt must be under ${MAX_QUESTION_CHARS} characters (currently ${question.length}).`
    );
  }

  const res = await fetch("/api/documents/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_ids: cleanIds,
      question: question || undefined,
      top_k: params.topK ?? 4,
    }),
  });
  return parseResponse(res);
}

export async function inspectRetrievalPipeline(params: {
  question: string;
  documentIds?: string[];
  topK?: number;
}): Promise<RetrievalInspectResponse> {
  const res = await fetch("/api/retrieval/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      document_ids: params.documentIds && params.documentIds.length > 0 ? params.documentIds : undefined,
      top_k: params.topK ?? 3,
    }),
  });
  return parseResponse(res);
}
