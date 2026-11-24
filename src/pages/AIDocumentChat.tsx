import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  FileText,
  History,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  askChatQuestion,
  clearChatHistoryApi,
  fetchChatHistory,
  fetchDocuments,
} from "../api";
import { AppShell } from "../components/AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastProvider";
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

type MobileTab = "sidebar" | "chat" | "sources";
type SidebarTab = "documents" | "history";

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
  const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
  const [questionInput, setQuestionInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [loadingInit, setLoadingInit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSourcesPanel, setShowSourcesPanel] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("documents");
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { pushToast } = useToast();

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

  const indexedDocs = useMemo(
    () => documents.filter((d) => d.status === "Indexed Successfully"),
    [documents]
  );

  const selectedIndexedDocs = useMemo(
    () => indexedDocs.filter((d) => selectedDocIds.includes(d.id)),
    [indexedDocs, selectedDocIds]
  );

  // Build context-aware suggested questions based on actual uploaded PDFs
  const suggestedPrompts = useMemo(() => {
    const activeList = selectedIndexedDocs.length > 0 ? selectedIndexedDocs : indexedDocs;
    if (activeList.length === 0) {
      return [
        "Summarize the key takeaways from this document",
        "List the main requirements, numbers, or policies stated",
        "Explain the key technical definitions and concepts",
      ];
    }
    const primaryName = activeList[0].filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
    if (activeList.length === 1) {
      return [
        `Summarize the key findings and requirements in ${primaryName}`,
        `What specific rules, deadlines, or metrics are stated in ${primaryName}?`,
        `List important definitions and action items from ${primaryName}`,
      ];
    }
    const secondName = activeList[1].filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
    return [
      `Summarize the main points across ${primaryName} and ${secondName}`,
      `Compare the key requirements or policies between ${primaryName} and ${secondName}`,
      `What specific timelines, limits, or metrics appear in these documents?`,
    ];
  }, [indexedDocs, selectedIndexedDocs]);

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
      const msg = "Please upload and index at least one PDF document before asking questions.";
      setError(msg);
      pushToast({ kind: "info", title: "No indexed PDFs", description: msg });
      return;
    }

    setError(null);
    setAsking(true);
    setQuestionInput("");
    setMobileTab("chat");

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
      setHighlightedChunkId(res.sources?.[0]?.chunk_id ?? null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate Gemini response.";
      setError(msg);
      setQuestionInput(q);
      pushToast({ kind: "error", title: "Chat request failed", description: msg });
    } finally {
      setAsking(false);
    }
  };

  const confirmClearChat = async () => {
    setClearing(true);
    try {
      await clearChatHistoryApi();
      setHistory([]);
      setActiveSources([]);
      setHighlightedChunkId(null);
      setError(null);
      setConfirmClearOpen(false);
      pushToast({ kind: "success", title: "Conversation cleared" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to clear conversation history.";
      setError(msg);
      pushToast({ kind: "error", title: "Clear failed", description: msg });
    } finally {
      setClearing(false);
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      pushToast({ kind: "success", title: "Answer copied to clipboard" });
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      pushToast({ kind: "error", title: "Clipboard unavailable" });
    }
  };

  const handleCitationSelect = (chunk: RetrievedChunk, turnSources: RetrievedChunk[]) => {
    setActiveSources(turnSources);
    setHighlightedChunkId(chunk.chunk_id);
    setShowSourcesPanel(true);
    setMobileTab("sources");
  };

  return (
    <AppShell
      activePage="chat"
      onNavigate={onNavigate}
      title="AI Document Chat"
      subtitle="Ask questions grounded strictly in your uploaded PDFs with interactive page citations."
      preferences={preferences}
      headerActions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={history.length === 0}
            onClick={() => setConfirmClearOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--dm-border)] text-xs font-medium text-[var(--dm-text-secondary)] hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Clear Chat</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSourcesPanel((prev) => !prev)}
            className="hidden lg:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-xs font-medium text-[var(--dm-text)] hover:border-violet-400/40 transition-colors whitespace-nowrap tabular-nums"
          >
            {showSourcesPanel ? (
              <PanelRightClose className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
            ) : (
              <PanelRightOpen className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />
            )}
            <span>Sources ({activeSources.length})</span>
          </button>
        </div>
      }
    >
      {/* Mobile View Switcher */}
      <div className="lg:hidden px-4 pt-3 pb-2 border-b border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/60">
        <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)]">
          {(
            [
              { id: "sidebar", label: `Docs (${selectedIndexedDocs.length})` },
              { id: "chat", label: "Chat" },
              { id: "sources", label: `Sources (${activeSources.length})` },
            ] as { id: MobileTab; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMobileTab(tab.id)}
              className={`py-2 rounded-lg text-xs font-medium transition-colors ${
                mobileTab === tab.id
                  ? "bg-violet-500/20 text-[var(--dm-text)] border border-violet-400/35"
                  : "text-[var(--dm-text-muted)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 3-Pane Chat Workspace */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-[calc(100vh-4rem)]">
        {/* Left Sidebar: Document Scope & Conversation History */}
        <aside
          aria-label="Documents and Conversation History"
          className={`${
            mobileTab === "sidebar" ? "flex" : "hidden lg:flex"
          } lg:col-span-3 flex-col border-b lg:border-b-0 lg:border-r border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/55 p-4 gap-4`}
        >
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)]">
            <button
              type="button"
              onClick={() => setSidebarTab("documents")}
              className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sidebarTab === "documents"
                  ? "bg-violet-500/20 text-[var(--dm-text)]"
                  : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>PDFs ({indexedDocs.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setSidebarTab("history")}
              className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sidebarTab === "history"
                  ? "bg-violet-500/20 text-[var(--dm-text)]"
                  : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>History ({history.length})</span>
            </button>
          </div>

          {sidebarTab === "documents" ? (
            <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--dm-text-secondary)]">Retrieval Scope</span>
                <span className="font-mono text-cyan-700 dark:text-cyan-300 tabular-nums">
                  {selectedIndexedDocs.length} active
                </span>
              </div>

              {loadingInit ? (
                <div className="space-y-2">
                  <div className="h-14 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-14 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : documents.length === 0 ? (
                <div className="dm-card p-4 flex flex-col gap-3">
                  <p className="text-xs text-[var(--dm-text-muted)] leading-relaxed">
                    No PDFs uploaded yet. Upload a document to start grounded Q&amp;A.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("documents")}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-cyan-500 text-white text-xs font-semibold"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload PDFs</span>
                  </button>
                </div>
              ) : (
                documents.map((doc) => {
                  const isIndexed = doc.status === "Indexed Successfully";
                  const checked = isIndexed && selectedDocIds.includes(doc.id);
                  return (
                    <label
                      key={doc.id}
                      className={`p-3 rounded-xl border transition-colors flex items-start gap-2.5 ${
                        checked
                          ? "bg-violet-500/10 border-violet-400/45"
                          : "bg-[var(--dm-surface)] border-[var(--dm-border)]"
                      } ${isIndexed ? "cursor-pointer" : "opacity-55 cursor-not-allowed"}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!isIndexed}
                        checked={checked}
                        onChange={() => toggleDoc(doc.id)}
                        className="mt-0.5 rounded accent-violet-500"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--dm-text)] truncate">
                          {doc.filename}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--dm-text-muted)] tabular-nums">
                          {doc.pages || 0} pages · {doc.chunks_count || 0} chunks
                        </p>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
              {history.length === 0 ? (
                <div className="dm-card p-4 text-xs text-[var(--dm-text-muted)] text-center">
                  Your past Q&amp;A turns will appear here once you ask your first question.
                </div>
              ) : (
                history.map((turn) => (
                  <button
                    key={turn.id}
                    type="button"
                    onClick={() => {
                      setActiveSources(turn.sources || []);
                      setHighlightedChunkId(turn.sources?.[0]?.chunk_id ?? null);
                      setShowSourcesPanel(true);
                      setMobileTab("chat");
                    }}
                    className="text-left p-3 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] hover:border-cyan-400/40 transition-colors flex flex-col gap-1"
                  >
                    <span className="text-xs font-medium text-[var(--dm-text)] line-clamp-2">
                      {turn.question}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--dm-text-muted)] tabular-nums">
                      {turn.sources.length} sources cited
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        {/* Central Chat Area */}
        <section
          aria-label="AI Chat Conversation"
          className={`${
            mobileTab === "chat" ? "flex" : "hidden lg:flex"
          } ${
            showSourcesPanel ? "lg:col-span-6" : "lg:col-span-9"
          } flex-col justify-between bg-[var(--dm-bg)]`}
        >
          <div className="flex-1 p-4 sm:p-6 flex flex-col gap-5 overflow-y-auto max-h-[calc(100vh-14.5rem)]">
            {history.length === 0 && !asking && (
              <div className="my-auto max-w-xl mx-auto text-center py-8 flex flex-col items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-400/35 text-cyan-700 dark:text-cyan-300 flex items-center justify-center">
                  <Sparkles className="w-6 h-6" aria-hidden="true" />
                </div>
                <h2 className="font-display text-2xl font-bold text-[var(--dm-text)] text-balance">
                  Ask anything about your documents.
                </h2>
                <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                  Select indexed PDFs on the left and enter a question below. DocuMind retrieves the
                  top {preferences.topK} semantic chunks and synthesizes a Gemini response with
                  clickable page citations.
                </p>
              </div>
            )}

            {history.map((turn) => (
              <React.Fragment key={turn.id}>
                {/* User Message */}
                <div className="flex justify-end">
                  <div className="max-w-xl rounded-2xl rounded-tr-sm px-4 py-3 bg-gradient-to-r from-violet-600/90 to-indigo-600/90 text-white shadow-sm">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{turn.question}</p>
                  </div>
                </div>

                {/* Assistant Message */}
                <div className="flex items-start gap-3 max-w-2xl">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500/25 to-cyan-500/25 border border-violet-400/35 text-cyan-700 dark:text-cyan-300 flex items-center justify-center shrink-0 mt-0.5">
                    <MessageSquareText className="w-4 h-4" aria-hidden="true" />
                  </div>

                  <div className="flex-1 dm-card p-4 sm:p-5 flex flex-col gap-3.5 min-w-0">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-display font-semibold text-[var(--dm-text)]">
                        DocuMind Assistant
                      </span>
                      <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 tabular-nums">
                        {turn.sources.length} source{turn.sources.length === 1 ? "" : "s"} retrieved
                      </span>
                    </div>

                    <MarkdownRenderer
                      content={turn.answer}
                      sources={turn.sources}
                      onSelectCitation={(chunk) => handleCitationSelect(chunk, turn.sources)}
                    />

                    {/* Expandable Retrieved Passages */}
                    {turn.sources.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {turn.sources.map((src, idx) => (
                          <details
                            key={src.chunk_id}
                            className="rounded-xl bg-[var(--dm-bg-secondary)]/80 border border-[var(--dm-border)] px-3 py-2"
                          >
                            <summary className="cursor-pointer text-xs font-medium text-[var(--dm-text-secondary)] flex items-center justify-between gap-2">
                              <span className="truncate">
                                Source {idx + 1}: {src.filename} · Page {src.page_number}
                              </span>
                              <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 shrink-0 tabular-nums">
                                {(src.similarity * 100).toFixed(1)}%
                              </span>
                            </summary>
                            <p className="mt-2 pt-2 border-t border-[var(--dm-border)] text-xs text-[var(--dm-text-muted)] leading-relaxed">
                              {src.text}
                            </p>
                          </details>
                        ))}
                      </div>
                    )}

                    {/* Message Actions */}
                    <div className="pt-2.5 border-t border-[var(--dm-border)] flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(turn.id, turn.answer)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
                      >
                        {copiedId === turn.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedId === turn.id ? "Copied" : "Copy answer"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={asking}
                        onClick={() => submitQuestion(turn.question)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-40 transition-colors"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Regenerate</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSources(turn.sources);
                          setHighlightedChunkId(turn.sources?.[0]?.chunk_id ?? null);
                          setShowSourcesPanel(true);
                          setMobileTab("sources");
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10 transition-colors"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>Inspect Sources</span>
                      </button>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            ))}

            {/* Animated Typing Indicator */}
            {asking && (
              <div className="flex items-start gap-3 max-w-md">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500/25 to-cyan-500/25 border border-violet-400/35 text-cyan-700 dark:text-cyan-300 flex items-center justify-center shrink-0">
                  <MessageSquareText className="w-4 h-4" aria-hidden="true" />
                </div>
                <div className="dm-card px-4 py-3 flex items-center gap-3">
                  <div className="flex items-center gap-1" aria-hidden="true">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-dm-typing" />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-dm-typing"
                      style={{ animationDelay: "0.18s" }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-dm-typing"
                      style={{ animationDelay: "0.36s" }}
                    />
                  </div>
                  <span className="text-xs text-[var(--dm-text-muted)]">
                    Retrieving top {preferences.topK} chunks &amp; generating Gemini response...
                  </span>
                </div>
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
            <div ref={bottomRef} />
          </div>

          {/* Suggested Prompts + Input Form */}
          <div className="p-4 border-t border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/70 backdrop-blur-md flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setQuestionInput(prompt)}
                  className="px-3 py-1.5 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] hover:border-violet-400/45 text-xs text-[var(--dm-text-secondary)] hover:text-[var(--dm-text)] transition-colors text-left"
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
              className="flex items-center gap-2.5"
            >
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                placeholder="Ask a question grounded in your selected PDFs..."
                className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-violet-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={asking || !questionInput.trim()}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-cyan-500 hover:from-violet-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all disabled:opacity-45 shrink-0 whitespace-nowrap"
              >
                <span className="hidden sm:inline">{asking ? "Thinking..." : "Send"}</span>
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </section>

        {/* Right Panel: Retrieved Sources & Citation Inspector */}
        {(showSourcesPanel || mobileTab === "sources") && (
          <aside
            aria-label="Retrieved Document Sources"
            className={`${
              mobileTab === "sources" ? "flex" : "hidden"
            } ${
              showSourcesPanel ? "lg:flex" : "lg:hidden"
            } lg:col-span-3 flex-col border-t lg:border-t-0 lg:border-l border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/55 p-4 gap-3.5`}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-[var(--dm-text)]">
                Retrieved Context
              </h2>
              <span className="font-mono text-xs text-cyan-700 dark:text-cyan-300 tabular-nums">
                Top {activeSources.length || preferences.topK}
              </span>
            </div>

            {activeSources.length === 0 ? (
              <div className="dm-card p-4 text-xs text-[var(--dm-text-muted)] leading-relaxed">
                Ask a question or click any citation badge in an answer to inspect the retrieved PDF
                passages, page numbers, and similarity scores.
              </div>
            ) : (
              <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto max-h-[calc(100vh-14.5rem)]">
                {activeSources.map((src) => {
                  const isHighlighted = highlightedChunkId === src.chunk_id;
                  return (
                    <article
                      key={src.chunk_id}
                      onClick={() => setHighlightedChunkId(src.chunk_id)}
                      className={`p-3.5 rounded-xl border cursor-pointer transition-all flex flex-col gap-2 ${
                        isHighlighted
                          ? "bg-cyan-500/10 border-cyan-400/55 shadow-[0_0_20px_-8px_rgba(34,211,238,0.65)]"
                          : "bg-[var(--dm-surface)] border-[var(--dm-border)] hover:border-violet-400/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-[var(--dm-text)] truncate">
                          {src.filename}
                        </span>
                        <span className="font-mono text-[11px] text-cyan-700 dark:text-cyan-300 shrink-0 tabular-nums">
                          {(src.similarity * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-[var(--dm-text-muted)]">
                        <span>Page {src.page_number}</span>
                        <span>Rank #{src.rank}</span>
                      </div>
                      <p className="text-xs text-[var(--dm-text-secondary)] leading-relaxed">
                        {src.text}
                      </p>
                    </article>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                const lastQ = history[history.length - 1]?.question || "";
                if (lastQ) onInspectQuery(lastQ);
                onNavigate("retrieval");
              }}
              className="mt-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-[var(--dm-border)] bg-[var(--dm-surface)] hover:border-violet-400/45 text-xs font-semibold text-cyan-700 dark:text-cyan-300 transition-colors"
            >
              <span>Inspect in Pipeline</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear Conversation History?"
        description="This will remove all saved Q&A turns in your workspace history. Your uploaded PDFs and indexed vectors will remain intact."
        confirmLabel="Clear History"
        busy={clearing}
        onCancel={() => setConfirmClearOpen(false)}
        onConfirm={confirmClearChat}
      />
    </AppShell>
  );
};
