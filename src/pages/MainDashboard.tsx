import React, { useCallback, useEffect, useState } from "react";
import { deleteDocumentById, fetchDashboardStats } from "../api";
import { AppShell, AvatarBadge } from "../components/AppShell";
import { DashboardStats, ProcessingStatus, RoutePage, UserPreferences } from "../types";

interface MainDashboardProps {
  onNavigate: (page: RoutePage) => void;
  onSelectDocumentForChat: (documentId: string) => void;
  preferences: UserPreferences;
}

function formatStatusStyle(status: ProcessingStatus): string {
  if (status === "Indexed Successfully") {
    return "bg-success-container text-on-success-container";
  }
  if (status === "Failed") {
    return "bg-light-error-container text-light-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container";
  }
  return "bg-warning-container text-on-warning-container";
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

export const MainDashboard: React.FC<MainDashboardProps> = ({
  onNavigate,
  onSelectDocumentForChat,
  preferences,
}) => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchDashboardStats();
      setStats(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard statistics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleDelete = async (documentId: string) => {
    setDeletingId(documentId);
    try {
      await deleteDocumentById(documentId);
      await loadStats();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete document.");
    } finally {
      setDeletingId(null);
    }
  };

  const filteredDocs = (stats?.recent_documents ?? []).filter((doc) =>
    doc.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AppShell
      activePage="dashboard"
      onNavigate={onNavigate}
      title="Welcome to DocuMind"
      subtitle="Your intelligent document workspace."
      preferences={preferences}
      headerActions={
        <>
          <div className="hidden md:block relative w-64">
            <span
              className="material-symbols-outlined text-light-outline dark:text-dark-outline text-[18px] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            >
              search
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter documents..."
              aria-label="Filter documents"
              className="w-full pl-9 pr-3 py-1.5 rounded bg-light-surface-container-low dark:bg-dark-surface-container-low border border-light-outline-variant/70 dark:border-dark-outline-variant/70 text-light-on-surface dark:text-dark-on-surface placeholder:text-light-outline dark:placeholder:text-dark-outline font-body text-body-sm focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => onNavigate("settings")}
            aria-label="Profile settings"
            className="inline-flex items-center p-1 rounded-full hover:bg-light-surface-container dark:hover:bg-dark-surface-container transition-colors duration-state-change"
          >
            <AvatarBadge size="sm" name={preferences.displayName} />
          </button>
        </>
      }
    >
      <main className="flex-1 p-gutter-md lg:p-gutter-lg max-w-7xl w-full mx-auto flex flex-col gap-gutter-lg">
        {/* Action Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-md bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-md shadow-sm">
          <div className="flex flex-col gap-gutter-xs">
            <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
              Live RAG Workspace Overview
            </span>
            <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              All metrics below reflect your actual uploaded PDFs, extracted pages, vector chunks, and
              grounded Q&amp;A sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("documents")}
            className="inline-flex items-center justify-center gap-gutter-sm px-gutter-md py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm shrink-0 whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              upload_file
            </span>
            <span>Upload New Document</span>
          </button>
        </div>

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

        {/* Summary Metric Cards */}
        <section
          aria-label="Workspace Summary Metrics"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-gutter-md items-stretch"
        >
          {[
            {
              label: "Total Documents",
              value: stats?.total_documents ?? 0,
              sub: `${stats?.indexed_documents ?? 0} indexed and ready`,
              icon: "description",
              color: "text-light-primary dark:text-dark-primary",
            },
            {
              label: "Total Pages Processed",
              value: stats?.total_pages_processed ?? 0,
              sub: "Extracted PDF pages",
              icon: "auto_stories",
              color: "text-light-secondary dark:text-dark-secondary",
            },
            {
              label: "Total Chunks Indexed",
              value: stats?.total_chunks_indexed ?? 0,
              sub: "Stored vector embeddings",
              icon: "hub",
              color: "text-light-primary dark:text-dark-primary",
            },
            {
              label: "Questions Answered",
              value: stats?.questions_answered ?? 0,
              sub: "Grounded Gemini Q&A turns",
              icon: "forum",
              color: "text-light-secondary dark:text-dark-secondary",
            },
          ].map((metric) => (
            <article
              key={metric.label}
              className="h-full bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col justify-between gap-gutter-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  {metric.label}
                </span>
                <span className={`material-symbols-outlined ${metric.color} text-[20px]`} aria-hidden="true">
                  {metric.icon}
                </span>
              </div>
              <div>
                <p className="font-headline text-headline-lg text-light-on-surface dark:text-dark-on-surface tabular-nums">
                  {loading ? "—" : metric.value.toLocaleString()}
                </p>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  {metric.sub}
                </p>
              </div>
            </article>
          ))}
        </section>

        {/* Two-Column Workspace Content */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-gutter-lg items-start">
          {/* Recent Documents Table */}
          <section className="xl:col-span-8 bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md shadow-sm overflow-hidden">
            <div className="p-gutter-lg border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50 flex items-center justify-between gap-gutter-md">
              <div>
                <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                  Recent Documents
                </h2>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Uploaded PDFs and their current indexing status.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("documents")}
                className="font-label text-label-lg text-light-primary dark:text-dark-primary hover:underline whitespace-nowrap shrink-0"
              >
                Manage All
              </button>
            </div>

            {loading ? (
              <div className="p-gutter-lg flex flex-col gap-gutter-sm">
                <div className="h-10 rounded bg-light-surface-container dark:bg-dark-surface-container animate-pulse" />
                <div className="h-10 rounded bg-light-surface-container dark:bg-dark-surface-container animate-pulse" />
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="p-gutter-xl text-center flex flex-col items-center gap-gutter-sm">
                <span className="material-symbols-outlined text-light-on-surface-variant dark:text-dark-on-surface-variant text-[32px]" aria-hidden="true">
                  folder_off
                </span>
                <p className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                  {searchQuery ? "No matching documents found" : "No documents uploaded yet"}
                </p>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant max-w-md">
                  {searchQuery
                    ? "Try clearing your search filter."
                    : "Upload PDF documents to extract text, generate vector embeddings, and start asking questions."}
                </p>
                {!searchQuery && (
                  <button
                    type="button"
                    onClick={() => onNavigate("documents")}
                    className="mt-gutter-xs px-gutter-md py-2 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary font-label text-label-md hover:bg-light-primary-container transition-colors"
                  >
                    Upload First PDF
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50 bg-light-surface-container-low/60 dark:bg-dark-surface-container/60">
                      <th className="py-3 px-gutter-md font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                        Document Name
                      </th>
                      <th className="py-3 px-gutter-md font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                        Pages
                      </th>
                      <th className="py-3 px-gutter-md font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                        Upload Date
                      </th>
                      <th className="py-3 px-gutter-md font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                        Status
                      </th>
                      <th className="py-3 px-gutter-md font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-light-outline-variant/40 dark:divide-dark-outline-variant/40">
                    {filteredDocs.map((doc) => (
                      <tr
                        key={doc.id}
                        className="hover:bg-light-surface-container-low/40 dark:hover:bg-dark-surface-container/40 transition-colors duration-state-change"
                      >
                        <td className="py-3.5 px-gutter-md">
                          <div className="flex items-center gap-gutter-sm">
                            <span
                              className="material-symbols-outlined text-light-primary dark:text-dark-primary text-[20px] shrink-0"
                              aria-hidden="true"
                            >
                              picture_as_pdf
                            </span>
                            <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface truncate max-w-[260px]">
                              {doc.filename}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-gutter-md font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums">
                          {doc.pages || "—"}
                        </td>
                        <td className="py-3.5 px-gutter-md font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums whitespace-nowrap">
                          {formatDate(doc.uploaded_at)}
                        </td>
                        <td className="py-3.5 px-gutter-md">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded font-label text-label-sm whitespace-nowrap ${formatStatusStyle(
                              doc.status
                            )}`}
                          >
                            {doc.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-gutter-md text-right">
                          <div className="inline-flex items-center gap-gutter-xs">
                            {doc.status === "Indexed Successfully" && (
                              <button
                                type="button"
                                onClick={() => {
                                  onSelectDocumentForChat(doc.id);
                                  onNavigate("chat");
                                }}
                                aria-label={`Chat with ${doc.filename}`}
                                title="Ask questions about this document"
                                className="p-1.5 rounded text-light-primary dark:text-dark-primary hover:bg-light-surface-container dark:hover:bg-dark-surface-container"
                              >
                                <span className="material-symbols-outlined text-[18px]">chat</span>
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={deletingId === doc.id}
                              onClick={() => handleDelete(doc.id)}
                              aria-label={`Delete ${doc.filename}`}
                              title="Delete document and vectors"
                              className="p-1.5 rounded text-light-error dark:text-dark-error hover:bg-light-error-container/40 disabled:opacity-50"
                            >
                              <span className="material-symbols-outlined text-[18px]">delete</span>
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

          {/* Recent Conversations */}
          <section className="xl:col-span-4 bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md shadow-sm flex flex-col">
            <div className="p-gutter-lg border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50 flex items-center justify-between gap-gutter-sm">
              <h2 className="font-headline text-title-lg text-light-on-surface dark:text-dark-on-surface truncate">
                Recent Conversations
              </h2>
              <button
                type="button"
                onClick={() => onNavigate("chat")}
                className="font-label text-label-md text-light-primary dark:text-dark-primary hover:underline shrink-0"
              >
                Open Chat
              </button>
            </div>
            <div className="p-gutter-md flex flex-col gap-gutter-sm">
              {(stats?.recent_conversations ?? []).length === 0 ? (
                <div className="p-gutter-md text-center flex flex-col items-center gap-gutter-xs">
                  <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                    No questions asked yet. Start a conversation in AI Chat or run a RAG vs. Without RAG
                    comparison.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate("chat")}
                    className="mt-gutter-xs font-label text-label-md text-light-primary dark:text-dark-primary hover:underline"
                  >
                    Ask your first question
                  </button>
                </div>
              ) : (
                stats!.recent_conversations.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => onNavigate("chat")}
                    className="text-left p-gutter-md rounded border border-light-outline-variant/50 dark:border-dark-outline-variant/50 hover:border-light-primary hover:bg-light-surface-container-low/50 dark:hover:bg-dark-surface-container/50 transition-colors duration-state-change flex flex-col gap-gutter-xs"
                  >
                    <div className="flex items-center justify-between gap-gutter-sm">
                      <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface truncate">
                        {conv.question}
                      </span>
                      <span className="font-label text-label-sm text-light-on-surface-variant dark:text-dark-on-surface-variant shrink-0 tabular-nums">
                        {conv.sources.length} sources
                      </span>
                    </div>
                    <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant line-clamp-2">
                      {conv.answer}
                    </p>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
};
