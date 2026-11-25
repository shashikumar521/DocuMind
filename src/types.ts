export type RoutePage =
  | "landing"
  | "dashboard"
  | "documents"
  | "chat"
  | "retrieval"
  | "compare"
  | "settings";

export type ProcessingStatus =
  | "Uploaded"
  | "Extracting Text"
  | "Chunking"
  | "Generating Embeddings"
  | "Indexing Vectors"
  | "Indexed Successfully"
  | "Failed";

export interface DocuMindDocument {
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

export interface RetrievedChunk {
  rank: number;
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  distance: number;
  similarity: number;
}

export interface ConversationTurn {
  id: string;
  question: string;
  answer: string;
  sources: RetrievedChunk[];
  created_at: string;
  prompt_preview?: string;
}

export interface DashboardStats {
  total_documents: number;
  indexed_documents: number;
  total_pages_processed: number;
  total_chunks_indexed: number;
  questions_answered: number;
  recent_documents: DocuMindDocument[];
  recent_conversations: ConversationTurn[];
}

export interface CompareResponse {
  question: string;
  ai_provider?: "cloudflare";
  model?: string;
  without_rag: {
    answer: string;
    ai_provider?: "cloudflare";
    model?: string;
  };
  with_rag: {
    answer: string;
    ai_provider?: "cloudflare";
    model?: string;
    sources: RetrievedChunk[];
    prompt_preview: string;
  };
}

export interface RetrievalInspectResponse {
  question: string;
  chunks: RetrievedChunk[];
  prompt_preview: string;
  answer: string;
  ai_provider?: "cloudflare";
  model?: string;
  embedding_model?: string;
  embedding_dimensions?: number | null;
  total_chunks_indexed?: number;
  top_k?: number;
}

export interface HealthStatus {
  status: string;
  app_status?: "ok" | "error";
  database_checked?: boolean;
  database_healthy?: boolean;
  backend: string;
  ai_provider: "cloudflare";
  chat_model: string;
  embedding_model: string;
  fallback_enabled: boolean;
  ai_configured: boolean;
  provider_status?: "reachable" | "unreachable" | "unconfigured";
  provider_connectivity?: {
    configured: boolean;
    checked: boolean;
    reachable: boolean;
    status: "reachable" | "unreachable" | "unconfigured";
    http_status?: number;
    detail?: string;
  };
  storage_mode?: string;
  vector_store: string;
  object_storage?: string;
  embedding_dimensions: number | null;
  documents_count: number;
  indexed_documents_count: number;
  chunks_count: number;
  chunk_size_tokens: number;
  chunk_overlap_tokens: number;
  storage_file: string;
}

export type ThemeMode = "light" | "dark" | "system";

export interface UserPreferences {
  theme: ThemeMode;
  autoIndex: boolean;
  includeCitations: boolean;
  topK: number;
  displayName: string;
  email: string;
}
