/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import { ToastProvider } from "./components/ToastProvider";
import { AIDocumentChat } from "./pages/AIDocumentChat";
import { DocumentUpload } from "./pages/DocumentUpload";
import { LandingPage } from "./pages/LandingPage";
import { MainDashboard } from "./pages/MainDashboard";
import { RAGComparison } from "./pages/RAGComparison";
import { RetrievalSources } from "./pages/RetrievalSources";
import { SettingsProfile } from "./pages/SettingsProfile";
import { RoutePage, RetrievalInspectResponse, UserPreferences } from "./types";

const PREFS_STORAGE_KEY = "documind_preferences_v2";

const DEFAULT_PREFS: UserPreferences = {
  theme: "dark",
  autoIndex: true,
  includeCitations: true,
  topK: 3,
  displayName: "Dr. Maya Lin",
  email: "maya.lin@documind.ai",
};

function loadInitialPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UserPreferences>) };
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_PREFS;
}

export default function App() {
  const [activePage, setActivePage] = useState<RoutePage>("landing");
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [inspectQuery, setInspectQuery] = useState<string>("");
  const [latestTrace, setLatestTrace] = useState<RetrievalInspectResponse | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(loadInitialPreferences);

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const shouldUseDark =
        preferences.theme === "dark" || (preferences.theme === "system" && prefersDark);
      root.classList.toggle("dark", shouldUseDark);
    };
    applyTheme();
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Ignore storage errors
    }

    if (preferences.theme === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", applyTheme);
      return () => mql.removeEventListener("change", applyTheme);
    }
  }, [preferences]);

  const handleSelectDocForChat = useCallback((documentId: string) => {
    setSelectedDocIds([documentId]);
  }, []);

  const renderPage = () => {
    if (activePage === "landing") {
      return <LandingPage onNavigate={setActivePage} />;
    }
    if (activePage === "dashboard") {
      return (
        <MainDashboard
          onNavigate={setActivePage}
          onSelectDocumentForChat={handleSelectDocForChat}
          preferences={preferences}
        />
      );
    }
    if (activePage === "documents") {
      return (
        <DocumentUpload
          onNavigate={setActivePage}
          onSelectDocumentForChat={handleSelectDocForChat}
          preferences={preferences}
        />
      );
    }
    if (activePage === "chat") {
      return (
        <AIDocumentChat
          onNavigate={setActivePage}
          selectedDocIds={selectedDocIds}
          onChangeSelectedDocIds={setSelectedDocIds}
          onInspectQuery={setInspectQuery}
          onRecordTrace={setLatestTrace}
          preferences={preferences}
        />
      );
    }
    if (activePage === "retrieval") {
      return (
        <RetrievalSources
          onNavigate={setActivePage}
          initialQuery={inspectQuery}
          latestTrace={latestTrace}
          onRecordTrace={setLatestTrace}
          selectedDocIds={selectedDocIds}
          onChangeSelectedDocIds={setSelectedDocIds}
          preferences={preferences}
        />
      );
    }
    if (activePage === "compare") {
      return <RAGComparison onNavigate={setActivePage} preferences={preferences} />;
    }
    return (
      <SettingsProfile
        onNavigate={setActivePage}
        preferences={preferences}
        onUpdatePreferences={setPreferences}
      />
    );
  };

  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>{renderPage()}</ToastProvider>
    </MotionConfig>
  );
}
