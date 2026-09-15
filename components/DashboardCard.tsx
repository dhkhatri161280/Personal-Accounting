"use client";
import type { ReactNode } from "react";
import { StatIcon, type IconKind } from "@/components/Icon";

// Shared dashboard KPI card shell -- the clickable summary button (icon + label/value/subtitle +
// optional highlight pills) and open/close state, previously duplicated between VaultApp.tsx and
// GrApp.tsx. The expanded detail content (children) stays owned by each app, since it pulls from
// book-specific data shapes with no shared structure.
export function DashboardCard({
  slotClassName,
  cardClassName,
  icon,
  iconColor,
  label,
  value,
  subtitle,
  open,
  onClick,
  highlights,
  children,
}: {
  slotClassName: string;
  cardClassName: string;
  icon?: IconKind;
  iconColor?: string;
  label: ReactNode;
  value: ReactNode;
  subtitle?: ReactNode;
  open: boolean;
  onClick: () => void;
  highlights?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`dashboard-card-slot ${slotClassName}`}>
      <button
        className={`dashboard-balance-card ${cardClassName}${open ? " dashboard-card-open" : ""}`}
        onClick={onClick}
      >
        {icon && <StatIcon kind={icon} color={iconColor ?? "#1e40af"} />}
        <div className="dashboard-card-main">
          <span>{label}</span>
          <strong>{value}</strong>
          {subtitle && <small>{subtitle}</small>}
        </div>
        {highlights && <div className="dashboard-card-highlights">{highlights}</div>}
      </button>
      {children}
    </div>
  );
}
