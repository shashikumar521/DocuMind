import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileDiff,
  FileText,
  GitCompareArrows,
  Layers,
  Loader2,
  Play,
  ShieldAlert,
  Upload,
  XCircle,
} from "lucide-react";
import {
  compareDocumentsByIds,
  compareRagQuestion,
  fetchDocuments,
  fetchHealth,
} from "../api";
import { AppShell } from "../components/AppShell";
import { DocuMindMark } from "../components/DocuMindLogo";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastProvider";
import {
  CompareResponse,
  DocumentCompareResponse,
  DocuMindDocument,
  HealthStatus,
  RetrievedChunk,
  RoutePage,
  UserPreferences,
} from "../types";

interface RAGComparisonProps {
  onNavigate: (page: RoutePage) => void;
  preferences: UserPreferences;
}

type CompareMode = "documents" | "rag";

const MAX_QUESTION_CHARS = 4_000;

export const RAGComparison: React.FC<RAGComparisonProps> = ({
  onNavigate,
  preferences,
}) => {
  const [mode, setMode] = useState<CompareMode>("documents");
  const [documents, setDocuments] = useState<DocuMindDocument[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [health, setHealth] = useState<HealthStatus | null>(null);

  // Document-vs-Document comparison state (sends document IDs only)
  const [docAId, setDocAId] = useState("");
  const [docBId, setDocBId] = useState("");
  const [docFocusQuestion, setDocFocusQuestion] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docResult, setDocResult] = useState<DocumentCompareResponse | null>(null);
  const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);

  // RAG vs Without RAG comparison state
  const [ragQuestion, setRagQuestion] = useState("");
  const [ragScopeIds, setRagScopeIds] = useState<string[]>([]);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [ragResult, setRagResult] = useState<CompareResponse | null>(null);

  const { pushToast } = useToast();

  const loadWorkspace = useCallback(async () => {
    try {
      const [docs, healthData] = await Promise.all([
        fetchDocuments(),
        fetchHealth().catch(() => null),
      ]);
      setDocuments(docs);
      if (healthData) setHealth(healthData);
      const indexed = docs.filter((d) => d.status === "Indexed Successfully");
      if (indexed.length >= 1) {
        setDocAId((prev) => (prev && indexed.some((d) => d.id === prev) ? prev : indexed[0].id));
      }
      if (indexed.length >= 2) {
        setDocBId((prev) =>
          prev && indexed.some((d) => d.id === prev) ? prev : indexed[1].id
        );
      }
    } catch {
      // Handled gracefully in UI
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const indexedDocs = useMemo(
    () => documents.filter((d) => d.status === "Indexed Successfully"),
    [documents]
  );

  const selectedDocA = useMemo(
    () => indexedDocs.find((d) => d.id === docAId) ?? null,
    [indexedDocs, docAId]
  );
  const selectedDocB = useMemo(
    () => indexedDocs.find((d) => d.id === docBId) ?? null,
    [indexedDocs, docBId]
  );

  const handleDocumentCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (docLoading) return;

    if (!docAId || !docBId || docAId === docBId) {
      const msg = "Please select two different indexed PDF documents to compare.";
      setDocError(msg);
      pushToast({ kind: "error", title: "Select two documents", description: msg });
      return;
    }

    const focus = docFocusQuestion.trim();
    if (focus.length > MAX_QUESTION_CHARS) {
      const msg = `Comparison focus must be under ${MAX_QUESTION_CHARS} characters.`;
      setDocError(msg);
      pushToast({ kind: "error", title: "Input too long", description: msg });
      return;
    }

    setDocLoading(true);
    setDocError(null);
    setHighlightedChunkId(null);

    try {
      // Send only compact document IDs — never raw PDF bytes, base64, or extracted text.
      const data = await compareDocumentsByIds({
        documentIds: [docAId, docBId],
        question: focus || undefined,
        topK: Math.min(6, Math.max(2, preferences.topK)),
      });
      setDocResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to compare documents.";
      setDocError(msg);
      pushToast({ kind: "error", title: "Document comparison failed", description: msg });
    } finally {
      setDocLoading(false);
    }
  };

  const handleRagCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = ragQuestion.trim();
    if (!q || ragLoading) return;
    if (q.length > MAX_QUESTION_CHARS) {
      const msg = `Question must be under ${MAX_QUESTION_CHARS} characters.`;
      setRagError(msg);
      pushToast({ kind: "error", title: "Question too long", description: msg });
      return;
    }
    setRagLoading(true);
    setRagError(null);
    try {
      const data = await compareRagQuestion({
        question: q,
        documentIds: ragScopeIds.length > 0 ? ragScopeIds : undefined,
        topK: preferences.topK,
      });
      setRagResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to run RAG comparison.";
      setRagError(msg);
      pushToast({ kind: "error", title: "Comparison failed", description: msg });
    } finally {
      setRagLoading(false);
    }
  };

  const toggleRagScope = (id: string) => {
    setRagScopeIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleCitationSelect = (chunk: RetrievedChunk) => {
    setHighlightedChunkId(chunk.chunk_id);
    const el = document.getElementById(`compare-source-${chunk.chunk_id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  const activeModel =
    (mode === "documents" ? docResult?.model : ragResult?.model) ||
    health?.chat_model ||
    "@cf/meta/llama-4-scout-17b-16e-instruct";
  const providerLabel = "Cloudflare Workers AI";

  const groupedDocSources = useMemo(() => {
    if (!docResult) return [];
    return docResult.documents.map((doc) => ({
      doc,
      chunks: docResult.sources.filter((s) => s.document_id === doc.id),
    }));
  }, [docResult]);

  return (
    <AppShell
      activePage="compare"
      onNavigate={onNavigate}
      title={mode === "documents" ? "Compare Documents" : "RAG vs. Without RAG"}
      subtitle={
        mode === "documents"
          ? "Compare uploaded PDFs side-by-side via lightweight document IDs and server-side chunk retrieval."
          : "Evaluate how semantic retrieval transforms accuracy using the exact same LLM."
      }
      preferences={preferences}
      headerActions={
        <div className="hidden sm:flex items-center gap-2 text-xs text-[var(--dm-text-muted)] font-mono">
          <GitCompareArrows className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
          <span>Model: {activeModel}</span>
        </div>
      }
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Mode Switcher */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] self-start">
            <button
              type="button"
              onClick={() => setMode("documents")}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                mode === "documents"
                  ? "bg-blue-500/20 text-[var(--dm-text)] border border-blue-400/35"
                  : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
              }`}
            >
              <FileDiff className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
              <span>Compare Documents</span>
            </button>
            <button
              type="button"
              onClick={() => setMode("rag")}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                mode === "rag"
                  ? "bg-blue-500/20 text-[var(--dm-text)] border border-blue-400/35"
                  : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
              }`}
            >
              <GitCompareArrows className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
              <span>RAG vs. Without RAG</span>
            </button>
          </div>

          <span className="text-xs text-[var(--dm-text-muted)] font-mono">
            {indexedDocs.length} indexed PDF{indexedDocs.length === 1 ? "" : "s"} available
          </span>
        </div>

        {mode === "documents" ? (
          <>
            {/* Document Selector & Comparison Focus Form */}
            <section className="dm-card p-5 sm:p-6 flex flex-col gap-4">
              {loadingDocs ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="h-20 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-20 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : indexedDocs.length < 2 ? (
                <div className="py-6 text-center flex flex-col items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-400/25 flex items-center justify-center">
                    <FileDiff className="w-6 h-6 text-cyan-700 dark:text-cyan-300" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
                    Upload at least 2 indexed PDFs to compare
                  </h2>
                  <p className="text-xs sm:text-sm text-[var(--dm-text-muted)] max-w-lg">
                    DocuMind compares already-uploaded PDFs using lightweight document IDs and
                    retrieves their indexed chunks directly from the database.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("documents")}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 text-white text-xs sm:text-sm font-semibold"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Upload PDFs</span>
                  </button>
                </div>
              ) : (
                <form onSubmit={handleDocumentCompare} className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-[var(--dm-text-secondary)]">
                        Document A (Baseline)
                      </span>
                      <select
                        value={docAId}
                        onChange={(e) => setDocAId(e.target.value)}
                        aria-label="Select Document A"
                        className="px-3.5 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] focus:border-blue-400 focus:outline-none"
                      >
                        {indexedDocs.map((doc) => (
                          <option
                            key={doc.id}
                            value={doc.id}
                            className="bg-[var(--dm-surface)] text-[var(--dm-text)]"
                          >
                            {doc.filename} ({doc.pages}p · {doc.chunks_count} chunks)
                          </option>
                        ))}
                      </select>
                      {selectedDocA && (
                        <span className="font-mono text-[11px] text-[var(--dm-text-muted)] truncate">
                          ID: {selectedDocA.id}
                        </span>
                      )}
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-[var(--dm-text-secondary)]">
                        Document B (Comparison Target)
                      </span>
                      <select
                        value={docBId}
                        onChange={(e) => setDocBId(e.target.value)}
                        aria-label="Select Document B"
                        className="px-3.5 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] focus:border-blue-400 focus:outline-none"
                      >
                        {indexedDocs.map((doc) => (
                          <option
                            key={doc.id}
                            value={doc.id}
                            className="bg-[var(--dm-surface)] text-[var(--dm-text)]"
                          >
                            {doc.filename} ({doc.pages}p · {doc.chunks_count} chunks)
                          </option>
                        ))}
                      </select>
                      {selectedDocB && (
                        <span className="font-mono text-[11px] text-[var(--dm-text-muted)] truncate">
                          ID: {selectedDocB.id}
                        </span>
                      )}
                    </label>
                  </div>

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                    <input
                      type="text"
                      maxLength={MAX_QUESTION_CHARS}
                      value={docFocusQuestion}
                      onChange={(e) => setDocFocusQuestion(e.target.value)}
                      placeholder="Optional focus (e.g., 'Compare security controls, SLA timelines, and pricing') — leave blank for full comparison"
                      className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={docLoading || !docAId || !docBId || docAId === docBId}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all disabled:opacity-45 shrink-0 whitespace-nowrap"
                    >
                      {docLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <FileDiff className="w-4 h-4" />
                      )}
                      <span>{docLoading ? "Comparing..." : "Compare Documents"}</span>
                    </button>
                  </div>

                  {docAId && docBId && docAId === docBId && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Select two distinct documents for Document A and Document B.
                    </p>
                  )}

                  {docError ? (
                    <div
                      role="alert"
                      className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-2.5 text-xs sm:text-sm"
                    >
                      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{docError}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--dm-text-muted)]">
                      Only document IDs are sent in the request. Chunks are fetched server-side from
                      PostgreSQL, optimized within token budgets, and analyzed via{" "}
                      <span className="font-mono text-[var(--dm-text-secondary)]">
                        {activeModel}
                      </span>
                      .
                    </p>
                  )}
                </form>
              )}
            </section>

            {/* Document Comparison Result & Dual Citations */}
            {(docLoading || docResult) && (
              <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <article className="lg:col-span-7 dm-card dm-glow-border p-6 flex flex-col gap-4">
                  <header className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-[var(--dm-border)]">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500/15 to-cyan-500/15 border border-cyan-400/35 flex items-center justify-center shrink-0">
                        <DocuMindMark size="sm" />
                      </div>
                      <div>
                        <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
                          Side-by-Side Document Analysis
                        </h2>
                        <p className="text-xs text-[var(--dm-text-muted)]">
                          {providerLabel} · {activeModel}
                        </p>
                      </div>
                    </div>
                    {docResult && (
                      <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 tabular-nums">
                        {docResult.context_stats.optimized_chunks} passages ·{" "}
                        {docResult.context_stats.context_chars.toLocaleString()} /{" "}
                        {docResult.context_stats.max_context_chars.toLocaleString()} chars
                      </span>
                    )}
                  </header>

                  {docLoading ? (
                    <div className="space-y-3 py-2">
                      <div className="h-4 w-4/5 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-11/12 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-3/4 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                    </div>
                  ) : (
                    docResult && (
                      <MarkdownRenderer
                        content={docResult.comparison}
                        sources={docResult.sources}
                        onSelectCitation={handleCitationSelect}
                      />
                    )
                  )}
                </article>

                {/* Evidence from Both Documents */}
                <aside className="lg:col-span-5 flex flex-col gap-4">
                  {docLoading ? (
                    <div className="dm-card p-5 space-y-3">
                      <div className="h-5 w-1/2 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-24 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-24 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                    </div>
                  ) : (
                    groupedDocSources.map(({ doc, chunks }, groupIdx) => (
                      <section key={doc.id} className="dm-card p-5 flex flex-col gap-3">
                        <header className="flex items-center justify-between gap-2 pb-2.5 border-b border-[var(--dm-border)]">
                          <div className="flex items-center gap-2 min-w-0">
                            <Layers className="w-4 h-4 text-cyan-700 dark:text-cyan-300 shrink-0" />
                            <h3 className="font-display text-sm font-semibold text-[var(--dm-text)] truncate">
                              Doc {groupIdx + 1}: {doc.filename}
                            </h3>
                          </div>
                          <span className="font-mono text-[11px] text-[var(--dm-text-muted)] shrink-0 tabular-nums">
                            {chunks.length} passage{chunks.length === 1 ? "" : "s"}
                          </span>
                        </header>

                        <div className="flex flex-col gap-2">
                          {chunks.map((chunk) => {
                            const highlighted = highlightedChunkId === chunk.chunk_id;
                            return (
                              <details
                                key={chunk.chunk_id}
                                id={`compare-source-${chunk.chunk_id}`}
                                open={highlighted || undefined}
                                className={`rounded-xl border px-3 py-2 transition-colors ${
                                  highlighted
                                    ? "bg-cyan-500/10 border-cyan-400/55"
                                    : "bg-[var(--dm-bg-secondary)]/80 border-[var(--dm-border)]"
                                }`}
                              >
                                <summary className="cursor-pointer text-xs font-medium text-[var(--dm-text-secondary)] flex items-center justify-between gap-2">
                                  <span className="inline-flex items-center gap-1.5 truncate">
                                    <FileText className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 shrink-0" />
                                    <span className="truncate">
                                      Page {chunk.page_number} · {chunk.chunk_id}
                                    </span>
                                  </span>
                                  <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 shrink-0 tabular-nums">
                                    {(chunk.similarity * 100).toFixed(0)}%
                                  </span>
                                </summary>
                                <p className="mt-2 pt-2 border-t border-[var(--dm-border)] text-xs text-[var(--dm-text-muted)] leading-relaxed">
                                  {chunk.text}
                                </p>
                              </details>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                </aside>
              </section>
            )}
          </>
        ) : (
          <>
            {/* Shared Question Bar for RAG vs Without RAG */}
            <section className="dm-card p-5 sm:p-6 flex flex-col gap-3.5">
              <form
                onSubmit={handleRagCompare}
                className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
              >
                <input
                  type="text"
                  maxLength={MAX_QUESTION_CHARS}
                  value={ragQuestion}
                  onChange={(e) => setRagQuestion(e.target.value)}
                  placeholder="Ask a specific question about your uploaded PDFs to compare Without RAG vs. With RAG..."
                  className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={ragLoading || !ragQuestion.trim()}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all disabled:opacity-45 shrink-0 whitespace-nowrap"
                >
                  {ragLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  <span>{ragLoading ? "Comparing..." : "Run Comparison"}</span>
                </button>
              </form>

              {indexedDocs.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[var(--dm-text-muted)]">Document scope (IDs):</span>
                  <button
                    type="button"
                    onClick={() => setRagScopeIds([])}
                    className={`px-2.5 py-1 rounded-lg border transition-colors ${
                      ragScopeIds.length === 0
                        ? "bg-blue-500/20 border-blue-400/45 text-[var(--dm-text)]"
                        : "bg-[var(--dm-bg-secondary)] border-[var(--dm-border)] text-[var(--dm-text-muted)]"
                    }`}
                  >
                    All ({indexedDocs.length})
                  </button>
                  {indexedDocs.map((doc) => {
                    const active = ragScopeIds.includes(doc.id);
                    return (
                      <button
                        key={doc.id}
                        type="button"
                        onClick={() => toggleRagScope(doc.id)}
                        className={`px-2.5 py-1 rounded-lg border truncate max-w-[200px] transition-colors ${
                          active
                            ? "bg-cyan-500/20 border-cyan-400/45 text-[var(--dm-text)]"
                            : "bg-[var(--dm-bg-secondary)] border-[var(--dm-border)] text-[var(--dm-text-muted)]"
                        }`}
                      >
                        {doc.filename}
                      </button>
                    );
                  })}
                </div>
              )}

              {ragError ? (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-2.5 text-xs sm:text-sm"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{ragError}</span>
                </div>
              ) : (
                <p className="text-xs text-[var(--dm-text-muted)]">
                  Both responses are generated live via{" "}
                  <span className="font-mono text-[var(--dm-text-secondary)]">{activeModel}</span>{" "}
                  for an apples-to-apples side-by-side comparison.
                </p>
              )}
            </section>

            {/* Side-by-Side Comparison Panels */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
              {/* WITHOUT RAG */}
              <article className="dm-card p-6 flex flex-col gap-5">
                <header className="flex items-center justify-between pb-4 border-b border-[var(--dm-border)]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/5 border border-[var(--dm-border)] text-[var(--dm-text-muted)] flex items-center justify-center">
                      <ShieldAlert className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-display text-lg font-semibold text-[var(--dm-text)]">
                        Without RAG
                      </h2>
                      <p className="text-xs text-[var(--dm-text-muted)]">
                        General LLM response · No document context
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-[var(--dm-text-muted)]">Ungrounded</span>
                </header>

                <ul className="space-y-2 text-xs text-[var(--dm-text-muted)]">
                  <li className="flex items-center gap-2">
                    <XCircle
                      className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>No semantic search over your uploaded PDFs</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <XCircle
                      className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Relies strictly on general pre-training knowledge</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <XCircle
                      className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Cannot verify private numbers, policies, or page citations</span>
                  </li>
                </ul>

                <div className="flex-1 p-4 rounded-xl bg-[var(--dm-bg-secondary)]/80 border border-[var(--dm-border)] flex flex-col gap-3">
                  <span className="font-mono text-[11px] text-[var(--dm-text-muted)]">
                    Standard {providerLabel} Output ({activeModel})
                  </span>
                  {ragLoading ? (
                    <div className="space-y-2.5">
                      <div className="h-4 w-5/6 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-2/3 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                    </div>
                  ) : ragResult ? (
                    <MarkdownRenderer content={ragResult.without_rag.answer} />
                  ) : (
                    <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                      Submit a question above to observe how the model responds without access to
                      your uploaded files.
                    </p>
                  )}
                </div>
              </article>

              {/* WITH RAG */}
              <article className="dm-card dm-glow-border p-6 flex flex-col gap-5">
                <header className="flex items-center justify-between pb-4 border-b border-[var(--dm-border)]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/15 to-cyan-500/15 border border-cyan-400/35 flex items-center justify-center shrink-0">
                      <DocuMindMark size="sm" />
                    </div>
                    <div>
                      <h2 className="font-display text-lg font-semibold text-[var(--dm-text)]">
                        With RAG
                      </h2>
                      <p className="text-xs text-cyan-700 dark:text-cyan-300">
                        Context-grounded · Verified page citations
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                    Grounded
                  </span>
                </header>

                <ul className="space-y-2 text-xs text-[var(--dm-text-secondary)]">
                  <li className="flex items-center gap-2">
                    <CheckCircle2
                      className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Retrieves top {preferences.topK} semantic chunks via cosine similarity</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2
                      className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Injects retrieved passages into &lt;retrieved_context&gt;</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2
                      className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Attaches source filenames, page numbers, and evidence passages</span>
                  </li>
                </ul>

                <div className="flex-1 p-4 rounded-xl bg-[var(--dm-bg-secondary)]/80 border border-cyan-400/25 flex flex-col gap-4">
                  <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300">
                    Retrieval-Grounded Output ({activeModel})
                  </span>
                  {ragLoading ? (
                    <div className="space-y-2.5">
                      <div className="h-4 w-5/6 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                      <div className="h-4 w-3/4 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                    </div>
                  ) : ragResult ? (
                    <>
                      <MarkdownRenderer
                        content={ragResult.with_rag.answer}
                        sources={ragResult.with_rag.sources}
                      />

                      <div className="pt-3 border-t border-[var(--dm-border)] space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-[var(--dm-text)]">
                            Source Evidence ({ragResult.with_rag.sources.length})
                          </span>
                          <span className="font-mono text-[11px] text-[var(--dm-text-muted)]">
                            Top-{preferences.topK} similarity
                          </span>
                        </div>

                        {ragResult.with_rag.sources.length === 0 ? (
                          <p className="text-xs text-[var(--dm-text-muted)]">
                            No indexed PDF chunks matched. Upload a PDF first to observe grounded
                            evidence.
                          </p>
                        ) : (
                          ragResult.with_rag.sources.map((src, idx) => (
                            <details
                              key={src.chunk_id}
                              className="rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] px-3 py-2"
                            >
                              <summary className="cursor-pointer text-xs font-medium text-[var(--dm-text-secondary)] flex items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1.5 truncate">
                                  <FileText className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 shrink-0" />
                                  <span className="truncate">
                                    #{idx + 1} {src.filename} · Page {src.page_number}
                                  </span>
                                </span>
                                <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 shrink-0 tabular-nums">
                                  {(src.similarity * 100).toFixed(1)}%
                                </span>
                              </summary>
                              <p className="mt-2 pt-2 border-t border-[var(--dm-border)] text-xs text-[var(--dm-text-muted)] leading-relaxed">
                                {src.text}
                              </p>
                            </details>
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                      Submit a question above to inspect the grounded {providerLabel} answer
                      alongside the exact retrieved PDF passages.
                    </p>
                  )}
                </div>
              </article>
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
};
