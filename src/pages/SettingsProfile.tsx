import React, { useState } from "react";
import { Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { clearChatHistoryApi } from "../api";
import { AppShell, AvatarBadge } from "../components/AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DocuMindLogo } from "../components/DocuMindLogo";
import { useToast } from "../components/ToastProvider";
import { RoutePage, ThemeMode, UserPreferences } from "../types";

interface SettingsProfileProps {
  onNavigate: (page: RoutePage) => void;
  preferences: UserPreferences;
  onUpdatePreferences: (next: UserPreferences) => void;
}

export const SettingsProfile: React.FC<SettingsProfileProps> = ({
  onNavigate,
  preferences,
  onUpdatePreferences,
}) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { pushToast } = useToast();

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      await clearChatHistoryApi();
      setConfirmOpen(false);
      pushToast({
        kind: "success",
        title: "Conversation history cleared",
        description: "All stored chat turns have been removed.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to clear conversation history.";
      pushToast({ kind: "error", title: "Clear failed", description: msg });
    } finally {
      setClearing(false);
    }
  };

  return (
    <AppShell
      activePage="settings"
      onNavigate={onNavigate}
      title="Settings"
      subtitle="Configure your workspace profile, theme appearance, and RAG retrieval depth."
      preferences={preferences}
    >
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-4xl w-full mx-auto flex flex-col gap-6">
        {/* Profile */}
        <section className="dm-card p-6 flex flex-col gap-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-[var(--dm-border)]">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 min-w-0">
              <AvatarBadge size="lg" name={preferences.displayName} />
              <div className="min-w-0">
                <h2 className="font-display text-lg font-semibold text-[var(--dm-text)] truncate">
                  {preferences.displayName}
                </h2>
                <p className="text-sm text-[var(--dm-text-muted)] truncate">
                  {preferences.email} · Document Intelligence Workspace
                </p>
              </div>
            </div>
            <DocuMindLogo size="sm" animated={false} className="self-start sm:self-center" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--dm-text-secondary)]">
                Display Name
              </span>
              <input
                type="text"
                value={preferences.displayName}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, displayName: e.target.value })
                }
                className="px-3.5 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] focus:border-blue-400 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--dm-text-secondary)]">
                Workspace Email
              </span>
              <input
                type="email"
                value={preferences.email}
                onChange={(e) => onUpdatePreferences({ ...preferences, email: e.target.value })}
                className="px-3.5 py-2.5 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] focus:border-blue-400 focus:outline-none"
              />
            </label>
          </div>
        </section>

        {/* Theme Appearance */}
        <section className="dm-card p-6 flex flex-col gap-4">
          <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
            Appearance
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(
              [
                { value: "dark", label: "Midnight Dark", icon: Moon },
                { value: "light", label: "Light Mode", icon: Sun },
                { value: "system", label: "System Default", icon: Monitor },
              ] as { value: ThemeMode; label: string; icon: React.ComponentType<{ className?: string }> }[]
            ).map((opt) => {
              const Icon = opt.icon;
              const selected = preferences.theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onUpdatePreferences({ ...preferences, theme: opt.value })}
                  className={`flex items-center gap-3 p-4 rounded-xl border text-left transition-all ${
                    selected
                      ? "bg-blue-500/15 border-blue-400/55 text-[var(--dm-text)]"
                      : "bg-[var(--dm-bg-secondary)]/70 border-[var(--dm-border)] text-[var(--dm-text-muted)] hover:text-[var(--dm-text)]"
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${selected ? "text-cyan-700 dark:text-cyan-300" : ""}`} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* RAG Retrieval Preferences */}
        <section className="dm-card p-6 flex flex-col gap-5">
          <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
            RAG &amp; Retrieval Preferences
          </h2>

          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-[var(--dm-text)]">
                  Auto-index uploaded PDFs
                </p>
                <p className="text-xs text-[var(--dm-text-muted)]">
                  Automatically extract pages, chunk text, and compute embeddings upon upload.
                </p>
              </div>
              <input
                type="checkbox"
                checked={preferences.autoIndex}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, autoIndex: e.target.checked })
                }
                className="w-4 h-4 rounded accent-blue-500"
              />
            </label>

            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-[var(--dm-text)]">
                  Require inline page citations
                </p>
                <p className="text-xs text-[var(--dm-text-muted)]">
                  Display clickable source filename and page number citations in AI answers.
                </p>
              </div>
              <input
                type="checkbox"
                checked={preferences.includeCitations}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, includeCitations: e.target.checked })
                }
                className="w-4 h-4 rounded accent-blue-500"
              />
            </label>

            <label className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--dm-text)]">
                  Top-K retrieved chunks
                </p>
                <p className="text-xs text-[var(--dm-text-muted)]">
                  Number of highest-similarity chunks passed to the AI model per query.
                </p>
              </div>
              <select
                value={preferences.topK}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, topK: Number(e.target.value) })
                }
                className="px-3.5 py-2 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text)] focus:border-blue-400 focus:outline-none"
              >
                <option value={3} className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Top 3 chunks</option>
                <option value={5} className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Top 5 chunks</option>
                <option value={8} className="bg-[var(--dm-surface)] text-[var(--dm-text)]">Top 8 chunks</option>
              </select>
            </label>
          </div>
        </section>

        {/* Session & History Controls */}
        <section className="dm-card p-6 border-red-500/25 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[var(--dm-text)]">
              Conversation History
            </h2>
            <p className="text-xs text-[var(--dm-text-muted)] mt-0.5">
              Clear stored chat history while keeping your indexed PDFs and vectors intact.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-red-500/35 text-red-700 dark:text-red-400 hover:bg-red-500/10 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear History</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate("landing")}
              className="px-4 py-2 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-xs font-semibold text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors whitespace-nowrap"
            >
              Back to Home
            </button>
          </div>
        </section>
      </main>

      <ConfirmDialog
        open={confirmOpen}
        title="Clear Conversation History?"
        description="This removes all recorded Q&A turns from your workspace history. Uploaded documents and vector embeddings remain untouched."
        confirmLabel="Clear History"
        busy={clearing}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleClearHistory}
      />
    </AppShell>
  );
};
