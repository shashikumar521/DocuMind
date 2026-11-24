import React, { useCallback, useEffect, useRef, useState } from "react";
import { deleteDocumentById, fetchDocuments, uploadPdfFiles } from "../api";
import { AppShell, AvatarBadge } from "../components/AppShell";
import { DocuMindDocument, ProcessingStatus, RoutePage, UserPreferences } from "../types";

interface DocumentUploadProps {
  onNavigate: (page: RoutePage) => void;
  onSelectDocumentForChat: (documentId: string) => void;
  preferences: UserPreferences;
}

const MAX_BYTES = 25 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusChipStyle(status: ProcessingStatus): string {
  if (status === "Indexed Successfully") {
    return "bg-success-container text-on-success-container";
  }
  if (status === "Failed") {
    return "bg-light-error-container text-light-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container";
  }
  return "bg-warning-container text-on-warning-container";
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Poll while uploading or while any document is still processing
  useEffect(() => {
    const hasInProgress =
      uploading ||
      documents.some(
        (d) => d.status !== "Indexed Successfully" && d.status !== "Failed"
      );
    if (!hasInProgress) return;
    const timer = setInterval(() => {
      loadDocuments();
    }, 800);
    return () => clearInterval(timer);
  }, [uploading, documents, loadDocuments]);

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setValidationError(null);
    setSuccessMessage(null);

    for (const f of files) {
      if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
        setValidationError(`"${f.name}" is an unsupported file type. Only PDF files are accepted.`);
        return;
      }
      if (f.size === 0) {
        setValidationError(`"${f.name}" is empty (0 bytes).`);
        return;
      }
      if (f.size > MAX_BYTES) {
        setValidationError(`"${f.name}" exceeds the 25 MB upload limit.`);
        return;
      }
    }

    setUploading(true);
    setPendingNames(files.map((f) => f.name));
    try {
      const res = await uploadPdfFiles(files);
      await loadDocuments();
      if (res.errors && res.errors.length > 0) {
        setValidationError(res.errors.map((e) => `${e.filename}: ${e.detail}`).join(" | "));
      }
      if (res.documents && res.documents.length > 0) {
        setSuccessMessage(
          `Successfully indexed ${res.documents.length} PDF${res.documents.length > 1 ? "s" : ""}.`
        );
      }
    } catch (err: unknown) {
      await loadDocuments();
      setValidationError(err instanceof Error ? err.message : "Failed to upload and index PDF.");
    } finally {
      setUploading(false);
      setPendingNames([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (docId: string) => {
    setDeletingId(docId);
    setValidationError(null);
    try {
      await deleteDocumentById(docId);
      await loadDocuments();
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : "Failed to delete document.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <AppShell
      activePage="documents"
      onNavigate={onNavigate}
      title="Document Upload & Management"
      subtitle="Upload your PDF documents and DocuMind will process and index their content for intelligent question answering."
      preferences={preferences}
      headerActions={
        <button
          type="button"
          onClick={() => onNavigate("settings")}
          aria-label="Profile settings"
          className="inline-flex items-center p-1 rounded-full hover:bg-light-surface-container dark:hover:bg-dark-surface-container"
        >
          <AvatarBadge size="sm" name={preferences.displayName} />
        </button>
      }
    >
      <main className="flex-1 p-gutter-md lg:p-gutter-lg max-w-6xl w-full mx-auto flex flex-col gap-gutter-lg">
        {/* Drag and Drop Upload Area */}
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files) {
              handleFiles(e.dataTransfer.files);
            }
          }}
          className={`bg-light-surface-container-lowest dark:bg-dark-surface-container-low border-2 border-dashed ${
            isDragging
              ? "border-light-primary bg-light-surface-container-low/70 dark:bg-dark-surface-container/60"
              : "border-light-primary/40 dark:border-dark-primary/40"
          } rounded-lg p-gutter-xl text-center flex flex-col items-center gap-gutter-md hover:border-light-primary transition-colors duration-state-change`}
        >
          <div className="w-12 h-12 rounded-full bg-light-surface-container-low dark:bg-dark-surface-container flex items-center justify-center text-light-primary dark:text-dark-primary">
            <span className="material-symbols-outlined text-[28px]" aria-hidden="true">
              {uploading ? "progress_activity" : "cloud_upload"}
            </span>
          </div>
          <div className="flex flex-col gap-gutter-xs max-w-lg">
            <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
              {uploading ? "Processing & Indexing PDFs..." : "Drag and drop PDF files here"}
            </h2>
            <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
              Supports multiple PDF files up to 25 MB each. Text is extracted per page, split into
              500-token overlapping chunks, embedded, and indexed for semantic retrieval.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-gutter-sm">
            <label
              htmlFor="pdf-file-input"
              className={`cursor-pointer inline-flex items-center gap-gutter-sm px-gutter-lg py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm whitespace-nowrap ${
                uploading ? "opacity-60 pointer-events-none" : ""
              }`}
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                folder_open
              </span>
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
            <p className="font-mono text-mono-sm text-light-secondary dark:text-dark-secondary">
              Processing: {pendingNames.join(", ")}
            </p>
          )}

          {validationError && (
            <div
              role="alert"
              className="w-full max-w-2xl p-gutter-md rounded bg-light-error-container dark:bg-dark-error-container text-light-on-error-container dark:text-dark-on-error-container flex items-center gap-gutter-sm text-left"
            >
              <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">
                error
              </span>
              <span className="font-body text-body-sm">{validationError}</span>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              className="w-full max-w-2xl p-gutter-md rounded bg-success-container text-on-success-container flex items-center gap-gutter-sm text-left"
            >
              <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">
                check_circle
              </span>
              <span className="font-body text-body-sm">{successMessage}</span>
            </div>
          )}
        </section>

        {/* Processing Pipeline Legend */}
        <section className="bg-light-surface-container-low dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-md flex flex-wrap items-center justify-between gap-gutter-md">
          <div className="flex items-center gap-gutter-sm flex-wrap">
            <span className="font-label text-label-md text-light-on-surface dark:text-dark-on-surface">
              Pipeline Stages:
            </span>
            {[
              "Uploaded",
              "Extracting Text",
              "Chunking",
              "Generating Embeddings",
              "Indexing in ChromaDB",
              "Indexed Successfully",
            ].map((stage, idx, arr) => (
              <React.Fragment key={stage}>
                <span className="font-label text-label-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  {stage}
                </span>
                {idx < arr.length - 1 && (
                  <span
                    className="material-symbols-outlined text-light-outline dark:text-dark-outline text-[14px]"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                )}
              </React.Fragment>
            ))}
          </div>
        </section>

        {/* Uploaded Documents List */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex items-center justify-between">
            <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface tabular-nums">
              Uploaded Documents ({documents.length})
            </h2>
            {documents.some((d) => d.status === "Indexed Successfully") && (
              <button
                type="button"
                onClick={() => onNavigate("chat")}
                className="font-label text-label-lg text-light-primary dark:text-dark-primary hover:underline whitespace-nowrap"
              >
                Open AI Chat
              </button>
            )}
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter-md">
              <div className="h-40 rounded-md bg-light-surface-container dark:bg-dark-surface-container animate-pulse" />
              <div className="h-40 rounded-md bg-light-surface-container dark:bg-dark-surface-container animate-pulse" />
            </div>
          ) : documents.length === 0 ? (
            <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-xl text-center flex flex-col items-center gap-gutter-sm">
              <div className="w-12 h-12 rounded-full bg-light-surface-container-low dark:bg-dark-surface-container flex items-center justify-center text-light-on-surface-variant dark:text-dark-on-surface-variant">
                <span className="material-symbols-outlined text-[24px]" aria-hidden="true">
                  folder_off
                </span>
              </div>
              <h3 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                No documents uploaded yet
              </h3>
              <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant max-w-md">
                Upload your PDF documents above to extract text, generate embeddings, and start asking
                citation-backed questions.
              </p>
            </section>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter-md">
              {documents.map((doc) => (
                <article
                  key={doc.id}
                  className={`bg-light-surface-container-lowest dark:bg-dark-surface-container-low border ${
                    doc.status === "Failed"
                      ? "border-light-error/50 dark:border-dark-error/50"
                      : "border-light-outline-variant/60 dark:border-dark-outline-variant/60"
                  } rounded-md p-gutter-lg shadow-sm flex flex-col justify-between gap-gutter-md`}
                >
                  <div className="flex items-start justify-between gap-gutter-sm">
                    <div className="flex items-start gap-gutter-sm min-w-0">
                      <span
                        className={`material-symbols-outlined text-[24px] shrink-0 ${
                          doc.status === "Failed"
                            ? "text-light-error dark:text-dark-error"
                            : "text-light-primary dark:text-dark-primary"
                        }`}
                        aria-hidden="true"
                      >
                        picture_as_pdf
                      </span>
                      <div className="min-w-0">
                        <h3 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface truncate">
                          {doc.filename}
                        </h3>
                        <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums">
                          {doc.pages > 0 ? `${doc.pages} pages · ` : ""}
                          {formatBytes(doc.size_bytes)}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded font-label text-label-sm shrink-0 whitespace-nowrap ${statusChipStyle(
                        doc.status
                      )}`}
                    >
                      {doc.status}
                    </span>
                  </div>

                  {doc.status === "Failed" ? (
                    <p className="font-body text-body-sm text-light-error dark:text-dark-error">
                      {doc.error_message || "Document processing failed."}
                    </p>
                  ) : (
                    <div className="w-full bg-light-surface-container dark:bg-dark-surface-container rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-1.5 rounded-full transition-all duration-300 ${
                          doc.status === "Indexed Successfully" ? "bg-success" : "bg-warning"
                        }`}
                        style={{ width: `${doc.progress}%` }}
                      />
                    </div>
                  )}

                  <footer className="flex items-center justify-between pt-gutter-sm border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40">
                    <span className="font-mono text-mono-sm text-light-on-surface-variant dark:text-dark-on-surface-variant tabular-nums">
                      {doc.status === "Indexed Successfully"
                        ? `${doc.chunks_count} chunks ready`
                        : doc.status === "Failed"
                        ? "Processing halted"
                        : `Progress: ${doc.progress}%`}
                    </span>
                    <div className="flex items-center gap-gutter-sm">
                      {doc.status === "Indexed Successfully" && (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectDocumentForChat(doc.id);
                            onNavigate("chat");
                          }}
                          className="px-3 py-1.5 rounded text-light-primary dark:text-dark-primary font-label text-label-md hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container whitespace-nowrap"
                        >
                          Preview &amp; Chat
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={deletingId === doc.id}
                        onClick={() => handleDelete(doc.id)}
                        className="px-3 py-1.5 rounded text-light-error dark:text-dark-error font-label text-label-md hover:bg-light-error-container/40 disabled:opacity-50 whitespace-nowrap"
                      >
                        {deletingId === doc.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
};
