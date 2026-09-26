"use client";
import type { ReactNode } from "react";
import { StatIcon, type IconKind } from "@/components/Icon";
import { AutoFitAmount } from "@/components/AutoFitAmount";

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
  hero,
  trend,
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
  // Promotes this card as one of the dashboard's 2-3 headline numbers (bigger value type, a
  // tinted "this is the one that matters" card treatment) instead of the same visual weight as
  // every other card -- previously all 5-6 cards competed equally for attention, unlike e.g.
  // Rillet's Launchpad which foregrounds a small set of key metrics and demotes the rest. Only
  // the size/treatment differs; hero cards still use the same DOM shape and click/expand
  // behavior as every other card.
  hero?: boolean;
  // A "+$2,340 vs last month" / "-$560 vs last month" line under the headline value -- a static
  // balance alone doesn't tell you anything moved, which was the actual gap vs. Rillet's
  // Launchpad ("watches for anomalies, flags exceptions") beyond size/color. The caller computes
  // and formats the delta (see lib/dashboard-trend.ts) since only it knows how to correctly
  // value "as of an earlier date" for its own data shape; this component just renders it.
  trend?: { positive: boolean; text: string };
}) {
  // An empty array (a caller's `.map()` over zero highlight rows, e.g. a hero card with no
  // sub-accounts yet) is truthy in JS, so a plain `highlights &&` check would still render an
  // empty, bordered .dashboard-card-highlights column -- a stray vertical divider line with
  // nothing next to it. Treat a zero-length array the same as "no highlights" instead.
  const hasHighlights = Array.isArray(highlights) ? highlights.length > 0 : !!highlights;
  return (
    <div className={`dashboard-card-slot ${slotClassName}`}>
      <button
        className={`dashboard-balance-card ${cardClassName}${hero ? " dashboard-card-hero" : ""}${open ? " dashboard-card-open" : ""}`}
        onClick={onClick}
      >
        {icon && <StatIcon kind={icon} color={iconColor ?? "#1e40af"} />}
        <div className="dashboard-card-main">
          <span>{label}</span>
          {/* AutoFitAmount, not a plain <strong>, so a wide 7-figure balance shrinks to fit this
             card's own width instead of clipping against the highlights column beside it -- the
             hero card's bigger headline font made that overflow real at the app's actual ~450px
             card width, the same failure mode already fixed for Tax's summary cards. Only wired
             up for the plain-string values every real caller passes (fmt(number)); a non-string
             value falls back to a plain <strong> so nothing breaks if a future caller passes
             JSX instead. Hero cards get a taller ceiling (36px) than the demoted secondary
             cards (24px) -- the actual size difference that gives the dashboard a hierarchy
             instead of every card shouting the same volume. */}
          {typeof value === "string" ? (
            <AutoFitAmount text={value} maxFontSize={hero ? 36 : 24} minFontSize={hero ? 20 : 14} />
          ) : (
            <strong>{value}</strong>
          )}
          {trend && (
            <em className={`dashboard-card-trend ${trend.positive ? "dashboard-card-trend--pos" : "dashboard-card-trend--neg"}`}>
              {trend.text}
            </em>
          )}
          {subtitle && <small>{subtitle}</small>}
        </div>
        {hasHighlights && <div className="dashboard-card-highlights">{highlights}</div>}
      </button>
      {children}
    </div>
  );
}
