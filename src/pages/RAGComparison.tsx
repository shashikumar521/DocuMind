import React, { useState } from "react";
import { compareRagQuestion } from "../api";
import { AppShell } from "../components/AppShell";
import { CompareResponse, RoutePage, UserPreferences } from "../types";

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
      setError(err instanceof Error ? err.message : "Failed to run RAG comparison.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell
      activePage="compare"
      onNavigate={onNavigate}
      title="See the Difference: With RAG vs. Without RAG"
      subtitle="Evaluate how document-grounded retrieval transforms LLM accuracy."
      preferences={preferences}
    >
      <main className="flex-1 p-gutter-md lg:p-gutter-lg max-w-7xl w-full mx-auto flex flex-col gap-gutter-lg">
        {/* Question Input Bar */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
          <form
            onSubmit={handleCompare}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-gutter-sm"
          >
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Enter a question about your uploaded PDFs to compare Without RAG vs. With RAG..."
              className="flex-1 px-gutter-md py-2.5 rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface placeholder:text-light-outline dark:placeholder:text-dark-outline font-body text-body-md focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="inline-flex items-center justify-center gap-gutter-sm px-gutter-lg py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm shrink-0 disabled:opacity-50 whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                {loading ? "progress_activity" : "play_arrow"}
              </span>
              <span>{loading ? "Comparing..." : "Run Comparison"}</span>
            </button>
          </form>

          {error ? (
            <div
              role="alert"
              className="p-gutter-sm rounded bg-light-error-container dark:bg-dark-error-container text-light-on-error-container dark:text-dark-on-error-container flex items-center gap-gutter-sm"
            >
              <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">
                error
              </span>
              <span className="font-body text-body-sm">{error}</span>
            </div>
          ) : (
            <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              Both responses are generated live using the same Gemini model for a fair side-by-side
              evaluation.
            </p>
          )}
        </section>

        {/* Side-by-Side Comparison Cards */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-gutter-lg items-stretch">
          {/* Left Card: WITHOUT RAG */}
          <article className="h-full bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/70 dark:border-dark-outline-variant/70 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
            <header className="flex items-center justify-between pb-gutter-sm border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50">
              <div className="flex items-center gap-gutter-sm">
                <span
                  className="material-symbols-outlined text-light-outline dark:text-dark-outline text-[22px]"
                  aria-hidden="true"
                >
                  public_off
                </span>
                <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                  Without RAG
                </h2>
              </div>
              <span className="font-label text-label-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                General LLM
              </span>
            </header>

            <ul className="flex flex-col gap-gutter-xs font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-light-error dark:text-dark-error text-[16px]" aria-hidden="true">
                  close
                </span>
                No document retrieval
              </li>
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-light-error dark:text-dark-error text-[16px]" aria-hidden="true">
                  close
                </span>
                General LLM response from pre-training only
              </li>
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-light-error dark:text-dark-error text-[16px]" aria-hidden="true">
                  close
                </span>
                No access to private uploaded information
              </li>
            </ul>

            <div className="flex-1 bg-light-surface-container-low/70 dark:bg-dark-surface-container border border-light-outline-variant/50 dark:border-dark-outline-variant/50 rounded p-gutter-md flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                Model Output (No Context)
              </span>
              {loading ? (
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Calling Gemini without document context...
                </p>
              ) : result ? (
                <p className="font-body text-body-md text-light-on-surface dark:text-dark-on-surface whitespace-pre-wrap">
                  {result.without_rag.answer}
                </p>
              ) : (
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Enter a question above and click &ldquo;Run Comparison&rdquo; to view the live
                  ungrounded Gemini response.
                </p>
              )}
            </div>
          </article>

          {/* Right Card: WITH RAG */}
          <article className="h-full bg-light-surface-container-lowest dark:bg-dark-surface-container-low border-2 border-light-secondary/60 dark:border-dark-secondary/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
            <header className="flex items-center justify-between pb-gutter-sm border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50">
              <div className="flex items-center gap-gutter-sm">
                <span
                  className="material-symbols-outlined text-light-secondary dark:text-dark-secondary text-[22px]"
                  aria-hidden="true"
                >
                  verified
                </span>
                <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                  With RAG
                </h2>
              </div>
              <span className="font-label text-label-sm text-light-secondary dark:text-dark-secondary">
                Grounded + Cited
              </span>
            </header>

            <ul className="flex flex-col gap-gutter-xs font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-success text-[16px]" aria-hidden="true">
                  check
                </span>
                Retrieves relevant document chunks via vector search
              </li>
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-success text-[16px]" aria-hidden="true">
                  check
                </span>
                Uses document-specific context
              </li>
              <li className="flex items-center gap-gutter-xs">
                <span className="material-symbols-outlined text-success text-[16px]" aria-hidden="true">
                  check
                </span>
                Provides grounded answers and verifiable page references
              </li>
            </ul>

            <div className="flex-1 bg-light-surface-container-low/70 dark:bg-dark-surface-container border border-light-secondary/30 dark:border-dark-secondary/30 rounded p-gutter-md flex flex-col gap-gutter-sm">
              <span className="font-label text-label-sm text-light-secondary dark:text-dark-secondary">
                Grounded Output (Vector Retrieval + Gemini)
              </span>
              {loading ? (
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Retrieving matching chunks and generating grounded Gemini response...
                </p>
              ) : result ? (
                <>
                  <p className="font-body text-body-md text-light-on-surface dark:text-dark-on-surface whitespace-pre-wrap">
                    {result.with_rag.answer}
                  </p>
                  <div className="pt-gutter-sm border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40 flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-light-on-surface dark:text-dark-on-surface tabular-nums">
                      Retrieved Chunks &amp; Citations ({result.with_rag.sources.length}):
                    </span>
                    {result.with_rag.sources.length === 0 ? (
                      <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                        No indexed document chunks were available. Upload a PDF first to see grounded
                        retrieval.
                      </p>
                    ) : (
                      result.with_rag.sources.map((src, idx) => (
                        <details
                          key={src.chunk_id}
                          className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/50 dark:border-dark-outline-variant/50 rounded p-gutter-sm"
                        >
                          <summary className="cursor-pointer font-mono text-mono-sm text-light-primary dark:text-dark-primary flex items-center justify-between gap-gutter-sm">
                            <span className="truncate">
                              #{idx + 1} {src.filename} · Page {src.page_number}
                            </span>
                            <span className="text-light-secondary dark:text-dark-secondary shrink-0 tabular-nums">
                              {(src.similarity * 100).toFixed(1)}%
                            </span>
                          </summary>
                          <p className="mt-gutter-xs pt-gutter-xs border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40 font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                            {src.text}
                          </p>
                        </details>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Enter a question above and click &ldquo;Run Comparison&rdquo; to view the live
                  document-grounded answer and retrieved source passages.
                </p>
              )}
            </div>
          </article>
        </section>

        {/* Comparison Summary */}
        <section className="bg-light-surface-container-low dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg flex flex-col gap-gutter-xs">
          <h2 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface">
            Comparison Summary
          </h2>
          <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
            Without RAG, a general LLM cannot inspect private PDFs and must either refuse or rely on
            general knowledge. With RAG, DocuMind retrieves the exact matching passages from your
            indexed documents and grounds Gemini&apos;s response with verifiable page citations.
          </p>
        </section>
      </main>
    </AppShell>
  );
};
