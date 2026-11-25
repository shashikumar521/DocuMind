import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  MessageSquareText,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { deleteDocumentById, fetchDashboardStats } from "../api";
import { AnimatedCounter } from "../components/AnimatedCounter";
import { AppShell, AvatarBadge } from "../components/AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DocuMindMark } from "../components/DocuMindLogo";
import { useToast } from "../components/ToastProvider";
import {
  DashboardStats,
  DocuMindDocument,
  ProcessingStatus,
  RoutePage,
  UserPreferences,
} from "../types";

interface MainDashboardProps {
  onNavigate: (page: RoutePage) => void;
  onSelectDocumentForChat: (documentId: string) => void;
  preferences: UserPreferences;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function StatusDisplay({ status }: { status: ProcessingStatus }) {
  if (status === "Indexed Successfully") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Indexed</span>
      </span>
    );
  }
  if (status === "Failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400 whitespace-nowrap">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Failed</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export const MainDashboard: React.FC<MainDashboardProps> = ({
  onNavigate,
  onSelectDocumentForChat,
  preferences,
}) => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DocuMindDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { pushToast } = useToast();

  const loadStats = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchDashboardStats();
      setStats(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workspace statistics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteDocumentById(pendingDelete.id);
      pushToast({
        kind: "success",
        title: "Document deleted",
        description: `Removed "${pendingDelete.filename}" and its indexed vectors.`,
      });
      setPendingDelete(null);
      await loadStats();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete document.";
      setError(msg);
      pushToast({ kind: "error", title: "Delete failed", description: msg });
    } finally {
      setDeleting(false);
    }
  };

  const filteredDocs = (stats?.recent_documents ?? []).filter((doc) =>
    doc.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const firstName = preferences.displayName.split(" ")[0] || "there";

  return (
    <AppShell
      activePage="dashboard"
      onNavigate={onNavigate}
      title={`Welcome back, ${firstName}`}
      subtitle="Live overview of your indexed PDF knowledge base and grounded Q&A sessions."
      preferences={preferences}
      headerActions={
        <>
          <div className="hidden md:block relative w-64">
            <Search
              className="w-4 h-4 text-[var(--dm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents..."
              aria-label="Search recent documents"
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={() => onNavigate("documents")}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-xs sm:text-sm font-semibold transition-all whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">Upload Document</span>
            <span className="sm:hidden">Upload</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate("settings")}
            aria-label="Workspace profile and settings"
            className="hidden sm:inline-flex rounded-full p-0.5 hover:ring-2 hover:ring-blue-400/50 transition-all"
          >
            <AvatarBadge size="sm" name={preferences.displayName} />
          </button>
        </>
      }
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Mobile search */}
        <div className="md:hidden relative">
          <Search
            className="w-4 h-4 text-[var(--dm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search recent documents..."
            aria-label="Search recent documents"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
          />
        </div>

        {error && (
          <div
            role="alert"
            className="p-4 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-3 text-sm"
          >
            <AlertCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Statistics Cards */}
        <section
          aria-label="Workspace Statistics"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
        >
          {[
            {
              label: "Total Documents",
              value: stats?.total_documents ?? 0,
              sub: `${stats?.indexed_documents ?? 0} indexed and ready`,
              icon: FileText,
              tone: "text-blue-700 dark:text-blue-300 bg-blue-500/15 border-blue-400/25",
            },
            {
              label: "Indexed Pages",
              value: stats?.total_pages_processed ?? 0,
              sub: "Extracted across uploaded PDFs",
              icon: BookOpen,
              tone: "text-cyan-700 dark:text-cyan-300 bg-cyan-500/15 border-cyan-400/25",
            },
            {
              label: "Total Text Chunks",
              value: stats?.total_chunks_indexed ?? 0,
              sub: "Stored vector embeddings",
              icon: Layers,
              tone: "text-blue-700 dark:text-blue-300 bg-blue-500/15 border-blue-400/25",
            },
            {
              label: "Successful Queries",
              value: stats?.questions_answered ?? 0,
              sub: "Grounded AI responses",
              icon: MessageSquareText,
              tone: "text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 border-emerald-400/25",
            },
          ].map((metric) => {
            const Icon = metric.icon;
            return (
              <article
                key={metric.label}
                className="dm-card p-5 flex flex-col justify-between gap-4 hover:border-blue-400/30 transition-colors duration-150"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--dm-text-muted)]">
                    {metric.label}
                  </span>
                  <span
                    className={`w-9 h-9 rounded-xl border flex items-center justify-center ${metric.tone}`}
                  >
                    <Icon className="w-4 h-4" aria-hidden="true" />
                  </span>
                </div>
                <div>
                  {loading ? (
                    <div className="h-8 w-20 rounded-lg bg-white/5 animate-pulse" />
                  ) : (
                    <p className="font-display text-3xl font-bold text-[var(--dm-text)] tabular-nums">
                      <AnimatedCounter value={metric.value} />
                    </p>
                  )}
                  <p className="mt-1 text-xs text-[var(--dm-text-muted)]">{metric.sub}</p>
                </div>
              </article>
            );
          })}
        </section>

        {/* Main Workspace Split */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Recent Documents & Processing Status */}
          <section className="xl:col-span-8 dm-card overflow-hidden">
            <div className="p-5 sm:p-6 border-b border-[var(--dm-border)] flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-base sm:text-lg font-semibold text-[var(--dm-text)]">
                  Recent Documents
                </h2>
                <p className="text-xs sm:text-sm text-[var(--dm-text-muted)]">
                  Recently processed PDFs, indexing status, and chunk counts.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("documents")}
                className="text-xs sm:text-sm font-medium text-cyan-700 dark:text-cyan-300 hover:text-cyan-600 dark:hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
              >
                Manage All
              </button>
            </div>

            {loading ? (
              <div className="p-5 space-y-3">
                {[1, 2, 3].map((row) => (
                  <div key={row} className="h-12 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                ))}
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="p-10 text-center flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-400/25 flex items-center justify-center">
                  <DocuMindMark size="md" />
                </div>
                <p className="font-display text-base font-semibold text-[var(--dm-text)]">
                  {searchQuery ? "No matching documents found" : "No documents indexed yet"}
                </p>
                <p className="text-sm text-[var(--dm-text-muted)] max-w-md">
                  {searchQuery
                    ? "Try adjusting or clearing your document filter."
                    : "Upload your first PDF to extract pages, generate vector embeddings, and start asking citation-backed questions."}
                </p>
                {!searchQuery && (
                  <button
                    type="button"
                    onClick={() => onNavigate("documents")}
                    className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all"
                  >
                    <Upload className="w-4 h-4" />
                    <span>Upload First PDF</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/60 text-xs font-medium text-[var(--dm-text-muted)]">
                      <th className="py-3 px-5">Document</th>
                      <th className="py-3 px-4 text-right">Pages</th>
                      <th className="py-3 px-4 text-right">Chunks</th>
                      <th className="py-3 px-4">Uploaded</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--dm-border)] text-sm">
                    {filteredDocs.map((doc) => (
                      <tr
                        key={doc.id}
                        className="hover:bg-slate-900/[0.03] dark:hover:bg-white/[0.025] transition-colors"
                      >
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <FileText
                              className="w-4 h-4 text-blue-700 dark:text-blue-300 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="font-medium text-[var(--dm-text)] truncate max-w-[240px]">
                              {doc.filename}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-xs text-[var(--dm-text-secondary)] tabular-nums">
                          {doc.pages || "—"}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-xs text-[var(--dm-text-secondary)] tabular-nums">
                          {doc.chunks_count || "—"}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-[var(--dm-text-muted)] whitespace-nowrap tabular-nums">
                          {formatDate(doc.uploaded_at)}
                        </td>
                        <td className="py-3.5 px-4">
                          <StatusDisplay status={doc.status} />
                        </td>
                        <td className="py-3.5 px-5 text-right">
                          <div className="inline-flex items-center gap-1">
                            {doc.status === "Indexed Successfully" && (
                              <button
                                type="button"
                                onClick={() => {
                                  onSelectDocumentForChat(doc.id);
                                  onNavigate("chat");
                                }}
                                aria-label={`Chat with ${doc.filename}`}
                                title="Ask AI about this document"
                                className="p-2 rounded-lg text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/15 transition-colors"
                              >
                                <MessageSquareText className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setPendingDelete(doc)}
                              aria-label={`Delete ${doc.filename}`}
                              title="Delete document and vectors"
                              className="p-2 rounded-lg text-red-700 dark:text-red-400 hover:bg-red-500/15 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent Chat Activity */}
          <section className="xl:col-span-4 dm-card flex flex-col">
            <div className="p-5 sm:p-6 border-b border-[var(--dm-border)] flex items-center justify-between gap-2">
              <h2 className="font-display text-base sm:text-lg font-semibold text-[var(--dm-text)] truncate">
                Recent Chat Activity
              </h2>
              <button
                type="button"
                onClick={() => onNavigate("chat")}
                className="text-xs sm:text-sm font-medium text-cyan-700 dark:text-cyan-300 hover:text-cyan-600 dark:hover:text-cyan-200 whitespace-nowrap shrink-0"
              >
                Open Chat
              </button>
            </div>

            <div className="p-4 flex flex-col gap-3">
              {loading ? (
                <div className="space-y-3">
                  <div className="h-20 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                  <div className="h-20 rounded-xl bg-slate-900/5 dark:bg-white/5 animate-pulse" />
                </div>
              ) : (stats?.recent_conversations ?? []).length === 0 ? (
                <div className="p-6 text-center flex flex-col items-center gap-2.5">
                  <MessageSquareText
                    className="w-7 h-7 text-[var(--dm-text-muted)]"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-[var(--dm-text-muted)]">
                    No conversations yet. Ask a question in AI Chat or evaluate responses in RAG Comparison.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("chat")}
                    className="mt-1 text-xs font-semibold text-cyan-700 dark:text-cyan-300 hover:text-cyan-600 dark:hover:text-cyan-200"
                  >
                    Start a Conversation
                  </button>
                </div>
              ) : (
                stats!.recent_conversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => onNavigate("chat")}
                    className="text-left p-3.5 rounded-xl bg-[var(--dm-bg-secondary)]/70 border border-[var(--dm-border)] hover:border-blue-400/40 transition-colors flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-[var(--dm-text-muted)]">
                      <span className="truncate font-medium text-[var(--dm-text)]">
                        {conv.question}
                      </span>
                      <span className="font-mono shrink-0 tabular-nums">
                        {conv.sources.length} src
                      </span>
                    </div>
                    <p className="text-xs text-[var(--dm-text-muted)] line-clamp-2 leading-relaxed">
                      {conv.answer}
                    </p>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      </main>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete Document & Vectors?"
        description={
          pendingDelete
            ? `This will permanently remove "${pendingDelete.filename}", its ${pendingDelete.chunks_count} indexed vector chunks, and the uploaded PDF file.`
            : ""
        }
        confirmLabel="Delete Document"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </AppShell>
  );
};
