import React, { useState } from "react";
import { RoutePage, UserPreferences } from "../types";
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

const NAV_ITEMS: { id: RoutePage; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "documents", label: "My Documents", icon: "folder_open" },
  { id: "chat", label: "AI Chat", icon: "chat" },
  { id: "retrieval", label: "Search & Retrieval", icon: "manage_search" },
  { id: "compare", label: "RAG Comparison", icon: "compare" },
  { id: "settings", label: "Settings", icon: "settings" },
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
        className={`${dim} rounded-full bg-light-primary/15 dark:bg-dark-primary/20 text-light-primary dark:text-dark-primary flex items-center justify-center font-title text-title-sm shrink-0 border border-light-outline-variant/60 dark:border-dark-outline-variant/60`}
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
      onError={() => setImgFailed(true)}
      className={`${dim} rounded-full object-cover shrink-0 border border-light-outline-variant/60 dark:border-dark-outline-variant/60`}
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
    <div className="min-h-screen flex bg-light-surface dark:bg-dark-surface text-light-on-surface dark:text-dark-on-surface">
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-light-scrim/40 lg:hidden"
          aria-hidden="true"
        />
      )}

      {/* Collapsible Left Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 ${
          collapsed ? "w-20" : "w-64"
        } min-h-screen bg-light-surface-container-low dark:bg-dark-surface-container-low border-r border-light-outline-variant/60 dark:border-dark-outline-variant/60 flex flex-col justify-between transition-transform duration-surface-enter ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        } shrink-0`}
      >
        <div className="flex flex-col">
          {/* Brand Header */}
          <div className="h-16 px-gutter-md flex items-center justify-between border-b border-light-outline-variant/50 dark:border-dark-outline-variant/50">
            <button
              type="button"
              onClick={() => handleNav("landing")}
              className="flex items-center gap-gutter-sm overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-light-primary rounded"
            >
              <div className="w-8 h-8 rounded-md bg-gradient-to-br from-light-primary to-light-secondary flex items-center justify-center text-light-on-primary shrink-0 shadow-sm">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  psychology
                </span>
              </div>
              {!collapsed && (
                <span className="font-headline text-title-md text-light-on-surface dark:text-dark-on-surface whitespace-nowrap">
                  DocuMind
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((prev) => !prev)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden lg:inline-flex items-center justify-center w-8 h-8 rounded text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container transition-colors duration-state-change"
            >
              <span className="material-symbols-outlined text-[18px]">dock_to_left</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close sidebar"
              className="lg:hidden inline-flex items-center justify-center w-8 h-8 rounded text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          {/* Primary Navigation */}
          <nav aria-label="Sidebar Navigation" className="p-gutter-sm flex flex-col gap-gutter-xs">
            {NAV_ITEMS.map((item) => {
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNav(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center ${
                    collapsed ? "justify-center" : ""
                  } gap-gutter-sm px-3 py-2.5 rounded font-label text-label-lg transition-colors duration-state-change text-left whitespace-nowrap ${
                    isActive
                      ? "bg-light-primary dark:bg-dark-primary-container text-light-on-primary dark:text-dark-on-primary-container shadow-sm"
                      : "text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container hover:text-light-on-surface dark:hover:text-dark-on-surface"
                  }`}
                >
                  <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">
                    {item.icon}
                  </span>
                  {!collapsed && <span>{item.label}</span>}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => handleNav("landing")}
              title={collapsed ? "Help & Overview" : undefined}
              className={`flex items-center ${
                collapsed ? "justify-center" : ""
              } gap-gutter-sm px-3 py-2.5 rounded text-light-on-surface-variant dark:text-dark-on-surface-variant hover:bg-light-surface-container dark:hover:bg-dark-surface-container hover:text-light-on-surface dark:hover:text-dark-on-surface font-label text-label-lg transition-colors duration-state-change text-left whitespace-nowrap`}
            >
              <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">
                help
              </span>
              {!collapsed && <span>Help &amp; Overview</span>}
            </button>
          </nav>
        </div>

        {/* User Profile Footer */}
        <div className="p-gutter-sm border-t border-light-outline-variant/50 dark:border-dark-outline-variant/50">
          <button
            type="button"
            onClick={() => handleNav("settings")}
            className="w-full flex items-center gap-gutter-sm p-gutter-sm rounded hover:bg-light-surface-container dark:hover:bg-dark-surface-container transition-colors duration-state-change text-left"
          >
            <AvatarBadge size="md" name={preferences.displayName} />
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="font-title text-title-sm text-light-on-surface dark:text-dark-on-surface truncate">
                  {preferences.displayName}
                </span>
                <span className="font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant truncate">
                  Research Workspace
                </span>
              </div>
            )}
          </button>
        </div>
      </aside>

      {/* Main Workspace Column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 bg-light-surface-container-lowest dark:bg-dark-surface-container-lowest border-b border-light-outline-variant/60 dark:border-dark-outline-variant/60 px-gutter-md lg:px-gutter-lg flex items-center justify-between gap-gutter-md">
          <div className="flex items-center gap-gutter-sm min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded text-light-on-surface dark:text-dark-on-surface hover:bg-light-surface-container dark:hover:bg-dark-surface-container"
            >
              <span className="material-symbols-outlined text-[22px]">menu</span>
            </button>
            <div className="flex flex-col min-w-0">
              <h1 className="font-headline text-title-lg text-light-on-surface dark:text-dark-on-surface truncate">
                {title}
              </h1>
              {subtitle && (
                <p className="hidden sm:block font-body text-body-sm text-light-on-surface-variant dark:text-dark-on-surface-variant truncate">
                  {subtitle}
                </p>
              )}
            </div>
          </div>

          {headerActions && <div className="flex items-center gap-gutter-sm sm:gap-gutter-md shrink-0">{headerActions}</div>}
        </header>

        {children}
      </div>
    </div>
  );
};
