import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  askChatQuestion,
  clearChatHistoryApi,
  fetchChatHistory,
  fetchDocuments,
} from "../api";
import { AppShell } from "../components/AppShell";
import {
  ConversationTurn,
  DocuMindDocument,
  RetrievedChunk,
  RoutePage,
  UserPreferences,
} from "../types";

interface AIDocumentChatProps {
  onNavigate: (page: RoutePage) => void;
  selectedDocIds: string[];
  onChangeSelectedDocIds: (ids: string[]) => void;
  onInspectQuery: (question: string) => void;
  preferences: UserPreferences;
}

const SUGGESTED_PROMPTS = [
  "Summarize the main points of this document",
  "Explain the key concepts and definitions",
  "What are the most important findings or requirements?",
  "Compare two topics discussed across my documents",
];

export const AIDocumentChat: React.FC<AIDocumentChatProps> = ({
  onNavigate,
  selectedDocIds,
  onChangeSelectedDocIds,
  onInspectQuery,
  preferences,
}) => {
  const [documents, setDocuments] = useState<DocuMindDocument[]>([]);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [activeSources, setActiveSources] = useState<RetrievedChunk[]>([]);
  const [questionInput, setQuestionInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [loadingInit, setLoadingInit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSourcesPanel, setShowSourcesPanel] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadInitial = useCallback(async () => {
    try {
      const [docs, hist] = await Promise.all([fetchDocuments(), fetchChatHistory()]);
      setDocuments(docs);
      const ordered = [...hist].reverse();
      setHistory(ordered);
      if (ordered.length > 0) {
        const last = ordered[ordered.length - 1];
        setActiveSources(last.sources || []);
      }
      const indexedIds = docs
        .filter((d) => d.status === "Indexed Successfully")
        .map((d) => d.id);
      if (selectedDocIds.length === 0 && indexedIds.length > 0) {
        onChangeSelectedDocIds(indexedIds);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load chat workspace.");
    } finally {
      setLoadingInit(false);
    }
  }, [onChangeSelectedDocIds, selectedDocIds.length]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length, asking]);

  const indexedDocs = documents.filter((d) => d.status === "Indexed Successfully");

  const toggleDoc = (docId: string) => {
    if (selectedDocIds.includes(docId)) {
      onChangeSelectedDocIds(selectedDocIds.filter((id) => id !== docId));
    } else {
      onChangeSelectedDocIds([...selectedDocIds, docId]);
    }
  };

  const submitQuestion = async (questionText: string) => {
    const q = questionText.trim();
    if (!q || asking) return;
    if (indexedDocs.length === 0) {
      setError("Please upload and index at least one PDF document before asking questions.");
      return;
    }

    setError(null);
    setAsking(true);
    setQuestionInput("");

    try {
      const scopeIds = selectedDocIds.length > 0 ? selectedDocIds : indexedDocs.map((d) => d.id);
      const res = await askChatQuestion({
        question: q,
        documentIds: scopeIds,
        topK: preferences.topK,
      });
      const newTurn: ConversationTurn = {
        id: `${Date.now()}`,
        question: res.question,
        answer: res.answer,
        sources: res.sources || [],
        prompt_preview: res.prompt_preview,
        created_at: new Date().toISOString(),
      };
      setHistory((prev) => [...prev, newTurn]);
      setActiveSources(res.sources || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to generate Gemini response.");
      setQuestionInput(q);
    } finally {
      setAsking(false);
    }
  };

  const handleClearChat = async () => {
    try {
      await clearChatHistoryApi();
      setHistory([]);
      setActiveSources([]);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to clear conversation history.");
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <AppShell
      activePage="chat"
      onNavigate={onNavigate}
      title="AI Document Chat"
      subtitle="Ask grounded questions across your selected PDFs."
      preferences={preferences}
      headerActions={
        <div className="flex items-center gap-gutter-sm">
          <button
            type="button"
            onClick={handleClearChat}
            className="inline-flex items-center gap-gutter-xs px-3 py-1.5 rounded border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface-variant dark:text-dark-on-surface-variant hover:text-light-on-surface dark:hover:text-dark-on-surface hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container font-label text-label-md transition-colors duration-state-change whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              delete_sweep
            </span>
            <span className="hidden sm:inline">Clear Conversation</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSourcesPanel((prev) => !prev)}
            className="inline-flex items-center gap-gutter-xs px-3 py-1.5 rounded bg-light-surface-container dark:bg-dark-surface-container text-light-on-surface dark:text-dark-on-surface font-label text-label-md hover:bg-light-surface-container-high dark:hover:bg-dark-surface-container-high transition-colors duration-state-change shrink-0 whitespace-nowrap tabular-nums"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              dock_to_right
            </span>
            <span>Sources ({activeSources.length})</span>
          </button>
        </div>
      }
    >
      {/* 3-Pane Chat Layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-[calc(100vh-4rem)]">
        {/* Left Panel: Uploaded Document Selection */}
        <section
          aria-label="Document Selection"
          className="lg:col-span-3 bg-light-surface-container-low/50 dark:bg-dark-surface-container-low/50 border-b lg:border-b-0 lg:border-r border-light-outline-variant/60 dark:border-dark-outline-variant/60 p-gutter-md flex flex-col gap-gutter-md"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
              Active Documents
            </h2>
            <span className="font-label text-label-sm text-light-primary dark:text-dark-primary tabular-nums">
              {selectedDocIds.filter((id) => indexedDocs.some((d) => d.id === id)).length} selected
            </span>
          </div>

          {loadingInit ? (
            <div className="h-24 rounded bg-light-surface-container dark:bg-dark-surface-container animate-pulse" />
          ) : documents.length === 0 ? (
            <div className="p-gutter-md rounded bg-light-surface-container-lowest dark:bg-dark-surface-container border border-light-outline-variant/60 dark:border-dark-outline-variant/60 flex flex-col gap-gutter-sm">
              <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                No PDFs uploaded yet. Upload documents to ask grounded questions.
              </p>
              <button
                type="button"
                onClick={() => onNavigate("documents")}
                className="px-3 py-1.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary font-label text-label-md hover:bg-light-primary-container"
              >
                Upload PDFs
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-gutter-sm">
              {documents.map((doc) => {
                const isIndexed = doc.status === "Indexed Successfully";
                const checked = isIndexed && selectedDocIds.includes(doc.id);
                return (
                  <label
                    key={doc.id}
                    className={`flex items-start gap-gutter-sm p-gutter-sm rounded bg-light-surface-container-lowest dark:bg-dark-surface-container border ${
                      checked
                        ? "border-light-primary/60 dark:border-dark-primary/60"
                        : "border-light-outline-variant/60 dark:border-dark-outline-variant/60"
                    } ${isIndexed ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={!isIndexed}
                      checked={checked}
                      onChange={() => toggleDoc(doc.id)}
                      className="mt-0.5 rounded text-light-primary focus:ring-light-primary"
                    />
                    <div className="min-w-0">
                      <p className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface truncate">
                        {doc.filename}
                      </p>
                      <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums">
                        {doc.pages || 0} pages · {doc.status}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {/* Central Chat Conversation Area */}
        <section
          aria-label="Chat Conversation"
          className={`${
            showSourcesPanel ? "lg:col-span-6" : "lg:col-span-9"
          } flex flex-col justify-between bg-light-surface dark:bg-dark-surface`}
        >
          <div className="flex-1 p-gutter-md lg:p-gutter-lg flex flex-col gap-gutter-lg overflow-y-auto max-h-[calc(100vh-14rem)]">
            {/* Welcome Guidance Card */}
            {history.length === 0 && !asking && (
              <div className="flex items-start gap-gutter-sm max-w-2xl">
                <div className="w-8 h-8 rounded-md bg-gradient-to-br from-light-primary to-light-secondary flex items-center justify-center text-light-on-primary shrink-0">
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                    smart_toy
                  </span>
                </div>
                <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-md shadow-sm flex flex-col gap-gutter-xs">
                  <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                    DocuMind Assistant
                  </span>
                  <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                    Select one or more indexed PDFs on the left and ask any question. Every response is
                    generated live by Gemini using retrieved passages and includes page-level source
                    citations.
                  </p>
                </div>
              </div>
            )}

            {history.map((turn) => (
              <React.Fragment key={turn.id}>
                {/* User Message */}
                <div className="flex items-start justify-end gap-gutter-sm">
                  <div className="bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container rounded-md px-gutter-md py-3 max-w-xl shadow-sm">
                    <p className="font-body text-body-md whitespace-pre-wrap">{turn.question}</p>
                  </div>
                </div>

                {/* AI Response with Expandable Citations */}
                <div className="flex items-start gap-gutter-sm max-w-2xl">
                  <div className="w-8 h-8 rounded-md bg-gradient-to-br from-light-primary to-light-secondary flex items-center justify-center text-light-on-primary shrink-0">
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                      smart_toy
                    </span>
                  </div>
                  <div className="flex-1 bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-md shadow-sm flex flex-col gap-gutter-md">
                    <div className="flex items-center justify-between gap-gutter-sm">
                      <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                        DocuMind Assistant
                      </span>
                      <span className="font-label text-label-sm text-light-secondary dark:text-dark-secondary tabular-nums">
                        {turn.sources.length} source{turn.sources.length === 1 ? "" : "s"} retrieved
                      </span>
                    </div>

                    <div className="font-body text-body-md text-light-on-surface dark:text-dark-on-surface whitespace-pre-wrap">
                      {turn.answer}
                    </div>

                    {turn.sources.length > 0 && (
                      <div className="flex flex-col gap-gutter-xs">
                        {turn.sources.map((src, idx) => (
                          <details
                            key={src.chunk_id}
                            className="bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded p-gutter-sm"
                          >
                            <summary className="cursor-pointer font-label text-label-md text-light-primary dark:text-dark-primary flex items-center justify-between gap-gutter-sm">
                              <span className="truncate">
                                Source {idx + 1}: {src.filename} · Page {src.page_number}
                              </span>
                              <span className="font-mono text-mono-sm text-light-secondary dark:text-dark-secondary shrink-0 tabular-nums">
                                Score: {(src.similarity * 100).toFixed(1)}%
                              </span>
                            </summary>
                            <p className="mt-gutter-sm pt-gutter-sm border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40 font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                              {src.text}
                            </p>
                          </details>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-gutter-xs border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40">
                      <div className="flex items-center gap-gutter-xs">
                        <button
                          type="button"
                          onClick={() => handleCopy(turn.id, turn.answer)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container font-label text-label-sm whitespace-nowrap"
                        >
                          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                            content_copy
                          </span>
                          <span>{copiedId === turn.id ? "Copied" : "Copy answer"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={asking}
                          onClick={() => submitQuestion(turn.question)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container font-label text-label-sm disabled:opacity-50 whitespace-nowrap"
                        >
                          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                            refresh
                          </span>
                          <span>Regenerate</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveSources(turn.sources);
                            setShowSourcesPanel(true);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-light-primary dark:text-dark-primary hover:bg-light-surface-container dark:hover:bg-dark-surface-container font-label text-label-sm whitespace-nowrap"
                        >
                          <span>Focus Sources</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            ))}

            {asking && (
              <div className="flex items-center gap-gutter-sm text-light-secondary dark:text-dark-secondary">
                <span className="material-symbols-outlined animate-spin text-[18px]" aria-hidden="true">
                  progress_activity
                </span>
                <span className="font-label text-label-md">
                  Retrieving top passages and generating grounded Gemini response...
                </span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="p-gutter-md rounded bg-light-error-container dark:bg-dark-error-container text-light-on-error-container dark:text-dark-on-error-container flex items-center gap-gutter-sm"
              >
                <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">
                  error
                </span>
                <span className="font-body text-body-sm">{error}</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Suggested Questions + Input Area */}
          <div className="p-gutter-md border-t border-light-outline-variant/60 dark:border-dark-outline-variant/60 bg-light-surface-container-lowest dark:bg-dark-surface-container-lowest flex flex-col gap-gutter-sm">
            <div className="flex flex-wrap gap-gutter-xs">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setQuestionInput(prompt)}
                  className="px-3 py-1 rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant/60 dark:border-dark-outline-variant/60 hover:border-light-primary font-label text-label-sm text-light-on-surface dark:text-dark-on-surface transition-colors duration-state-change"
                >
                  {prompt}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitQuestion(questionInput);
              }}
              className="flex items-center gap-gutter-sm"
            >
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                placeholder="Ask anything about your uploaded documents..."
                className="flex-1 px-gutter-md py-2.5 rounded bg-light-surface-container-low dark:bg-dark-surface-container-low border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface placeholder:text-light-outline dark:placeholder:text-dark-outline font-body text-body-md focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
              />
              <button
                type="submit"
                disabled={asking || !questionInput.trim()}
                className="inline-flex items-center justify-center gap-gutter-xs px-gutter-md py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm shrink-0 disabled:opacity-50 whitespace-nowrap"
              >
                <span className="hidden sm:inline">{asking ? "Asking..." : "Send"}</span>
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  send
                </span>
              </button>
            </form>

            <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant text-center">
              Answers are generated using retrieved document content. Always verify important
              information against the original source.
            </p>
          </div>
        </section>

        {/* Right Panel: Sources & Retrieved Context (Collapsible) */}
        {showSourcesPanel && (
          <aside
            aria-label="Retrieved Sources"
            className="lg:col-span-3 bg-light-surface-container-low/50 dark:bg-dark-surface-container-low/50 border-t lg:border-t-0 lg:border-l border-light-outline-variant/60 dark:border-dark-outline-variant/60 p-gutter-md flex flex-col gap-gutter-md"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                Retrieved Context
              </h2>
              <span className="font-label text-label-sm text-light-secondary dark:text-dark-secondary tabular-nums">
                Top {activeSources.length || preferences.topK}
              </span>
            </div>

            {activeSources.length === 0 ? (
              <div className="p-gutter-md rounded bg-light-surface-container-lowest dark:bg-dark-surface-container border border-light-outline-variant/60 dark:border-dark-outline-variant/60">
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Retrieved chunks and similarity scores will appear here when you ask a question.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-gutter-sm overflow-y-auto max-h-[calc(100vh-14rem)]">
                {activeSources.map((src) => (
                  <article
                    key={src.chunk_id}
                    className="bg-light-surface-container-lowest dark:bg-dark-surface-container border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded p-gutter-sm flex flex-col gap-gutter-xs"
                  >
                    <div className="flex items-center justify-between gap-gutter-xs">
                      <span className="font-label text-label-sm text-light-primary dark:text-dark-primary truncate">
                        {src.filename} · p. {src.page_number}
                      </span>
                      <span className="font-mono text-mono-sm text-light-secondary dark:text-dark-secondary shrink-0 tabular-nums">
                        {(src.similarity * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant line-clamp-5">
                      {src.text}
                    </p>
                  </article>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                const lastQ = history[history.length - 1]?.question || "";
                if (lastQ) onInspectQuery(lastQ);
                onNavigate("retrieval");
              }}
              className="mt-auto text-center px-3 py-2 rounded border border-light-outline-variant dark:border-dark-outline-variant bg-light-surface-container-lowest dark:bg-dark-surface-container font-label text-label-md text-light-primary dark:text-dark-primary hover:bg-light-surface-container-low transition-colors duration-state-change"
            >
              Inspect Full RAG Pipeline
            </button>
          </aside>
        )}
      </div>
    </AppShell>
  );
};
