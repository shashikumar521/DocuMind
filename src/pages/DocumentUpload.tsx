import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  AlertCircle,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquareText,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { deleteDocumentById, fetchDocuments, uploadPdfFiles } from "../api";
import { AppShell } from "../components/AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DocuMindMark } from "../components/DocuMindLogo";
import { useToast } from "../components/ToastProvider";
import { DocuMindDocument, ProcessingStatus, RoutePage, UserPreferences } from "../types";

interface DocumentUploadProps {
  onNavigate: (page: RoutePage) => void;
  onSelectDocumentForChat: (documentId: string) => void;
  preferences: UserPreferences;
}

const MAX_BYTES = 25 * 1024 * 1024;

type StatusFilter = "all" | "indexed" | "processing" | "failed";
type SortBy = "newest" | "oldest" | "name" | "pages" | "chunks";

const UPLOAD_SEQUENCE: {
  label: string;
  statuses: ProcessingStatus[];
}[] = [
  { label: "1. Uploading PDF", statuses: ["Uploaded"] },
  { label: "2. Extracting document text", statuses: ["Extracting Text"] },
  { label: "3. Splitting text into chunks", statuses: ["Chunking"] },
  { label: "4. Generating embeddings", statuses: ["Generating Embeddings"] },
  { label: "5. Indexing vectors", statuses: ["Indexing Vectors"] },
  { label: "6. Document ready for AI questions", statuses: ["Indexed Successfully"] },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function getStageIndex(status?: ProcessingStatus): number {
  if (!status) return -1;
  const idx = UPLOAD_SEQUENCE.findIndex((s) => s.statuses.includes(status));
  return idx;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({
  onNavigate,
  onSelectDocumentForChat,
  preferences,
}) => {
  const [documents, setDocuments] = useState<DocuMindDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [pendingDelete, setPendingDelete] = useState<DocuMindDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { pushToast } = useToast();

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await fetchDocuments();
      setDocuments(docs);
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : "Failed to load documents.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  // Poll real backend processing status while uploading or while a doc is indexing
  useEffect(() => {
    const hasInProgress =
      uploading ||
      documents.some((d) => d.status !== "Indexed Successfully" && d.status !== "Failed");
    if (!hasInProgress) return;
    const timer = setInterval(() => {
      loadDocuments();
    }, 650);
    return () => clearInterval(timer);
  }, [uploading, documents, loadDocuments]);

  const activeDoc = useMemo(() => {
    const inProgress = documents.find(
      (d) => d.status !== "Indexed Successfully" && d.status !== "Failed"
    );
    if (inProgress) return inProgress;
    if (pendingNames.length > 0) {
      return documents.find((d) => pendingNames.includes(d.filename));
    }
    return documents[0];
  }, [documents, pendingNames]);

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setValidationError(null);
    setSuccessMessage(null);

    for (const f of files) {
      if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
        const msg = `"${f.name}" is an unsupported file type. Only PDF files are accepted.`;
        setValidationError(msg);
        pushToast({ kind: "error", title: "Invalid file type", description: msg });
        return;
      }
      if (f.size === 0) {
        const msg = `"${f.name}" is empty (0 bytes).`;
        setValidationError(msg);
        pushToast({ kind: "error", title: "Empty file", description: msg });
        return;
      }
      if (f.size > MAX_BYTES) {
        const msg = `"${f.name}" exceeds the 25 MB upload limit.`;
        setValidationError(msg);
        pushToast({ kind: "error", title: "File too large", description: msg });
        return;
      }
    }

    setUploading(true);
    setPendingNames(files.map((f) => f.name));
    try {
      const res = await uploadPdfFiles(files);
      await loadDocuments();
      if (res.errors && res.errors.length > 0) {
        const errMsg = res.errors.map((e) => `${e.filename}: ${e.detail}`).join(" | ");
        setValidationError(errMsg);
        pushToast({ kind: "error", title: "Upload issue", description: errMsg });
      }
      if (res.documents && res.documents.length > 0) {
        const msg = `Successfully indexed ${res.documents.length} PDF${
          res.documents.length > 1 ? "s" : ""
        }.`;
        setSuccessMessage(msg);
        pushToast({ kind: "success", title: "PDF Indexed", description: msg });
      }
    } catch (err: unknown) {
      await loadDocuments();
      const msg = err instanceof Error ? err.message : "Failed to upload and index PDF.";
      setValidationError(msg);
      pushToast({ kind: "error", title: "Indexing failed", description: msg });
    } finally {
      setUploading(false);
      setPendingNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setValidationError(null);
    try {
      await deleteDocumentById(pendingDelete.id);
      pushToast({
        kind: "success",
        title: "Document removed",
        description: `Deleted "${pendingDelete.filename}" and its vector chunks.`,
      });
      setPendingDelete(null);
      await loadDocuments();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete document.";
      setValidationError(msg);
      pushToast({ kind: "error", title: "Delete failed", description: msg });
    } finally {
      setDeleting(false);
    }
  };

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = documents.filter((d) => {
      if (q && !d.filename.toLowerCase().includes(q)) return false;
      if (statusFilter === "indexed") return d.status === "Indexed Successfully";
      if (statusFilter === "failed") return d.status === "Failed";
      if (statusFilter === "processing") {
        return d.status !== "Indexed Successfully" && d.status !== "Failed";
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortBy === "oldest") return a.uploaded_at.localeCompare(b.uploaded_at);
      if (sortBy === "name") return a.filename.localeCompare(b.filename);
      if (sortBy === "pages") return b.pages - a.pages;
      if (sortBy === "chunks") return b.chunks_count - a.chunks_count;
      return b.uploaded_at.localeCompare(a.uploaded_at);
    });
  }, [documents, search, statusFilter, sortBy]);

  const activeStageIndex = uploading
    ? Math.max(0, getStageIndex(activeDoc?.status))
    : activeDoc
    ? getStageIndex(activeDoc.status)
    : -1;

  return (
    <AppShell
      activePage="documents"
      onNavigate={onNavigate}
      title="My Documents"
      subtitle="Upload PDFs, monitor real-time chunking & embedding progress, and manage your vector library."
      preferences={preferences}
      headerActions={
        documents.some((d) => d.status === "Indexed Successfully") ? (
          <button
            type="button"
            onClick={() => onNavigate("chat")}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/35 text-xs sm:text-sm font-medium text-blue-700 dark:text-blue-200 transition-colors whitespace-nowrap"
          >
            <MessageSquareText className="w-4 h-4" />
            <span>Open AI Chat</span>
          </button>
        ) : undefined
      }
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Upload Dropzone */}
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
          }}
          className={`dm-card p-6 sm:p-8 border-2 border-dashed transition-all duration-150 flex flex-col items-center text-center gap-4 ${
            isDragging
              ? "border-cyan-400 bg-cyan-500/10"
              : "border-blue-400/35 hover:border-blue-400/60"
          }`}
        >
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-400/30 text-cyan-700 dark:text-cyan-300 flex items-center justify-center">
            {uploading ? (
              <Loader2 className="w-7 h-7 animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud className="w-7 h-7" aria-hidden="true" />
            )}
          </div>

          <div className="max-w-xl space-y-1.5">
            <h2 className="font-display text-lg sm:text-xl font-semibold text-[var(--dm-text)]">
              {uploading ? "Processing & Indexing PDFs..." : "Drag & drop PDF files here"}
            </h2>
            <p className="text-xs sm:text-sm text-[var(--dm-text-muted)] leading-relaxed">
              Accepts text-selectable <span className="font-mono text-[var(--dm-text-secondary)]">.pdf</span> files up to{" "}
              <span className="font-mono text-[var(--dm-text-secondary)]">25 MB</span> (up to 10 per batch). Pages are extracted, split into overlapping chunks, embedded with Gemini, and persisted to vector storage.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <label
              htmlFor="pdf-file-input"
              className={`cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold shadow-[0_10px_28px_-10px_rgba(37,99,235,0.75)] transition-all whitespace-nowrap ${
                uploading ? "opacity-60 pointer-events-none" : ""
              }`}
            >
              <FolderOpen className="w-4 h-4" />
              <span>{uploading ? "Indexing..." : "Browse PDF Files"}</span>
              <input
                ref={fileInputRef}
                id="pdf-file-input"
                type="file"
                accept=".pdf,application/pdf"
                multiple
                disabled={uploading}
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                }}
                className="hidden"
              />
            </label>
          </div>

          {uploading && pendingNames.length > 0 && (
            <p className="font-mono text-xs text-cyan-700 dark:text-cyan-300">
              Active upload: {pendingNames.join(", ")}
            </p>
          )}

          {validationError && (
            <div
              role="alert"
              className="w-full max-w-2xl p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 flex items-center gap-2.5 text-left text-xs sm:text-sm"
            >
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{validationError}</span>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              className="w-full max-w-2xl p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 flex items-center gap-2.5 text-left text-xs sm:text-sm"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{successMessage}</span>
            </div>
          )}
        </section>

        {/* Animated 6-Step Real Backend Processing Sequence */}
        <section aria-label="Indexing Pipeline Stages" className="dm-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h3 className="font-display text-sm font-semibold text-[var(--dm-text)]">
              Document Processing Sequence
            </h3>
            <span className="font-mono text-xs text-[var(--dm-text-muted)]">
              {activeDoc
                ? `${activeDoc.filename} · ${activeDoc.status} (${activeDoc.progress}%)`
                : "Awaiting PDF upload"}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
            {UPLOAD_SEQUENCE.map((stage, idx) => {
              const failed = activeDoc?.status === "Failed";
              const isCompleted = !failed && activeStageIndex > idx;
              const isCurrent = !failed && activeStageIndex === idx;
              const isDoneAll = !failed && activeDoc?.status === "Indexed Successfully" && idx === 5;

              return (
                <div
                  key={stage.label}
                  className={`p-3 rounded-xl border text-xs transition-all duration-200 flex items-center gap-2 ${
                    isDoneAll || isCompleted
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                      : isCurrent
                      ? "bg-blue-500/15 border-blue-400/50 text-cyan-700 dark:text-cyan-200"
                      : "bg-[var(--dm-bg-secondary)]/70 border-[var(--dm-border)] text-[var(--dm-text-muted)]"
                  }`}
                >
                  {isDoneAll || isCompleted ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  ) : isCurrent ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 shrink-0 opacity-60" />
                  )}
                  <span className="font-medium leading-tight">{stage.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Library Toolbar: Search, Filter, Sort */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-display text-lg font-semibold text-[var(--dm-text)] tabular-nums">
                Document Library ({filteredAndSorted.length})
              </h2>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              {/* Search */}
              <div className="relative">
                <Search
                  className="w-4 h-4 text-[var(--dm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by filename..."
                  aria-label="Filter documents by filename"
                  className="w-full sm:w-56 pl-9 pr-3 py-2 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-xs sm:text-sm text-[var(--dm-text)] placeholder:text-[var(--dm-text-muted)] focus:border-blue-400 focus:outline-none"
                />
              </div>

              {/* Filter Segmented Control */}
              <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] overflow-x-auto">
                {(
                  [
                    { id: "all", label: "All" },
                    { id: "indexed", label: "Indexed" },
                    { id: "processing", label: "Processing" },
                    { id: "failed", label: "Failed" },
                  ] as { id: StatusFilter; label: string }[]
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                      statusFilter === tab.id
                        ? "bg-blue-500/20 text-[var(--dm-text)] border border-blue-400/30"
                        : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Sort */}
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--dm-surface)] border border-[var(--dm-border)] text-xs text-[var(--dm-text-secondary)]">
                <ArrowUpDown className="w-3.5 h-3.5 text-[var(--dm-text-muted)] shrink-0" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortBy)}
                  aria-label="Sort documents"
                  className="bg-transparent text-[var(--dm-text)] focus:outline-none cursor-pointer"
                >
                  <option value="newest" className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Newest First</option>
                  <option value="oldest" className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Oldest First</option>
                  <option value="name" className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Name A–Z</option>
                  <option value="pages" className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Most Pages</option>
                  <option value="chunks" className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Most Chunks</option>
                </select>
              </label>
            </div>
          </div>

          {/* Document Cards Grid */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-44 rounded-2xl bg-white/5 animate-pulse" />
              ))}
            </div>
          ) : filteredAndSorted.length === 0 ? (
            <div className="dm-card p-10 text-center flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-400/25 flex items-center justify-center">
                <DocuMindMark size="md" />
              </div>
              <h3 className="font-display text-base font-semibold text-[var(--dm-text)]">
                {documents.length === 0 ? "Your document library is empty" : "No documents match this filter"}
              </h3>
              <p className="text-sm text-[var(--dm-text-muted)] max-w-md">
                {documents.length === 0
                  ? "Upload PDF files above to extract text, generate semantic embeddings, and ask grounded AI questions."
                  : "Try clearing your search term or switching the status filter to All."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredAndSorted.map((doc) => {
                const isIndexed = doc.status === "Indexed Successfully";
                const isFailed = doc.status === "Failed";
                return (
                  <motion.article
                    key={doc.id}
                    whileHover={{ y: -2 }}
                    transition={{ duration: 0.16 }}
                    className={`dm-card p-5 flex flex-col justify-between gap-4 transition-colors ${
                      isFailed
                        ? "border-red-500/35"
                        : "hover:border-blue-400/35"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                            isFailed
                              ? "bg-red-500/15 border-red-500/25 text-red-700 dark:text-red-400"
                              : "bg-blue-500/15 border-blue-400/25 text-blue-700 dark:text-blue-300"
                          }`}
                        >
                          <FileText className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <h3
                            title={doc.filename}
                            className="font-display text-sm font-semibold text-[var(--dm-text)] truncate"
                          >
                            {doc.filename}
                          </h3>
                          <p className="mt-1 text-xs text-[var(--dm-text-muted)] tabular-nums">
                            <span>{doc.pages || 0} pages</span>
                            <span aria-hidden="true"> · </span>
                            <span>{doc.chunks_count || 0} chunks</span>
                            <span aria-hidden="true"> · </span>
                            <span>{formatBytes(doc.size_bytes)}</span>
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Status & Progress */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        {isIndexed ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Indexed Successfully</span>
                          </span>
                        ) : isFailed ? (
                          <span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400 font-medium">
                            <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Failed</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300 font-medium">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            <span>{doc.status}</span>
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-[var(--dm-text-muted)] tabular-nums">
                          {formatDate(doc.uploaded_at)}
                        </span>
                      </div>

                      {isFailed ? (
                        <p className="text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-2.5 break-words">
                          {doc.error_message || "Document processing failed."}
                        </p>
                      ) : (
                        <div className="w-full h-1.5 rounded-full bg-slate-900/10 dark:bg-white/5 overflow-hidden">
                          <div
                            className={`h-1.5 rounded-full transition-all duration-300 ${
                              isIndexed
                                ? "bg-gradient-to-r from-emerald-400 to-cyan-400"
                                : "bg-gradient-to-r from-blue-500 to-cyan-400"
                            }`}
                            style={{ width: `${doc.progress}%` }}
                          />
                        </div>
                      )}
                    </div>

                    <footer className="pt-3 border-t border-[var(--dm-border)] flex items-center justify-between gap-2">
                      {isIndexed ? (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectDocumentForChat(doc.id);
                            onNavigate("chat");
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-xs font-semibold text-cyan-700 dark:text-cyan-300 transition-colors whitespace-nowrap"
                        >
                          <MessageSquareText className="w-3.5 h-3.5" />
                          <span>Chat with PDF</span>
                        </button>
                      ) : (
                        <span className="text-xs text-[var(--dm-text-muted)] tabular-nums">
                          {isFailed ? "Unable to index" : `${doc.progress}% complete`}
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => setPendingDelete(doc)}
                        aria-label={`Delete ${doc.filename}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-500/15 transition-colors whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </footer>
                  </motion.article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete PDF & Indexed Vectors?"
        description={
          pendingDelete
            ? `Permanently delete "${pendingDelete.filename}" along with its ${pendingDelete.chunks_count} embedded vector chunks from persistent storage?`
            : ""
        }
        confirmLabel="Delete PDF"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </AppShell>
  );
};
