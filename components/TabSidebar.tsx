"use client";
import type { ReactNode } from "react";

// The collapsible left nav shell + collapse toggle -- identical between VaultApp.tsx and
// GrApp.tsx. The tab *items* genuinely differ per app (different tab sets), so they're passed
// in as children rather than modeled here.
export function TabSidebar({
  collapsed,
  onToggleCollapsed,
  children,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: ReactNode;
}) {
  return (
    <nav className="tab-sidebar">
      <button
        type="button"
        className="tab-sidebar-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
      >
        {collapsed ? "»" : "«"}
      </button>
      {children}
    </nav>
  );
}
