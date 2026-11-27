import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  Binary,
  Cpu,
  Database,
  FileText,
  Layers,
  Loader2,
  MessageSquareText,
  Search,
} from "lucide-react";
import { fetchDocuments, fetchHealth, inspectRetrievalPipeline } from "../api";
import { AppShell } from "../components/AppShell";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastProvider";
import {
  DocuMindDocument,
  HealthStatus,
  RetrievalInspectResponse,
  RoutePage,
  UserPreferences,
} from "../types";

interface RetrievalSourcesProps {
  onNavigate: (page: RoutePage) => void;
  initialQuery?: string;
  latestTrace?: RetrievalInspectResponse | null;
  onRecordTrace?: (trace: RetrievalInspectResponse) => void;
  selectedDocIds?: string[];
  onChangeSelectedDocIds?: (ids: string[]) => void;
  preferences: UserPreferences;
}

const PIPELINE_STEPS: {
  id: string;
  num: string;
  title: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "ingest", num: "01", title: "PDF Ingestion", sub: "Validated binary", icon: FileText },
  { id: "extract", num: "02", title: "Text Extraction", sub: "Per-page parsing", icon: Layers },
  { id: "chunk", num: "03", title: "Chunking", sub: "Overlap window", icon: Cpu },
  { id: "embed", num: "04", title: "Embedding Gen", sub: "Dense vectors", icon: Binary },
  { id: "store", num: "05", title: "Vector Storage", sub: "PostgreSQL + Blob", icon: Database },
  { id: "retrieve", num: "06", title: "Similarity Search", sub: "Cosine Top-K", icon: Search },
  { id: "generate", num: "07", title: "LLM Response", sub: "Cited synthesis", icon: MessageSquareText },
];

export const RetrievalSources: React.FC<RetrievalSourcesProps> = ({
  onNavigate,
  initialQuery = "",
  latestTrace = null,
  onRecordTrace,
  selectedDocIds = [],
  onChangeSelectedDocIds,
  preferences,
}) => {
  const [query, setQuery] = useState(latestTrace?.question || initialQuery);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetrievalInspectResponse | null>(latestTrace);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [documents, setDocuments] = useState<DocuMindDocument[]>([]);
  const [inspectorDocIds, setInspectorDocIds] = useState<string[]>(() =>
    latestTrace?.document_ids && latestTrace.document_ids.length > 0
      ? latestTrace.document_ids
      : selectedDocIds
  );
  const { pushToast } = useToast();

  const indexedDocs = documents.filter((d) => d.status === "Indexed Successfully");

  const loadHealth = () => {
    fetchHealth()
      .then(setHealth)
      .catch(() => {});
  };

  useEffect(() => {
    loadHealth();
    fetchDocuments()
      .then((docs) => {
        setDocuments(docs);
        const validSet = new Set(
          docs.filter((d) => d.status === "Indexed Successfully").map((d) => d.id)
        );
        setInspectorDocIds((prev) => prev.filter((id) => validSet.has(id)));
      })
      .catch(() => {});
  }, []);

  const runInspect = async (qText: string, overrideDocIds?: string[]) => {
    const trimmed = qText.trim();
    if (!trimmed) return;
    const scopeIds = overrideDocIds !== undefined ? overrideDocIds : inspectorDocIds;
    setLoading(true);
    setError(null);
    try {
      const data = await inspectRetrievalPipeline({
        question: trimmed,
        documentIds: scopeIds.length > 0 ? scopeIds : undefined,
        topK: preferences.topK,
      });
      setResult(data);
      onRecordTrace?.(data);
      loadHealth();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to inspect retrieval pipeline.";
      setError(msg);
      pushToast({ kind: "error", title: "Inspection failed", description: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (latestTrace) {
      setResult(latestTrace);
      setQuery(latestTrace.question);
      if (latestTrace.document_ids && latestTrace.document_ids.length > 0) {
        setInspectorDocIds(latestTrace.document_ids);
      } else if (selectedDocIds.length > 0) {
        setInspectorDocIds(selectedDocIds);
      }
      return;
    }

    if (initialQuery.trim()) {
      setQuery(initialQuery);
      runInspect(initialQuery, selectedDocIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, latestTrace]);

  const toggleInspectorDoc = (docId: string) => {
    const next = inspectorDocIds.includes(docId)
      ? inspectorDocIds.filter((id) => id !== docId)
      : [...inspectorDocIds, docId];
    setInspectorDocIds(next);
    if (next.length > 0) {
      onChangeSelectedDocIds?.(next);
    }
  };

  const selectAllDocs = () => {
    setInspectorDocIds([]);
    if (indexedDocs.length > 0) {
      onChangeSelectedDocIds?.(indexedDocs.map((d) => d.id));
    }
  };

  const activeTraceDocNames = (result?.document_ids ?? [])
    .map((id) => documents.find((d) => d.id === id)?.filename || id)
    .filter(Boolean);

  const embeddingDims = result?.embedding_dimensions ?? health?.embedding_dimensions ?? null;
  const totalChunks = result?.total_chunks_indexed ?? health?.chunks_count ?? 0;

  return (
    <AppShell
      activePage="retrieval"
      onNavigate={onNavigate}
      title="Pipeline Inspector"
      subtitle="Inspect live chunk counts, embedding dimensions, similarity scores, and the exact prompt sent to the LLM."
      preferences={preferences}
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Query Bar */}
        <section className="dm-card p-5 sm:p-6 flex flex-col gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runInspect(query);
            }}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter a query to trace embedding retrieval, similarity scores, and LLM prompt payload..."
              className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all disabled:opacity-45 shrink-0 whitespace-nowrap"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              <span>{loading ? "Inspecting..." : "Inspect Pipeline"}</span>
            </button>
          </form>

          {indexedDocs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              <span className="text-[var(--dm-text-muted)] font-medium">Document Scope:</span>
              <button
                type="button"
                onClick={selectAllDocs}
                className={`px-2.5 py-1 rounded-lg border transition-colors ${
                  inspectorDocIds.length === 0
                    ? "bg-blue-500/20 border-blue-400/50 text-[var(--dm-text)] font-medium"
                    : "bg-[var(--dm-bg-secondary)] border-[var(--dm-border)] text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
                }`}
              >
                All Indexed PDFs ({indexedDocs.length})
              </button>
              {indexedDocs.map((doc) => {
                const selected = inspectorDocIds.includes(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => toggleInspectorDoc(doc.id)}
                    className={`px-2.5 py-1 rounded-lg border transition-colors truncate max-w-[220px] ${
                      selected
                        ? "bg-cyan-500/15 border-cyan-400/50 text-cyan-700 dark:text-cyan-200 font-medium"
                        : "bg-[var(--dm-bg-secondary)] border-[var(--dm-border)] text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
                    }`}
                    title={doc.filename}
                  >
                    {doc.filename}
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-2.5 text-xs sm:text-sm"
            >
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {/* Animated 7-Step Connected Pipeline Visualizer */}
        <section aria-label="RAG Architecture Stages" className="dm-card p-5 sm:p-6 relative overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
                End-to-End RAG Execution Stages
              </h2>
              {result && (
                <p className="font-mono text-[11px] text-[var(--dm-text-muted)]">
                  {result.request_id ? `Request ID: ${result.request_id} · ` : ""}
                  Scope:{" "}
                  {activeTraceDocNames.length > 0
                    ? activeTraceDocNames.join(", ")
                    : "All Indexed PDFs"}
                </p>
              )}
            </div>
            <span className="font-mono text-xs text-cyan-700 dark:text-cyan-300">
              {result ? "Live trace completed" : "Ready for inspection"}
            </span>
          </div>

          <div className="relative">
            <svg
              aria-hidden="true"
              className="hidden xl:block absolute top-8 left-8 right-8 w-[calc(100%-4rem)] h-4 pointer-events-none z-0"
              preserveAspectRatio="none"
              viewBox="0 0 1000 16"
            >
              <line
                x1="0"
                y1="8"
                x2="1000"
                y2="8"
                stroke="rgba(148,163,184,0.2)"
                strokeWidth="2"
              />
              <line
                x1="0"
                y1="8"
                x2="1000"
                y2="8"
                stroke="#22D3EE"
                strokeWidth="2"
                className={result || loading ? "animate-dm-flow" : ""}
                opacity={result || loading ? 0.85 : 0.3}
              />
            </svg>

            <div className="relative z-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-2.5">
              {PIPELINE_STEPS.map((stage) => {
                const Icon = stage.icon;
                const active = Boolean(result) || loading;
                return (
                  <div
                    key={stage.id}
                    className={`p-3.5 rounded-2xl border transition-all flex flex-col gap-2 ${
                      result
                        ? "bg-[var(--dm-surface-elevated)] border-cyan-400/40"
                        : "bg-[var(--dm-bg-secondary)]/80 border-[var(--dm-border)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`w-8 h-8 rounded-xl border flex items-center justify-center ${
                          active
                            ? "bg-blue-500/15 border-blue-400/35 text-cyan-700 dark:text-cyan-300"
                            : "bg-slate-900/5 dark:bg-white/5 border-[var(--dm-border)] text-[var(--dm-text-muted)]"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </span>
                      <span className="font-mono text-[11px] text-[var(--dm-text-muted)] tabular-nums">
                        {stage.num}
                      </span>
                    </div>
                    <div>
                      <p className="font-display text-xs font-semibold text-[var(--dm-text)]">
                        {stage.title}
                      </p>
                      <p className="text-[11px] text-[var(--dm-text-muted)] mt-0.5">
                        {stage.sub}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Real Backend Technical Metadata */}
          <div className="mt-5 pt-5 border-t border-[var(--dm-border)] grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
            <div>
              <span className="text-[var(--dm-text-muted)] block">Indexed Chunks</span>
              <span className="font-mono font-semibold text-[var(--dm-text)] tabular-nums">
                {totalChunks.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-[var(--dm-text-muted)] block">Embedding Dim</span>
              <span className="font-mono font-semibold text-cyan-700 dark:text-cyan-300 tabular-nums">
                {embeddingDims ? `${embeddingDims}d` : "— (no chunks)"}
              </span>
            </div>
            <div>
              <span className="text-[var(--dm-text-muted)] block">Chunk Window</span>
              <span className="font-mono font-semibold text-[var(--dm-text)] tabular-nums">
                {health?.chunk_size_tokens ?? 500} / {health?.chunk_overlap_tokens ?? 100} overlap
              </span>
            </div>
            <div>
              <span className="text-[var(--dm-text-muted)] block">Embedding Model</span>
              <span className="font-mono font-semibold text-[var(--dm-text)]">
                {result?.embedding_model || health?.embedding_model || "—"}
              </span>
            </div>
            <div>
              <span className="text-[var(--dm-text-muted)] block">Generation Model</span>
              <span className="font-mono font-semibold text-blue-700 dark:text-blue-300">
                {result?.model || health?.chat_model || "@cf/meta/llama-4-scout-17b-16e-instruct"}
              </span>
            </div>
            <div>
              <span className="text-[var(--dm-text-muted)] block">Vector Storage</span>
              <span className="font-mono font-semibold text-[var(--dm-text)] truncate block">
                {health?.storage_file || "PostgreSQL (pgvector) + Vercel Blob"}
              </span>
            </div>
          </div>
        </section>

        {/* Two-Column Results: Retrieved Chunks & Prompt + Cloudflare Workers AI Output */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Retrieved Chunks */}
          <section className="lg:col-span-7 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-semibold text-[var(--dm-text)]">
                  Top {result?.top_k ?? preferences.topK} Retrieved Chunks
                </h2>
                <p className="text-xs text-[var(--dm-text-muted)]">
                  Ranked by exact cosine similarity against stored chunk vectors.
                </p>
              </div>
              <span className="font-mono text-xs text-cyan-700 dark:text-cyan-300 tabular-nums">
                {result ? `${result.chunks.length} matched` : "Awaiting query"}
              </span>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-32 rounded-2xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                ))}
              </div>
            ) : !result ? (
              <div className="dm-card p-8 text-center text-sm text-[var(--dm-text-muted)]">
                Run a query above to inspect the ranked chunks, page numbers, chunk IDs, cosine
                distances, and similarity scores returned by the backend.
              </div>
            ) : result.chunks.length === 0 ? (
              <div className="dm-card p-8 text-center text-sm text-[var(--dm-text-muted)]">
                No indexed chunks matched your query. Upload and index a PDF document first.
              </div>
            ) : (
              <div className="space-y-3">
                {result.chunks.map((chunk) => (
                  <article
                    key={chunk.chunk_id}
                    className="dm-card p-4 sm:p-5 flex flex-col gap-3 hover:border-blue-400/35 transition-colors"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono font-semibold text-blue-700 dark:text-blue-300 tabular-nums">
                          #{chunk.rank}
                        </span>
                        <span className="font-display font-semibold text-[var(--dm-text)] truncate">
                          {chunk.filename}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
                        <span className="text-[var(--dm-text-muted)]">Page {chunk.page_number}</span>
                        <span className="text-cyan-700 dark:text-cyan-300">
                          Sim: {(chunk.similarity * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>

                    {/* Visual similarity meter */}
                    <div className="w-full h-1.5 rounded-full bg-slate-900/10 dark:bg-white/5 overflow-hidden">
                      <div
                        className="h-1.5 rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                        style={{ width: `${Math.max(4, Math.min(100, chunk.similarity * 100))}%` }}
                      />
                    </div>

                    <p className="font-mono text-[11px] text-[var(--dm-text-muted)] truncate">
                      ID: {chunk.chunk_id} · Cosine Distance: {chunk.distance}
                    </p>
                    <p className="text-xs sm:text-sm text-[var(--dm-text-secondary)] bg-[var(--dm-bg-secondary)]/80 border border-[var(--dm-border)] rounded-xl p-3 leading-relaxed">
                      {chunk.text}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* Prompt Payload & Cloudflare Workers AI Synthesis */}
          <section className="lg:col-span-5 flex flex-col gap-4">
            <div className="dm-card p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs">
                <h2 className="font-display text-sm font-semibold text-[var(--dm-text)]">
                  Context Sent to LLM
                </h2>
                <span className="font-mono text-[var(--dm-text-muted)]">Prompt Payload</span>
              </div>
              <pre className="font-mono text-[11px] text-[var(--dm-text-secondary)] bg-[var(--dm-bg)] border border-[var(--dm-border)] p-3.5 rounded-xl overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto leading-relaxed">
                {result
                  ? result.prompt_preview
                  : "<retrieved_context>\n  Run a pipeline inspection query above to inspect the exact grounded prompt sent to the LLM.\n</retrieved_context>"}
              </pre>
            </div>

            <div className="dm-card dm-glow-border p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs">
                <h2 className="font-display text-sm font-semibold text-[var(--dm-text)]">
                  Generated Answer
                </h2>
                <span className="font-mono text-cyan-700 dark:text-cyan-300">
                  {result?.model || health?.chat_model || "@cf/meta/llama-4-scout-17b-16e-instruct"}
                </span>
              </div>
              {loading ? (
                <div className="space-y-2">
                  <div className="h-4 w-5/6 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : result ? (
                <MarkdownRenderer content={result.answer} sources={result.chunks} />
              ) : (
                <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                  The citation-backed response synthesized strictly from the retrieved passages will
                  appear here.
                </p>
              )}
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
};
