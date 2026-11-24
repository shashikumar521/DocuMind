import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  GitCompareArrows,
  Loader2,
  Play,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { compareRagQuestion, fetchHealth } from "../api";
import { AppShell } from "../components/AppShell";
import { DocuMindMark } from "../components/DocuMindLogo";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastProvider";
import { CompareResponse, HealthStatus, RoutePage, UserPreferences } from "../types";

interface RAGComparisonProps {
  onNavigate: (page: RoutePage) => void;
  preferences: UserPreferences;
}

export const RAGComparison: React.FC<RAGComparisonProps> = ({
  onNavigate,
  preferences,
}) => {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const { pushToast } = useToast();

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => {});
  }, []);

  const handleCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await compareRagQuestion({
        question: q,
        topK: preferences.topK,
      });
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to run RAG comparison.";
      setError(msg);
      pushToast({ kind: "error", title: "Comparison failed", description: msg });
    } finally {
      setLoading(false);
    }
  };

  const activeModel = result?.model || health?.gemini_model || "gemini-4-hydrogen";

  return (
    <AppShell
      activePage="compare"
      onNavigate={onNavigate}
      title="RAG vs. Without RAG"
      subtitle="Evaluate how semantic retrieval transforms accuracy using the exact same Gemini model."
      preferences={preferences}
      headerActions={
        <div className="hidden sm:flex items-center gap-2 text-xs text-[var(--dm-text-muted)] font-mono">
          <GitCompareArrows className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
          <span>Model: {activeModel}</span>
        </div>
      }
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Shared Question Bar */}
        <section className="dm-card p-5 sm:p-6 flex flex-col gap-3.5">
          <form
            onSubmit={handleCompare}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a specific question about your uploaded PDFs to compare Without RAG vs. With RAG..."
              className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all disabled:opacity-45 shrink-0 whitespace-nowrap"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              <span>{loading ? "Comparing..." : "Run Comparison"}</span>
            </button>
          </form>

          {error ? (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-2.5 text-xs sm:text-sm"
            >
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : (
            <p className="text-xs text-[var(--dm-text-muted)]">
              Both responses are generated live via{" "}
              <span className="font-mono text-[var(--dm-text-secondary)]">{activeModel}</span> for an
              apples-to-apples side-by-side comparison.
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
                <XCircle className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0" aria-hidden="true" />
                <span>No semantic search over your uploaded PDFs</span>
              </li>
              <li className="flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0" aria-hidden="true" />
                <span>Relies strictly on general pre-training knowledge</span>
              </li>
              <li className="flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-700 dark:text-red-400 shrink-0" aria-hidden="true" />
                <span>Cannot verify private numbers, policies, or page citations</span>
              </li>
            </ul>

            <div className="flex-1 p-4 rounded-xl bg-[var(--dm-bg-secondary)]/80 border border-[var(--dm-border)] flex flex-col gap-3">
              <span className="font-mono text-[11px] text-[var(--dm-text-muted)]">
                Standard Gemini Output ({activeModel})
              </span>
              {loading ? (
                <div className="space-y-2.5">
                  <div className="h-4 w-5/6 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-4 w-2/3 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : result ? (
                <MarkdownRenderer content={result.without_rag.answer} />
              ) : (
                <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                  Submit a question above to observe how the model responds without access to your
                  uploaded files.
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
              <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400">Grounded</span>
            </header>

            <ul className="space-y-2 text-xs text-[var(--dm-text-secondary)]">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                <span>Retrieves top {preferences.topK} semantic chunks via cosine similarity</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                <span>Injects retrieved passages into &lt;retrieved_context&gt;</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                <span>Attaches source filenames, page numbers, and evidence passages</span>
              </li>
            </ul>

            <div className="flex-1 p-4 rounded-xl bg-[var(--dm-bg-secondary)]/80 border border-cyan-400/25 flex flex-col gap-4">
              <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300">
                Retrieval-Grounded Output ({activeModel})
              </span>
              {loading ? (
                <div className="space-y-2.5">
                  <div className="h-4 w-5/6 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-4 w-full rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-4 w-3/4 rounded bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : result ? (
                <>
                  <MarkdownRenderer
                    content={result.with_rag.answer}
                    sources={result.with_rag.sources}
                  />

                  <div className="pt-3 border-t border-[var(--dm-border)] space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-[var(--dm-text)]">
                        Source Evidence ({result.with_rag.sources.length})
                      </span>
                      <span className="font-mono text-[11px] text-[var(--dm-text-muted)]">
                        Top-{preferences.topK} similarity
                      </span>
                    </div>

                    {result.with_rag.sources.length === 0 ? (
                      <p className="text-xs text-[var(--dm-text-muted)]">
                        No indexed PDF chunks matched. Upload a PDF first to observe grounded
                        evidence.
                      </p>
                    ) : (
                      result.with_rag.sources.map((src, idx) => (
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
                  Submit a question above to inspect the grounded Gemini answer alongside the exact
                  retrieved PDF passages.
                </p>
              )}
            </div>
          </article>
        </section>
      </main>
    </AppShell>
  );
};
