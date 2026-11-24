import React, { useEffect, useState } from "react";
import { inspectRetrievalPipeline } from "../api";
import { AppShell } from "../components/AppShell";
import { RetrievalInspectResponse, RoutePage, UserPreferences } from "../types";

interface RetrievalSourcesProps {
  onNavigate: (page: RoutePage) => void;
  initialQuery?: string;
  preferences: UserPreferences;
}

export const RetrievalSources: React.FC<RetrievalSourcesProps> = ({
  onNavigate,
  initialQuery = "",
  preferences,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RetrievalInspectResponse | null>(null);

  const runInspect = async (qText: string) => {
    const trimmed = qText.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const data = await inspectRetrievalPipeline({
        question: trimmed,
        topK: preferences.topK,
      });
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to inspect retrieval pipeline.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialQuery.trim()) {
      setQuery(initialQuery);
      runInspect(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  return (
    <AppShell
      activePage="retrieval"
      onNavigate={onNavigate}
      title="Retrieval & Source References"
      subtitle="Inspect the end-to-end RAG pipeline from query embedding to top retrieved chunks."
      preferences={preferences}
    >
      <main className="flex-1 p-gutter-md lg:p-gutter-lg max-w-7xl w-full mx-auto flex flex-col gap-gutter-lg">
        {/* Query Bar */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runInspect(query);
            }}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-gutter-sm"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter a question to inspect query embedding, vector search scores, and Gemini prompt..."
              className="flex-1 px-gutter-md py-2.5 rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface placeholder:text-light-outline dark:placeholder:text-dark-outline font-body text-body-md focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="inline-flex items-center justify-center gap-gutter-sm px-gutter-lg py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm shrink-0 disabled:opacity-50 whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                manage_search
              </span>
              <span>{loading ? "Inspecting..." : "Inspect Pipeline"}</span>
            </button>
          </form>
          {error && (
            <div
              role="alert"
              className="p-gutter-sm rounded bg-light-error-container dark:bg-dark-error-container text-light-on-error-container dark:text-dark-on-error-container flex items-center gap-gutter-sm"
            >
              <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">
                error
              </span>
              <span className="font-body text-body-sm">{error}</span>
            </div>
          )}
        </section>

        {/* Pipeline Flow Stepper */}
        <section
          aria-label="RAG Pipeline Stages"
          className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm"
        >
          <div className="flex items-center justify-between mb-gutter-md flex-wrap gap-gutter-sm">
            <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
              RAG Retrieval Pipeline
            </h2>
            <span className="font-mono text-mono-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              Vector Embeddings + Cosine Similarity + Gemini
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-gutter-sm">
            {[
              { step: "1. User Question", sub: "Raw query text", color: "text-light-primary dark:text-dark-primary" },
              { step: "2. Query Embedding", sub: "Dense vector", color: "text-light-secondary dark:text-dark-secondary" },
              { step: "3. Semantic Search", sub: "Cosine similarity", color: "text-light-primary dark:text-dark-primary" },
              { step: `4. Top ${preferences.topK} Chunks`, sub: "Ranked passages", color: "text-light-secondary dark:text-dark-secondary" },
              { step: "5. Context to Gemini", sub: "Grounded prompt", color: "text-light-primary dark:text-dark-primary" },
              { step: "6. Generated Answer", sub: "Cited synthesis", color: "text-light-primary dark:text-dark-primary" },
            ].map((stage) => (
              <div
                key={stage.step}
                className={`p-gutter-sm rounded bg-light-surface-container-low dark:bg-dark-surface-container border ${
                  result
                    ? "border-light-primary/50 dark:border-dark-primary/50"
                    : "border-light-outline-variant/60 dark:border-dark-outline-variant/60"
                } flex flex-col gap-gutter-xs`}
              >
                <span className={`font-label text-label-sm ${stage.color}`}>{stage.step}</span>
                <span className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  {stage.sub}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Two-Column Distinction: Retrieved Context (Left) vs. Context Sent to Gemini & Generated Answer (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter-lg items-start">
          {/* Top Retrieved Chunks */}
          <section className="lg:col-span-7 flex flex-col gap-gutter-md">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                  Top {preferences.topK} Retrieved Chunks
                </h2>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Ranked passages returned by vector similarity search.
                </p>
              </div>
              <span className="font-label text-label-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums">
                {result ? `${result.chunks.length} matched` : "Awaiting query"}
              </span>
            </div>

            {!result ? (
              <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-xl text-center">
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Run a query above to inspect the exact retrieved document chunks, page numbers, chunk
                  IDs, and cosine similarity scores.
                </p>
              </div>
            ) : result.chunks.length === 0 ? (
              <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-xl text-center">
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  No indexed chunks matched your query. Upload and index PDF documents first.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-gutter-sm">
                {result.chunks.map((chunk) => (
                  <article
                    key={chunk.chunk_id}
                    className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-md shadow-sm flex flex-col gap-gutter-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
                      <div className="flex items-center gap-gutter-sm min-w-0">
                        <span className="px-2 py-0.5 rounded bg-light-surface-container dark:bg-dark-surface-container text-light-primary dark:text-dark-primary font-mono text-mono-sm tabular-nums">
                          Rank #{chunk.rank}
                        </span>
                        <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface truncate">
                          {chunk.filename}
                        </span>
                      </div>
                      <div className="flex items-center gap-gutter-sm font-mono text-mono-sm tabular-nums">
                        <span className="text-light-on-surface-variant dark:text-dark-on-surface-variant">
                          Page {chunk.page_number}
                        </span>
                        <span className="text-light-secondary dark:text-dark-secondary">
                          Similarity: {(chunk.similarity * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                    <p className="font-mono text-mono-sm text-light-outline dark:text-dark-outline truncate">
                      Chunk ID: {chunk.chunk_id} · Distance: {chunk.distance}
                    </p>
                    <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant bg-light-surface-container-low/60 dark:bg-dark-surface-container/60 p-gutter-sm rounded border border-light-outline-variant/40 dark:border-dark-outline-variant/40">
                      {chunk.text}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* Context Sent to Gemini & Final AI-Generated Response */}
          <section className="lg:col-span-5 flex flex-col gap-gutter-md">
            <div className="bg-light-surface-container-low dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg flex flex-col gap-gutter-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface">
                  Context Sent to Gemini
                </h2>
                <span className="font-mono text-mono-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Prompt Payload
                </span>
              </div>
              <pre className="font-mono text-mono-sm text-light-on-surface-variant dark:text-dark-on-surface-variant bg-light-surface-container-lowest dark:bg-dark-surface-container p-gutter-md rounded border border-light-outline-variant/50 dark:border-dark-outline-variant/50 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">
                {result
                  ? result.prompt_preview
                  : "System: Answer strictly using ONLY the retrieved document passages. Cite document filename and page number.\n\n<retrieved_context>\n[Top retrieved chunks will appear here]\n</retrieved_context>"}
              </pre>
            </div>

            <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-secondary/50 dark:border-dark-secondary/50 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-gutter-xs">
                  <span
                    className="material-symbols-outlined text-light-secondary dark:text-dark-secondary text-[20px]"
                    aria-hidden="true"
                  >
                    auto_awesome
                  </span>
                  <h2 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface">
                    Generated Answer
                  </h2>
                </div>
                <span className="font-label text-label-sm text-light-secondary dark:text-dark-secondary">
                  Gemini Output
                </span>
              </div>
              <p className="font-body text-body-md text-light-on-surface dark:text-dark-on-surface whitespace-pre-wrap">
                {result
                  ? result.answer
                  : "Run a retrieval inspection query to see the grounded response synthesized by Gemini exclusively from the retrieved chunks."}
              </p>
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
};
