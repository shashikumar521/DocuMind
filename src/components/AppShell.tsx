import React, { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Files,
  GitCompareArrows,
  HelpCircle,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Workflow,
  X,
} from "lucide-react";
import { RoutePage, UserPreferences } from "../types";
import { DocuMindLogo } from "./DocuMindLogo";
import avatarImg from "../assets/images/avatar_maya_lin_1795494013984.jpg";

interface AppShellProps {
  activePage: RoutePage;
  onNavigate: (page: RoutePage) => void;
  title: string;
  subtitle?: string;
  headerActions?: React.ReactNode;
  preferences: UserPreferences;
  children: React.ReactNode;
}

const NAV_ITEMS: {
  id: RoutePage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "documents", label: "My Documents", icon: Files },
  { id: "chat", label: "AI Chat", icon: MessageSquareText },
  { id: "compare", label: "RAG Comparison", icon: GitCompareArrows },
  { id: "retrieval", label: "Pipeline Inspector", icon: Workflow },
  { id: "settings", label: "Settings", icon: Settings },
];

export const AvatarBadge: React.FC<{ size?: "sm" | "md" | "lg"; name: string }> = ({
  size = "md",
  name,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const dim = size === "sm" ? "w-8 h-8" : size === "lg" ? "w-16 h-16" : "w-9 h-9";

  if (imgFailed) {
    return (
      <div
        className={`${dim} rounded-full bg-violet-500/20 text-violet-700 dark:text-violet-300 flex items-center justify-center font-display text-xs font-semibold shrink-0 border border-violet-400/30`}
        aria-label={name}
      >
        {name
          .split(" ")
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase())
          .join("") || "DM"}
      </div>
    );
  }

  return (
    <img
      src={avatarImg}
      alt={name}
      referrerPolicy="no-referrer"
      onError={() => setImgFailed(true)}
      className={`${dim} rounded-full object-cover shrink-0 border border-[var(--dm-border)]`}
    />
  );
};

export const AppShell: React.FC<AppShellProps> = ({
  activePage,
  onNavigate,
  title,
  subtitle,
  headerActions,
  preferences,
  children,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNav = (page: RoutePage) => {
    setMobileOpen(false);
    onNavigate(page);
  };

  return (
    <div className="min-h-screen flex bg-[var(--dm-bg)] text-[var(--dm-text)] relative overflow-x-hidden">
      {/* Subtle ambient background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden z-0"
      >
        <div className="absolute -top-40 -left-32 w-[480px] h-[480px] rounded-full bg-violet-600/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 w-[420px] h-[420px] rounded-full bg-cyan-500/8 blur-[120px]" />
      </div>

      {/* Mobile backdrop */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Collapsible Left Sidebar */}
      <aside
        className={`fixed lg:sticky top-0 inset-y-0 left-0 z-50 h-screen ${
          collapsed ? "w-[76px]" : "w-64"
        } bg-[var(--dm-bg-secondary)]/95 backdrop-blur-xl border-r border-[var(--dm-border)] flex flex-col justify-between transition-[width,transform] duration-200 ease-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        } shrink-0`}
      >
        <div className="flex flex-col min-h-0">
          {/* Brand Header */}
          <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--dm-border)]">
            <button
              type="button"
              onClick={() => handleNav("landing")}
              aria-label="Return to DocuMind home"
              className="flex items-center overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-violet-400 rounded-lg"
            >
              <DocuMindLogo compact={collapsed} animated={false} />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((prev) => !prev)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden lg:inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
            >
              {collapsed ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation menu"
              className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Primary Navigation */}
          <nav aria-label="Workspace Navigation" className="p-3 flex flex-col gap-1 overflow-y-auto">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNav(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`relative flex items-center ${
                    collapsed ? "justify-center px-2" : "px-3.5"
                  } py-2.5 rounded-xl text-sm font-medium transition-colors text-left whitespace-nowrap ${
                    isActive
                      ? "text-[var(--dm-text)]"
                      : "text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/[0.04]"
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="dm-sidebar-active"
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                      className="absolute inset-0 rounded-xl bg-gradient-to-r from-violet-500/20 to-cyan-500/15 border border-violet-400/35 shadow-[0_0_24px_-8px_rgba(139,92,246,0.5)]"
                      aria-hidden="true"
                    />
                  )}
                  <Icon
                    className={`relative z-10 w-[18px] h-[18px] shrink-0 ${
                      isActive ? "text-cyan-700 dark:text-cyan-300" : ""
                    }`}
                  />
                  {!collapsed && <span className="relative z-10 ml-3">{item.label}</span>}
                </button>
              );
            })}

            <div className="my-2 border-t border-[var(--dm-border)]" />

            <button
              type="button"
              onClick={() => handleNav("landing")}
              title={collapsed ? "Landing & Guide" : undefined}
              className={`flex items-center ${
                collapsed ? "justify-center px-2" : "px-3.5"
              } py-2.5 rounded-xl text-sm font-medium text-[var(--dm-text-muted)] hover:text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/[0.04] transition-colors text-left whitespace-nowrap`}
            >
              <HelpCircle className="w-[18px] h-[18px] shrink-0" />
              {!collapsed && <span className="ml-3">Product Tour</span>}
            </button>
          </nav>
        </div>

        {/* User Profile Footer */}
        <div className="p-3 border-t border-[var(--dm-border)]">
          <button
            type="button"
            onClick={() => handleNav("settings")}
            className={`w-full flex items-center ${
              collapsed ? "justify-center p-1.5" : "gap-3 p-2"
            } rounded-xl hover:bg-slate-900/5 dark:hover:bg-white/[0.04] transition-colors text-left`}
            title={collapsed ? preferences.displayName : "Workspace settings"}
          >
            <AvatarBadge size="md" name={preferences.displayName} />
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[var(--dm-text)] truncate">
                  {preferences.displayName}
                </span>
                <span className="text-xs text-[var(--dm-text-muted)] truncate">
                  {preferences.email}
                </span>
              </div>
            )}
          </button>
        </div>
      </aside>

      {/* Main Workspace Column */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 bg-[var(--dm-bg-secondary)]/80 backdrop-blur-xl border-b border-[var(--dm-border)] px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl border border-[var(--dm-border)] text-[var(--dm-text)] hover:bg-slate-900/5 dark:hover:bg-white/5 shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex flex-col min-w-0">
              <h1 className="font-display text-base sm:text-lg font-semibold text-[var(--dm-text)] truncate">
                {title}
              </h1>
              {subtitle && (
                <p className="hidden sm:block text-xs text-[var(--dm-text-muted)] truncate">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          {headerActions && (
            <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">{headerActions}</div>
          )}
        </header>

        <motion.div
          key={activePage}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="flex-1 flex flex-col min-w-0"
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
};
