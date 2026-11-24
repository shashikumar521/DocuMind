import React, { useState } from "react";
import { RoutePage } from "../types";

interface LandingPageProps {
  onNavigate: (page: RoutePage) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onNavigate }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen flex flex-col bg-light-surface dark:bg-dark-surface text-light-on-surface dark:text-dark-on-surface">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 bg-light-surface-container-lowest/95 dark:bg-dark-surface-container-lowest/95 backdrop-blur-sm border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50">
        <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl h-16 flex items-center justify-between gap-gutter-md">
          <button
            type="button"
            onClick={() => scrollToSection("home")}
            className="flex items-center gap-gutter-sm focus-visible:outline-2 focus-visible:outline-light-primary rounded text-left whitespace-nowrap shrink-0"
          >
            <div className="w-9 h-9 rounded-md bg-gradient-to-br from-light-primary to-light-secondary flex items-center justify-center text-light-on-primary shadow-sm">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                psychology
              </span>
            </div>
            <span className="font-headline text-title-md text-light-on-surface dark:text-dark-on-surface leading-none">
              DocuMind
            </span>
          </button>

          <nav aria-label="Primary" className="hidden md:flex items-center gap-gutter-xl">
            <button
              type="button"
              onClick={() => scrollToSection("home")}
              className="font-label text-label-lg text-light-on-surface dark:text-dark-on-surface hover:text-light-primary dark:hover:text-dark-primary transition-colors duration-state-change whitespace-nowrap shrink-0"
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("features")}
              className="font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:text-light-primary dark:hover:text-dark-primary transition-colors duration-state-change whitespace-nowrap shrink-0"
            >
              Features
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("how-it-works")}
              className="font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:text-light-primary dark:hover:text-dark-primary transition-colors duration-state-change whitespace-nowrap shrink-0"
            >
              How It Works
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("about")}
              className="font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:text-light-primary dark:hover:text-dark-primary transition-colors duration-state-change whitespace-nowrap shrink-0"
            >
              About
            </button>
          </nav>

          <div className="hidden md:flex items-center gap-gutter-sm shrink-0">
            <button
              type="button"
              onClick={() => onNavigate("dashboard")}
              className="inline-flex items-center justify-center px-gutter-md py-2 rounded bg-light-surface-container-lowest dark:bg-dark-surface-container-low text-light-on-surface dark:text-dark-on-surface border border-light-outline-variant dark:border-dark-outline-variant font-label text-label-lg hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container transition-colors duration-state-change whitespace-nowrap shrink-0"
            >
              Open Workspace
            </button>
            <button
              type="button"
              onClick={() => onNavigate("documents")}
              className="inline-flex items-center justify-center gap-gutter-xs px-gutter-md py-2 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm whitespace-nowrap shrink-0"
            >
              <span>Get Started</span>
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                arrow_forward
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded text-light-on-surface dark:text-dark-on-surface hover:bg-light-surface-container dark:hover:bg-dark-surface-container transition-colors duration-state-change"
          >
            <span className="material-symbols-outlined text-[24px]">
              {mobileMenuOpen ? "close" : "menu"}
            </span>
          </button>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-light-outline-variant/50 dark:border-dark-outline-variant/50 bg-light-surface-container-lowest dark:bg-dark-surface-container-lowest px-gutter-md py-gutter-md">
            <nav className="flex flex-col gap-gutter-sm">
              <button
                type="button"
                onClick={() => scrollToSection("home")}
                className="text-left px-gutter-sm py-2 rounded font-label text-label-lg text-light-on-surface dark:text-dark-on-surface hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container-low"
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("features")}
                className="text-left px-gutter-sm py-2 rounded font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container-low"
              >
                Features
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("how-it-works")}
                className="text-left px-gutter-sm py-2 rounded font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container-low"
              >
                How It Works
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("about")}
                className="text-left px-gutter-sm py-2 rounded font-label text-label-lg text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container-low"
              >
                About
              </button>
              <div className="pt-gutter-sm border-t border-light-outline-variant/50 dark:border-dark-outline-variant/50 flex flex-col gap-gutter-sm">
                <button
                  type="button"
                  onClick={() => onNavigate("dashboard")}
                  className="w-full text-center px-gutter-md py-2.5 rounded border border-light-outline-variant dark:border-dark-outline-variant font-label text-label-lg text-light-on-surface dark:text-dark-on-surface"
                >
                  Open Workspace
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("documents")}
                  className="w-full text-center px-gutter-md py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg"
                >
                  Get Started
                </button>
              </div>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section
          id="home"
          className="relative overflow-hidden bg-gradient-to-b from-light-surface-container-low/60 dark:from-dark-surface-container-low/60 to-light-surface dark:to-dark-surface py-section"
        >
          <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl grid grid-cols-1 lg:grid-cols-12 gap-gutter-xl items-center">
            <div className="lg:col-span-6 flex flex-col gap-gutter-lg">
              <div className="flex items-center gap-gutter-sm text-light-secondary dark:text-dark-secondary font-label text-label-md">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  auto_awesome
                </span>
                <span>Retrieval-Augmented Generation Platform</span>
              </div>

              <h1 className="font-display text-display-lg-mobile lg:text-display-lg text-light-on-surface dark:text-dark-on-surface text-balance">
                Chat With Your Documents, Not Just AI.
              </h1>

              <p className="font-body text-body-lg text-light-on-surface-variant dark:text-dark-on-surface-variant text-pretty max-w-prose">
                Your Documents. Your Knowledge. One Intelligent Assistant. Upload dense PDFs, research
                papers, or internal reports and receive accurate, citation-backed answers grounded
                strictly in your files.
              </p>

              <div className="flex flex-wrap items-center gap-gutter-md">
                <button
                  type="button"
                  onClick={() => onNavigate("documents")}
                  className="inline-flex items-center justify-center gap-gutter-sm px-gutter-lg py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm whitespace-nowrap shrink-0"
                >
                  <span>Upload PDFs &amp; Start</span>
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                    arrow_forward
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("compare")}
                  className="inline-flex items-center justify-center gap-gutter-sm px-gutter-lg py-2.5 rounded bg-light-surface-container-lowest dark:bg-dark-surface-container-low text-light-on-surface dark:text-dark-on-surface border border-light-outline-variant dark:border-dark-outline-variant font-label text-label-lg hover:bg-light-surface-container-low dark:hover:bg-dark-surface-container transition-colors duration-state-change whitespace-nowrap shrink-0"
                >
                  <span>Compare RAG vs. Standard LLM</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-gutter-lg pt-gutter-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
                <div className="flex items-center gap-gutter-xs">
                  <span className="material-symbols-outlined text-light-primary dark:text-dark-primary text-[18px]" aria-hidden="true">
                    verified
                  </span>
                  <span className="font-label text-label-md">Page-Level Citations</span>
                </div>
                <div className="flex items-center gap-gutter-xs">
                  <span className="material-symbols-outlined text-light-secondary dark:text-dark-secondary text-[18px]" aria-hidden="true">
                    hub
                  </span>
                  <span className="font-label text-label-md">Vector Semantic Search</span>
                </div>
                <div className="flex items-center gap-gutter-xs">
                  <span className="material-symbols-outlined text-light-primary dark:text-dark-primary text-[18px]" aria-hidden="true">
                    lock
                  </span>
                  <span className="font-label text-label-md">Private Workspace</span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-lowest border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-lg p-gutter-md shadow-sm">
                <img
                  src="/images/documind-hero.png"
                  alt="DocuMind RAG architecture and document intelligence workspace preview"
                  className="w-full h-auto rounded object-cover"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="py-section border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40">
          <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl">
            <div className="max-w-2xl mb-gutter-xl">
              <h2 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-light-on-surface dark:text-dark-on-surface mb-gutter-sm text-balance">
                Built for Fast, Verifiable Document Understanding
              </h2>
              <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant text-pretty">
                Every capability is designed to eliminate hallucinations and keep your answers anchored to
                exact source passages.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter-lg items-stretch">
              {[
                {
                  icon: "upload_file",
                  accent: "text-light-primary dark:text-dark-primary",
                  title: "Smart PDF Upload",
                  desc: "Drag-and-drop multiple PDFs with automated text extraction, 500-token chunking, and live embedding status tracking.",
                },
                {
                  icon: "manage_search",
                  accent: "text-light-secondary dark:text-dark-secondary",
                  title: "Intelligent Document Search",
                  desc: "Semantic vector search surfaces the top relevant passages across hundreds of pages with cosine similarity scores.",
                },
                {
                  icon: "forum",
                  accent: "text-light-primary dark:text-dark-primary",
                  title: "Context-Aware AI Answers",
                  desc: "Ask follow-up questions, summarize findings, or compare topics across your selected indexed documents.",
                },
                {
                  icon: "format_quote",
                  accent: "text-light-secondary dark:text-dark-secondary",
                  title: "Source Citations",
                  desc: "Every response links directly to the source PDF filename, page number, chunk ID, and similarity score.",
                },
                {
                  icon: "shield",
                  accent: "text-light-primary dark:text-dark-primary",
                  title: "Secure Document Management",
                  desc: "Organize, inspect, and remove indexed documents and their stored vectors from your workspace at any time.",
                },
                {
                  icon: "bolt",
                  accent: "text-light-secondary dark:text-dark-secondary",
                  title: "Instant Knowledge Discovery",
                  desc: "Compare ungrounded LLM responses against RAG-grounded answers side by side to verify accuracy.",
                },
              ].map((feat) => (
                <article
                  key={feat.title}
                  className="h-full bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg shadow-sm flex flex-col gap-gutter-sm"
                >
                  <div className={`w-10 h-10 rounded bg-light-surface-container-low dark:bg-dark-surface-container flex items-center justify-center ${feat.accent}`}>
                    <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                      {feat.icon}
                    </span>
                  </div>
                  <h3 className="font-title text-title-md text-light-on-surface dark:text-dark-on-surface">
                    {feat.title}
                  </h3>
                  <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                    {feat.desc}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="py-section bg-light-surface-container-low/60 dark:bg-dark-surface-container-low/40 border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40">
          <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl">
            <div className="max-w-2xl mb-gutter-xl">
              <h2 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-light-on-surface dark:text-dark-on-surface mb-gutter-sm">
                How It Works
              </h2>
              <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                Three transparent steps from raw PDF upload to grounded AI answers.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter-lg items-stretch">
              {[
                {
                  step: "01. Upload Documents",
                  icon: "cloud_upload",
                  color: "text-light-primary dark:text-dark-primary",
                  desc: "Add your PDFs. DocuMind extracts text per page, splits content into overlapping semantic chunks, and indexes vector embeddings.",
                },
                {
                  step: "02. Retrieve Relevant Context",
                  icon: "troubleshoot",
                  color: "text-light-secondary dark:text-dark-secondary",
                  desc: "Your question is embedded and matched against your document chunks via cosine similarity search to locate top passages.",
                },
                {
                  step: "03. Get Grounded AI Answers",
                  icon: "task_alt",
                  color: "text-light-primary dark:text-dark-primary",
                  desc: "Receive clear answers synthesized by Gemini from retrieved context with expandable page-level source citations.",
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-md p-gutter-lg flex flex-col gap-gutter-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-label text-label-md font-semibold ${item.color}`}>
                      {item.step}
                    </span>
                    <span className={`material-symbols-outlined ${item.color} text-[22px]`} aria-hidden="true">
                      {item.icon}
                    </span>
                  </div>
                  <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                    {item.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* About / CTA Strip */}
        <section id="about" className="py-section border-t border-light-outline-variant/40 dark:border-dark-outline-variant/40">
          <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl">
            <div className="bg-light-surface-container-lowest dark:bg-dark-surface-container-low border border-light-outline-variant/60 dark:border-dark-outline-variant/60 rounded-lg p-gutter-xl flex flex-col lg:flex-row items-start lg:items-center justify-between gap-gutter-lg shadow-sm">
              <div className="max-w-2xl flex flex-col gap-gutter-xs">
                <h2 className="font-headline text-headline-md text-light-on-surface dark:text-dark-on-surface">
                  Ready to explore your documents with RAG?
                </h2>
                <p className="font-body text-body-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
                  Open the workspace to inspect the live dashboard, upload PDFs, test document chat, and
                  compare RAG vs. non-RAG responses.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-gutter-md">
                <button
                  type="button"
                  onClick={() => onNavigate("compare")}
                  className="px-gutter-md py-2.5 rounded border border-light-outline-variant dark:border-dark-outline-variant bg-light-surface-container-lowest dark:bg-dark-surface-container text-light-on-surface dark:text-dark-on-surface font-label text-label-lg hover:bg-light-surface-container-low transition-colors duration-state-change whitespace-nowrap shrink-0"
                >
                  See RAG Comparison
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("dashboard")}
                  className="px-gutter-lg py-2.5 rounded bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container font-label text-label-lg hover:bg-light-primary-container transition-colors duration-state-change shadow-sm whitespace-nowrap shrink-0"
                >
                  Launch Workspace
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-light-outline-variant/50 dark:border-dark-outline-variant/50 bg-light-surface-container-lowest dark:bg-dark-surface-container-lowest py-gutter-xl">
        <div className="max-w-7xl mx-auto px-gutter-md sm:px-gutter-lg lg:px-gutter-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-gutter-md">
          <div className="flex items-center gap-gutter-sm">
            <div className="w-7 h-7 rounded bg-gradient-to-br from-light-primary to-light-secondary flex items-center justify-center text-light-on-primary">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                psychology
              </span>
            </div>
            <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface">
              DocuMind
            </span>
            <span className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant">
              — Your Documents. Your Knowledge. One Intelligent Assistant.
            </span>
          </div>
          <div className="flex items-center gap-gutter-lg font-label text-label-md text-light-on-surface-variant dark:text-dark-on-surface-variant">
            <button type="button" onClick={() => onNavigate("dashboard")} className="hover:text-light-primary dark:hover:text-dark-primary">
              Dashboard
            </button>
            <button type="button" onClick={() => onNavigate("chat")} className="hover:text-light-primary dark:hover:text-dark-primary">
              AI Chat
            </button>
            <button type="button" onClick={() => onNavigate("compare")} className="hover:text-light-primary dark:hover:text-dark-primary">
              RAG Comparison
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};
