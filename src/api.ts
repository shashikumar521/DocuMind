import {
  CompareResponse,
  ConversationTurn,
  DashboardStats,
  DocuMindDocument,
  HealthStatus,
  RetrievalInspectResponse,
  RetrievedChunk,
} from "./types";

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
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
      top_k: params.topK ?? 5,
    }),
  });
  return parseResponse(res);
}

export async function compareRagQuestion(params: {
  question: string;
  documentIds?: string[];
  topK?: number;
}): Promise<CompareResponse> {
  const res = await fetch("/api/chat/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      document_ids: params.documentIds && params.documentIds.length > 0 ? params.documentIds : undefined,
      top_k: params.topK ?? 5,
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
      top_k: params.topK ?? 5,
    }),
  });
  return parseResponse(res);
}
