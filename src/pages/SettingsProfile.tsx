import React, { useState } from "react";
import { clearChatHistoryApi } from "../api";
import { AppShell, AvatarBadge } from "../components/AppShell";
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
  const [feedback, setFeedback] = useState<string>(
    "Clear stored chat history or return to the overview page."
  );
  const [clearing, setClearing] = useState(false);

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      await clearChatHistoryApi();
      setFeedback("Conversation history cleared successfully.");
    } catch (err: unknown) {
      setFeedback(err instanceof Error ? err.message : "Failed to clear conversation history.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <AppShell
      activePage="settings"
      onNavigate={onNavigate}
      title="Settings & Profile"
      subtitle="Manage your workspace profile, theme appearance, and retrieval preferences."
      preferences={preferences}
    >
      <main className="flex-1 p-gutter-md lg:p-gutter-lg max-w-4xl w-full mx-auto flex flex-col gap-gutter-lg">
        {/* User Profile & Account Information */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
          <div className="flex flex-col sm:flex-row sm:items-center gap-gutter-md pb-gutter-md border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50">
            <AvatarBadge size="lg" name={preferences.displayName} />
            <div className="flex-1">
              <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
                {preferences.displayName}
              </h2>
              <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                {preferences.email} · Research Workspace
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-md">
            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-light-on-surface dark:text-dark-on-surface">
                Display Name
              </span>
              <input
                type="text"
                value={preferences.displayName}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, displayName: e.target.value })
                }
                className="px-gutter-md py-2 rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface font-body text-body-md focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-light-on-surface dark:text-dark-on-surface">
                Workspace Email
              </span>
              <input
                type="email"
                value={preferences.email}
                onChange={(e) => onUpdatePreferences({ ...preferences, email: e.target.value })}
                className="px-gutter-md py-2 rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface font-body text-body-md focus:border-light-primary focus:ring-2 focus:ring-light-primary/20 focus:outline-none"
              />
            </label>
          </div>
        </section>

        {/* Theme Selection */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
          <h2 className="font-headline text-headline-sm text-light-on-surface dark:text-dark-on-surface">
            Theme Selection
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter-sm">
            {(
              [
                { value: "light", label: "Light (Default)" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ] as { value: ThemeMode; label: string }[]
            ).map((opt) => {
              const selected = preferences.theme === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`flex items-center gap-gutter-sm p-gutter-md rounded cursor-pointer transition-colors ${
                    selected
                      ? "border-2 border-light-primary dark:border-dark-primary bg-light-surface-container-low dark:bg-dark-surface-container"
                      : "border border-light-outline-variant dark:border-dark-outline-variant bg-light-surface-container-lowest dark:bg-dark-surface-container-low"
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={opt.value}
                    checked={selected}
                    onChange={() => onUpdatePreferences({ ...preferences, theme: opt.value })}
                    className="text-light-primary focus:ring-light-primary"
                  />
                  <span className="font-label text-label-lg text-light-on-surface dark:text-dark-on-surface">
                    {opt.label}
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        {/* Document & AI Preferences */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-md">
          <h2 className="font-headline text-title-lg text-light-on-surface dark:text-dark-on-surface">
            Document &amp; AI Preferences
          </h2>
          <div className="flex flex-col gap-gutter-md">
            <label className="flex items-center justify-between gap-gutter-md cursor-pointer">
              <div>
                <p className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                  Auto-index uploaded PDFs
                </p>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Automatically extract, chunk, and embed documents upon upload.
                </p>
              </div>
              <input
                type="checkbox"
                checked={preferences.autoIndex}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, autoIndex: e.target.checked })
                }
                className="rounded text-light-primary focus:ring-light-primary h-5 w-5"
              />
            </label>

            <label className="flex items-center justify-between gap-gutter-md cursor-pointer">
              <div>
                <p className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                  Always include inline page citations
                </p>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Require Gemini responses to reference source PDF and page numbers.
                </p>
              </div>
              <input
                type="checkbox"
                checked={preferences.includeCitations}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, includeCitations: e.target.checked })
                }
                className="rounded text-light-primary focus:ring-light-primary h-5 w-5"
              />
            </label>

            <label className="flex items-center justify-between gap-gutter-md">
              <div>
                <p className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
                  Top-K retrieved chunks
                </p>
                <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Number of vector passages passed into the prompt context.
                </p>
              </div>
              <select
                value={preferences.topK}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, topK: Number(e.target.value) })
                }
                className="rounded bg-light-surface-container-low dark:bg-dark-surface-container border border-light-outline-variant dark:border-dark-outline-variant text-light-on-surface dark:text-dark-on-surface font-body text-body-md px-3 py-1.5 focus:border-light-primary focus-visible:ring-2 focus-visible:ring-light-primary focus:outline-none"
              >
                <option value={3}>Top 3 chunks</option>
                <option value={5}>Top 5 chunks</option>
                <option value={8}>Top 8 chunks</option>
              </select>
            </label>
          </div>
        </section>

        {/* Session & History Controls */}
        <section className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-error/40 dark:border-dark-error/40 rounded-md p-gutter-lg shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-md">
          <div>
            <h2 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface">
              Session &amp; History Controls
            </h2>
            <p className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              {feedback}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-gutter-sm">
            <button
              type="button"
              disabled={clearing}
              onClick={handleClearHistory}
              className="px-gutter-md py-2 rounded border border-light-error dark:border-dark-error text-light-error dark:text-dark-error font-label text-label-lg hover:bg-light-error-container/30 transition-colors duration-state-change disabled:opacity-50 whitespace-nowrap"
            >
              {clearing ? "Clearing..." : "Clear Conversation History"}
            </button>
            <button
              type="button"
              onClick={() => onNavigate("landing")}
              className="px-gutter-md py-2 rounded bg-light-error dark:bg-dark-error text-light-on-error dark:text-dark-on-error font-label text-label-lg hover:opacity-90 transition-opacity duration-state-change whitespace-nowrap"
            >
              Exit Workspace
            </button>
          </div>
        </section>
      </main>
    </AppShell>
  );
};
