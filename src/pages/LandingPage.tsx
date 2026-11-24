import React, { useState } from "react";
import { motion } from "motion/react";
import {
  ArrowRight,
  Binary,
  ChevronRight,
  Cpu,
  Database,
  FileText,
  Layers,
  Menu,
  MessageSquareText,
  Quote,
  Search,
  X,
} from "lucide-react";
import { RoutePage } from "../types";
import { DocuMindLogo, DocuMindMark } from "../components/DocuMindLogo";

interface LandingPageProps {
  onNavigate: (page: RoutePage) => void;
}

interface PipelineNode {
  id: string;
  step: string;
  title: string;
  subtitle: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: "blue" | "cyan";
}

const PIPELINE_NODES: PipelineNode[] = [
  {
    id: "pdf",
    step: "01",
    title: "PDF Documents",
    subtitle: "Validated ingestion",
    detail: "Multi-PDF upload up to 25 MB with binary verification and SHA-256 deduplication.",
    icon: FileText,
    accent: "blue",
  },
  {
    id: "extract",
    step: "02",
    title: "Text Extraction",
    subtitle: "Per-page parsing",
    detail: "Extracts clean text page by page while preserving exact source filenames and page indices.",
    icon: Layers,
    accent: "cyan",
  },
  {
    id: "chunk",
    step: "03",
    title: "Chunking",
    subtitle: "500 tokens · 100 overlap",
    detail: "Splits pages into overlapping semantic windows so cross-boundary concepts remain intact.",
    icon: Cpu,
    accent: "blue",
  },
  {
    id: "embed",
    step: "04",
    title: "Embeddings",
    subtitle: "Gemini Embedding-2",
    detail: "Converts every chunk into dense semantic vectors stored in persistent disk storage.",
    icon: Binary,
    accent: "cyan",
  },
  {
    id: "retrieve",
    step: "05",
    title: "Semantic Retrieval",
    subtitle: "Cosine Top-K search",
    detail: "Ranks stored chunk vectors against your embedded question to surface the closest evidence.",
    icon: Search,
    accent: "blue",
  },
  {
    id: "answer",
    step: "06",
    title: "AI Answer",
    subtitle: "Grounded Gemini output",
    detail: "Synthesizes a citation-backed response grounded strictly in the retrieved passages.",
    icon: MessageSquareText,
    accent: "cyan",
  },
];

const PARTICLES = [
  { left: "8%", top: "20%", size: 4, delay: "0s" },
  { left: "22%", top: "68%", size: 3, delay: "1.4s" },
  { left: "44%", top: "16%", size: 5, delay: "2.2s" },
  { left: "68%", top: "74%", size: 4, delay: "0.8s" },
  { left: "84%", top: "24%", size: 3, delay: "3.1s" },
  { left: "91%", top: "58%", size: 4, delay: "1.9s" },
];

export const LandingPage: React.FC<LandingPageProps> = ({ onNavigate }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string>("retrieve");

  const activeNode =
    PIPELINE_NODES.find((n) => n.id === activeNodeId) || PIPELINE_NODES[4];

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--dm-bg)] text-[var(--dm-text)] relative overflow-x-hidden">
      {/* Animated Atmospheric Background */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="animate-dm-aurora absolute -top-48 left-1/4 w-[620px] h-[620px] rounded-full bg-blue-600/15 blur-[140px]" />
        <div className="animate-dm-aurora absolute top-1/3 right-0 w-[520px] h-[520px] rounded-full bg-cyan-500/10 blur-[140px]" />
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(148,163,184,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.6) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
          }}
        />
        {PARTICLES.map((p, idx) => (
          <span
            key={idx}
            style={{
              left: p.left,
              top: p.top,
              width: `${p.size}px`,
              height: `${p.size}px`,
              animationDelay: p.delay,
            }}
            className="animate-dm-float absolute rounded-full bg-cyan-300/60 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
          />
        ))}
      </div>

      {/* Top Navigation (3-zone contract) */}
      <header className="sticky top-0 z-30 bg-[var(--dm-bg)]/80 backdrop-blur-xl border-b border-[var(--dm-border)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => scrollToSection("hero")}
            aria-label="DocuMind Home"
            className="focus-visible:outline-2 focus-visible:outline-blue-400 rounded-lg whitespace-nowrap shrink-0"
          >
            <DocuMindLogo size="md" />
          </button>

          <nav aria-label="Primary" className="hidden md:flex items-center gap-8">
            <button
              type="button"
              onClick={() => scrollToSection("features")}
              className="text-sm font-medium text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] transition-colors whitespace-nowrap shrink-0"
            >
              Features
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("how-it-works")}
              className="text-sm font-medium text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] transition-colors whitespace-nowrap shrink-0"
            >
              How It Works
            </button>
            <button
              type="button"
              onClick={() => scrollToSection("technology")}
              className="text-sm font-medium text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] transition-colors whitespace-nowrap shrink-0"
            >
              Technology
            </button>
          </nav>

          <div className="hidden md:flex items-center shrink-0">
            <button
              type="button"
              onClick={() => onNavigate("dashboard")}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold shadow-[0_8px_24px_-8px_rgba(37,99,235,0.7)] transition-all duration-150 whitespace-nowrap shrink-0"
            >
              <span>Get Started</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl border border-[var(--dm-border)] text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/95 backdrop-blur-xl px-4 py-4">
            <nav className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => scrollToSection("features")}
                className="text-left px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--dm-text-secondary)] hover:bg-slate-900/5 dark:hover:bg-white/5"
              >
                Features
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("how-it-works")}
                className="text-left px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--dm-text-secondary)] hover:bg-slate-900/5 dark:hover:bg-white/5"
              >
                How It Works
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("technology")}
                className="text-left px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--dm-text-secondary)] hover:bg-slate-900/5 dark:hover:bg-white/5"
              >
                Technology
              </button>
              <button
                type="button"
                onClick={() => onNavigate("dashboard")}
                className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 text-white text-sm font-semibold"
              >
                <span>Get Started</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </nav>
          </div>
        )}
      </header>

      <main className="relative z-10 flex-1">
        {/* Hero Section */}
        <section id="hero" className="pt-14 pb-16 sm:pt-20 sm:pb-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="max-w-3xl mx-auto text-center flex flex-col items-center gap-6"
            >
              <div className="inline-flex items-center gap-2.5 text-xs font-medium text-blue-700 dark:text-cyan-300">
                <DocuMindMark size="xs" />
                <span>AI-Powered Document Intelligence</span>
              </div>

              <h1 className="font-display font-bold text-4xl sm:text-5xl lg:text-[56px] lg:leading-[1.08] tracking-tight text-[var(--dm-text)] text-balance">
                Your Documents.{" "}
                <span className="bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-500 dark:from-blue-400 dark:via-sky-300 dark:to-cyan-300 bg-clip-text text-transparent">
                  Understood by AI.
                </span>
              </h1>

              <p className="text-base sm:text-lg text-[var(--dm-text-muted)] max-w-2xl leading-relaxed text-pretty">
                Upload complex PDFs and query your private knowledge base using Retrieval-Augmented
                Generation. DocuMind embeds every passage, retrieves the most relevant context by
                semantic similarity, and delivers citation-backed answers you can verify in one click.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3.5 pt-1">
                <button
                  type="button"
                  onClick={() => onNavigate("dashboard")}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold shadow-[0_12px_32px_-10px_rgba(37,99,235,0.75)] transition-all duration-150 whitespace-nowrap shrink-0"
                >
                  <span>Start Exploring</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("how-it-works")}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[var(--dm-surface)] hover:bg-[var(--dm-surface-elevated)] border border-[var(--dm-border)] text-sm font-semibold text-[var(--dm-text)] transition-colors duration-150 whitespace-nowrap shrink-0"
                >
                  <span>Discover How It Works</span>
                </button>
              </div>
            </motion.div>

            {/* Interactive Animated RAG Pipeline Illustration */}
            <motion.div
              id="how-it-works"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
              className="mt-14 dm-card dm-glow-border p-5 sm:p-8 relative overflow-hidden"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                <div>
                  <h2 className="font-display text-base sm:text-lg font-semibold text-[var(--dm-text)]">
                    Live Retrieval-Augmented Generation Flow
                  </h2>
                  <p className="text-xs sm:text-sm text-[var(--dm-text-muted)]">
                    Select any stage below to inspect how DocuMind transforms raw PDFs into verified answers.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("retrieval")}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-300 hover:text-cyan-600 dark:hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Open Pipeline Inspector</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Connected Animated Pipeline Nodes */}
              <div className="relative">
                {/* Desktop Animated SVG Connector Track */}
                <svg
                  aria-hidden="true"
                  className="hidden lg:block absolute top-11 left-8 right-8 w-[calc(100%-4rem)] h-6 pointer-events-none z-0"
                  preserveAspectRatio="none"
                  viewBox="0 0 1000 24"
                >
                  <line
                    x1="0"
                    y1="12"
                    x2="1000"
                    y2="12"
                    stroke="rgba(148, 163, 184, 0.2)"
                    strokeWidth="2"
                  />
                  <line
                    x1="0"
                    y1="12"
                    x2="1000"
                    y2="12"
                    stroke="url(#dmPipeGradient)"
                    strokeWidth="2.5"
                    className="animate-dm-flow"
                  />
                  <defs>
                    <linearGradient id="dmPipeGradient" x1="0" y1="0" x2="1000" y2="0" gradientUnits="userSpaceOnUse">
                      <stop stopColor="#2563EB" />
                      <stop offset="0.5" stopColor="#0EA5E9" />
                      <stop offset="1" stopColor="#22D3EE" />
                    </linearGradient>
                  </defs>
                </svg>

                <div className="relative z-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                  {PIPELINE_NODES.map((node, index) => {
                    const Icon = node.icon;
                    const selected = node.id === activeNode.id;
                    const accentRing =
                      node.accent === "blue"
                        ? "border-blue-400/55 shadow-[0_0_24px_-8px_rgba(37,99,235,0.65)]"
                        : "border-cyan-400/55 shadow-[0_0_24px_-8px_rgba(34,211,238,0.7)]";
                    const iconBox =
                      node.accent === "blue"
                        ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-400/30"
                        : "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-400/30";

                    return (
                      <motion.button
                        key={node.id}
                        type="button"
                        onClick={() => setActiveNodeId(node.id)}
                        whileHover={{ y: -2 }}
                        transition={{ duration: 0.16 }}
                        className={`text-left p-4 rounded-2xl border transition-all duration-150 flex flex-col gap-3 ${
                          selected
                            ? `bg-[var(--dm-surface-elevated)] ${accentRing}`
                            : "bg-[var(--dm-bg-secondary)]/80 border-[var(--dm-border)] hover:border-blue-400/35"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`w-9 h-9 rounded-xl border flex items-center justify-center ${iconBox}`}
                          >
                            <Icon className="w-4 h-4" />
                          </span>
                          <span className="font-mono text-[11px] text-[var(--dm-text-muted)] tabular-nums">
                            {node.step}
                          </span>
                        </div>
                        <div>
                          <p className="font-display text-sm font-semibold text-[var(--dm-text)]">
                            {node.title}
                          </p>
                          <p className="text-xs text-[var(--dm-text-muted)] mt-0.5">
                            {node.subtitle}
                          </p>
                        </div>
                        {index < PIPELINE_NODES.length - 1 && (
                          <span className="sr-only">connects to next stage</span>
                        )}
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              {/* Active Stage Explanation Strip */}
              <div className="mt-5 pt-5 border-t border-[var(--dm-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-xs text-cyan-700 dark:text-cyan-300 pt-0.5 tabular-nums">
                    Stage {activeNode.step}
                  </span>
                  <p className="text-sm text-[var(--dm-text-secondary)]">
                    <strong className="font-semibold text-[var(--dm-text)]">
                      {activeNode.title}:
                    </strong>{" "}
                    {activeNode.detail}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("documents")}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 text-xs font-semibold text-blue-700 dark:text-blue-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Try with a PDF</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Compact Features Section */}
        <section id="features" className="py-16 border-t border-[var(--dm-border)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl mb-10">
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-[var(--dm-text)] text-balance">
                Designed for Grounded Document Intelligence
              </h2>
              <p className="mt-2.5 text-sm sm:text-base text-[var(--dm-text-muted)]">
                Every response is anchored to verifiable passages extracted directly from your files.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
              {[
                {
                  icon: FileText,
                  title: "Intelligent PDF Understanding",
                  desc: "Upload multi-page PDFs with automated text extraction, overlapping chunking, and real-time indexing status.",
                  tone: "text-blue-700 dark:text-blue-300 bg-blue-500/15 border-blue-400/25",
                },
                {
                  icon: Search,
                  title: "Semantic Search",
                  desc: "Dense vector embeddings and cosine similarity surface the top relevant passages beyond exact keyword matching.",
                  tone: "text-cyan-700 dark:text-cyan-300 bg-cyan-500/15 border-cyan-400/25",
                },
                {
                  icon: MessageSquareText,
                  title: "Context-Aware AI Answers",
                  desc: "Ask targeted questions or compare standard LLM output against RAG-grounded synthesis side by side.",
                  tone: "text-blue-700 dark:text-blue-300 bg-blue-500/15 border-blue-400/25",
                },
                {
                  icon: Quote,
                  title: "Verifiable Source Citations",
                  desc: "Interactive citations reference exact filenames, page numbers, chunk IDs, and cosine similarity scores.",
                  tone: "text-cyan-700 dark:text-cyan-300 bg-cyan-500/15 border-cyan-400/25",
                },
              ].map((feat) => {
                const Icon = feat.icon;
                return (
                  <article
                    key={feat.title}
                    className="dm-card p-6 flex flex-col gap-4 hover:border-blue-400/35 transition-colors duration-150"
                  >
                    <div
                      className={`w-10 h-10 rounded-xl border flex items-center justify-center ${feat.tone}`}
                    >
                      <Icon className="w-5 h-5" />
                    </div>
                    <h3 className="font-display text-base font-semibold text-[var(--dm-text)]">
                      {feat.title}
                    </h3>
                    <p className="text-sm text-[var(--dm-text-muted)] leading-relaxed">
                      {feat.desc}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* Technology Stack Strip */}
        <section id="technology" className="py-16 border-t border-[var(--dm-border)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="dm-card p-6 sm:p-10 flex flex-col lg:flex-row lg:items-center justify-between gap-8">
              <div className="max-w-xl">
                <h2 className="font-display text-2xl font-bold text-[var(--dm-text)]">
                  Transparent End-to-End Architecture
                </h2>
                <p className="mt-2.5 text-sm sm:text-base text-[var(--dm-text-muted)] leading-relaxed">
                  Powered by Node.js, Express, per-page PDF parsing, Gemini Embeddings, durable
                  PostgreSQL (pgvector) &amp; object storage, and grounded Gemini generation. Compare
                  RAG vs. ungrounded answers live inside the workspace.
                </p>
                <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs text-[var(--dm-text-secondary)]">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-cyan-700 dark:text-cyan-300 shrink-0" />
                    <span>Durable Vector &amp; Blob Storage</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Binary className="w-4 h-4 text-blue-700 dark:text-blue-300 shrink-0" />
                    <span>Gemini Embedding Vectors</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-cyan-700 dark:text-cyan-300 shrink-0" />
                    <span>Cosine Top-K Retrieval</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigate("compare")}
                  className="px-5 py-2.5 rounded-xl border border-[var(--dm-border)] bg-[var(--dm-bg-secondary)] hover:bg-slate-900/5 dark:hover:bg-white/5 text-sm font-medium text-[var(--dm-text)] transition-colors whitespace-nowrap"
                >
                  Compare RAG vs. Standard
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate("dashboard")}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white text-sm font-semibold transition-all whitespace-nowrap"
                >
                  <span>Open Workspace</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Clean Footer */}
      <footer className="relative z-10 border-t border-[var(--dm-border)] bg-[var(--dm-bg-secondary)]/70 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <DocuMindLogo size="sm" animated={false} />
            <span className="text-xs text-[var(--dm-text-muted)]">
              Document Intelligence &amp; Grounded RAG Workspace
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-5 text-xs font-medium text-[var(--dm-text-muted)]">
            <button type="button" onClick={() => onNavigate("dashboard")} className="hover:text-[var(--dm-text)]">
              Overview
            </button>
            <button type="button" onClick={() => onNavigate("documents")} className="hover:text-[var(--dm-text)]">
              My Documents
            </button>
            <button type="button" onClick={() => onNavigate("chat")} className="hover:text-[var(--dm-text)]">
              AI Chat
            </button>
            <button type="button" onClick={() => onNavigate("compare")} className="hover:text-[var(--dm-text)]">
              RAG Comparison
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};
