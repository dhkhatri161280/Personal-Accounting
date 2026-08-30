"use client";
import { useState } from "react";
import { StatIcon, type IconKind } from "@/components/Icon";
import { DonutChart, DONUT_PALETTE } from "@/components/DonutChart";
import type { NetWorthPoint } from "@/lib/net-worth-trend";

interface NWRow {
  id: number | string;
  name: string;
  parent?: string;
  category?: string;
  closing: number;
  // Set on synthetic (non-ledger) rows -- where the number actually comes from, so it can link
  // there instead of a ledger drill-down popup that has no real account behind it.
  sourceTab?: "retirement" | "equity";
}

const ASSET_ORDER = ["Bank & Cash", "Investments", "Equity Holdings (RSU/ESPP)", "Fixed Assets", "Other Assets"];
function assetCategory(parent: string): string {
  const p = (parent || "").toLowerCase();
  if (p === "equity holdings (rsu/espp)") return "Equity Holdings (RSU/ESPP)";
  if (/bank accounts|cash-in-hand/.test(p)) return "Bank & Cash";
  if (/investments?|retirement/.test(p)) return "Investments";
  if (/fixed assets?/.test(p)) return "Fixed Assets";
  return "Other Assets";
}

/** Synthetic asset row for vested RSU/ESPP shares still held -- these aren't booked as a ledger
 * account (there's nothing to double-entry until sold), so Net Worth adds their live market
 * value as an extra row alongside the real ledger-derived asset rows. */
export function equityHoldingsRow(id: string, value: number): NWRow {
  return { id, name: "RSU + ESPP (vested, held)", parent: "Equity Holdings (RSU/ESPP)", closing: -value, sourceTab: "equity" };
}

/** Synthetic asset row valuing 401(k)/IRA at real market value (live from Fidelity/Merrill via
 * Plaid) instead of the ledger's book value (cumulative payroll contributions) -- the caller is
 * responsible for excluding the real "401K Investments" ledger row from `assets` when using this,
 * same one-or-the-other substitution NetWorthReport does nowhere else (RSU/ESPP above is purely
 * additive since there's no ledger row for it to replace). */
export function retirementLiveRow(id: string, value: number): NWRow {
  return { id, name: "401(k) + IRA (live, Fidelity + Merrill)", parent: "Investments", closing: -value, sourceTab: "retirement" };
}

const LIAB_ORDER = ["Loans", "Credit Cards & Payables", "Other Liabilities"];
function liabilityCategory(parent: string, name: string): string {
  const p = (parent || "").toLowerCase();
  const n = (name || "").toLowerCase();
  if (/loan|bank od/.test(p)) return "Loans";
  if (/credit card/.test(n) || /sundry creditors/.test(p)) return "Credit Cards & Payables";
  return "Other Liabilities";
}

function groupTotals(rows: NWRow[], sign: 1 | -1, categoryOf: (r: NWRow) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const cat = categoryOf(r);
    m.set(cat, (m.get(cat) || 0) + sign * r.closing);
  }
  return m;
}

// Same category totals as groupTotals, but keeping each category's member rows (with their own
// signed amount) for the click-to-expand drill-down -- a category on its own is just a sum, not
// something you can click through to an individual ledger.
function groupMembers(rows: NWRow[], sign: 1 | -1, categoryOf: (r: NWRow) => string): Map<string, { row: NWRow; amount: number }[]> {
  const m = new Map<string, { row: NWRow; amount: number }[]>();
  for (const r of rows) {
    const cat = categoryOf(r);
    (m.get(cat) ?? m.set(cat, []).get(cat)!).push({ row: r, amount: sign * r.closing });
  }
  for (const list of m.values()) list.sort((a, b) => b.amount - a.amount);
  return m;
}

export function NetWorthReport({
  assets,
  liabilities,
  trend,
  fmt,
  uiTheme,
  onSelectAccount,
  onNavigateSource,
}: {
  assets: NWRow[];
  liabilities: NWRow[];
  trend: NetWorthPoint[];
  fmt: (n: number) => string;
  uiTheme?: string;
  onSelectAccount?: (id: number) => void;
  onNavigateSource?: (tab: "retirement" | "equity") => void;
}) {
  const totalAssets = assets.reduce((s, a) => s - a.closing, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.closing, 0);
  const netWorth = totalAssets - totalLiabilities;

  const assetGroups = groupTotals(assets, -1, (r) => assetCategory(r.parent || r.category || ""));
  const liabGroups = groupTotals(liabilities, 1, (r) => liabilityCategory(r.parent || r.category || "", r.name));
  const assetMembers = groupMembers(assets, -1, (r) => assetCategory(r.parent || r.category || ""));
  const liabMembers = groupMembers(liabilities, 1, (r) => liabilityCategory(r.parent || r.category || "", r.name));
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [expandedLiab, setExpandedLiab] = useState<string | null>(null);

  // A real ledger row (numeric id) drills into its full ledger via onSelectAccount. A synthetic
  // row (RSU/ESPP or 401(k)/IRA live value) has no ledger behind it -- it links to the report
  // that actually produces the number instead, so "where did this come from" always has an
  // answer rather than a dead-end plain label.
  const SOURCE_LABEL: Record<"retirement" | "equity", string> = { retirement: "Import › Retirement", equity: "Reports › Equity" };
  function memberLabel(row: NWRow) {
    if (typeof row.id === "number" && onSelectAccount) {
      return <button className="ledger-link" onClick={() => onSelectAccount(row.id as number)}>{row.name}</button>;
    }
    if (row.sourceTab && onNavigateSource) {
      return (
        <button className="ledger-link" onClick={() => onNavigateSource(row.sourceTab!)} title={`Not in the books -- live from ${SOURCE_LABEL[row.sourceTab]}`}>
          {row.name} <span style={{ opacity: 0.55, fontWeight: 400 }}>({SOURCE_LABEL[row.sourceTab]})</span>
        </button>
      );
    }
    return <span>{row.name}</span>;
  }

  const summaryCards: { label: string; value: number; icon: IconKind; color: string; sub: string }[] = [
    { label: "Total Assets", value: totalAssets, icon: "trending-up", color: "#16a34a", sub: "bank, cash, investments, fixed & other assets" },
    { label: "Total Liabilities", value: totalLiabilities, icon: "scale", color: "#dc2626", sub: "loans, credit cards, payables (real debt only)" },
    {
      label: "Net Worth",
      value: netWorth,
      icon: "wallet",
      color: netWorth >= 0 ? "#0d9488" : "#dc2626",
      sub: "Total Assets − Total Liabilities",
    },
  ];

  // Labels are drawn *inside* the SVG at each point's own x, rather than in a separate flex row
  // below it -- two independently-laid-out elements (SVG internal viewBox scaling vs. a CSS flex
  // row) can drift out of alignment under container-width or flex quirks elsewhere in the app;
  // putting the text in the same coordinate space as the dots makes misalignment impossible.
  const W = 720,
    PAD_X = 32,
    PLOT_TOP = 16,
    PLOT_BOTTOM = 168,
    LABEL_Y = 196,
    H = 210;
  const hasTrend = trend.length > 1;
  const vals = trend.map((p) => p.netWorth);
  const min = Math.min(0, ...vals),
    max = Math.max(0, ...vals, 1);
  const range = max - min || 1;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const stepX = trend.length > 1 ? (W - PAD_X * 2) / (trend.length - 1) : 0;
  const xy = (i: number, v: number): [number, number] => {
    const x = PAD_X + i * stepX;
    const y = PLOT_BOTTOM - ((v - min) / range) * plotHeight;
    return [x, y];
  };
  const pathD = trend
    .map((p, i) => {
      const [x, y] = xy(i, p.netWorth);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const zeroY = PLOT_BOTTOM - ((0 - min) / range) * plotHeight;
  const lineColor = netWorth >= 0 ? "#16a34a" : "#dc2626";

  return (
    <>
      <div className="equity-summary-row">
        {summaryCards.map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div className="equity-summary-card">
              {uiTheme === "refresh" && <StatIcon kind={c.icon} color={c.color} />}
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <strong className="equity-amt">{fmt(c.value)}</strong>
                <em>{c.sub}</em>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="equity-section-head" style={{ marginTop: "1.5rem" }}>
        <h4>Breakdown</h4>
      </div>
      <div className="equity-summary-row" style={{ alignItems: "stretch" }}>
        {hasTrend && (
          <div className="equity-summary-col" style={{ flex: "2 1 480px" }}>
            <div className="data-panel" style={{ height: "100%" }}>
              <h4 style={{ margin: "0 0 0.75rem" }}>Net Worth Over Time</h4>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ overflow: "visible" }}>
                <line x1={PAD_X} y1={zeroY} x2={W - PAD_X} y2={zeroY} stroke="#cbd5e1" strokeDasharray="4 4" />
                <path d={pathD} fill="none" stroke={lineColor} strokeWidth={2} />
                {trend.map((p, i) => {
                  const [x, y] = xy(i, p.netWorth);
                  return (
                    <g key={p.label}>
                      <circle cx={x} cy={y} r={3} fill={p.netWorth >= 0 ? "#16a34a" : "#dc2626"} />
                      <text x={x} y={LABEL_Y} fontSize={10} fill="#64748b" textAnchor="end" transform={`rotate(-40 ${x} ${LABEL_Y})`}>
                        {p.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}
        {assetGroups.size > 0 && (
          <div className="equity-summary-col" style={{ flex: "1 1 260px" }}>
            <div className="data-panel" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <DonutChart
                segments={[...assetGroups.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([label, value], i) => ({ label, value, color: DONUT_PALETTE[i % DONUT_PALETTE.length] }))}
                centerLabel="Total Assets"
                centerValue={fmt(totalAssets)}
                fmt={fmt}
                legend={false}
              />
            </div>
          </div>
        )}
      </div>
      <div className="equity-summary-row">
        <div className="equity-summary-col" style={{ flex: "1 1 320px" }}>
          <div className="data-panel">
            <h4 style={{ marginTop: 0 }}>Assets</h4>
            {[...assetGroups.entries()]
              .sort((a, b) => ASSET_ORDER.indexOf(a[0]) - ASSET_ORDER.indexOf(b[0]))
              .map(([cat, v]) => {
                const open = expandedAsset === cat;
                const members = assetMembers.get(cat) ?? [];
                return (
                  <div key={cat}>
                    <div
                      className="bs-row"
                      style={{ cursor: "pointer" }}
                      onClick={() => setExpandedAsset(open ? null : cat)}
                    >
                      <span>{open ? "▾ " : "▸ "}{cat}</span>
                      <span style={{ color: "#16a34a" }}>{fmt(v)}</span>
                    </div>
                    {open && (
                      <div style={{ padding: "0 0 8px 18px" }}>
                        {members.map(({ row, amount }) => (
                          <div key={row.id} className="bs-row" style={{ fontSize: 12, opacity: 0.85 }}>
                            {memberLabel(row)}
                            <span style={{ color: "#16a34a" }}>{fmt(amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
        <div className="equity-summary-col" style={{ flex: "1 1 320px" }}>
          <div className="data-panel">
            <h4 style={{ marginTop: 0 }}>Liabilities</h4>
            {liabGroups.size === 0 ? (
              <p className="equity-empty">No outstanding liabilities.</p>
            ) : (
              [...liabGroups.entries()]
                .sort((a, b) => LIAB_ORDER.indexOf(a[0]) - LIAB_ORDER.indexOf(b[0]))
                .map(([cat, v]) => {
                  const open = expandedLiab === cat;
                  const members = liabMembers.get(cat) ?? [];
                  return (
                    <div key={cat}>
                      <div
                        className="bs-row"
                        style={{ cursor: "pointer" }}
                        onClick={() => setExpandedLiab(open ? null : cat)}
                      >
                        <span>{open ? "▾ " : "▸ "}{cat}</span>
                        <span style={{ color: "#dc2626" }}>{fmt(v)}</span>
                      </div>
                      {open && (
                        <div style={{ padding: "0 0 8px 18px" }}>
                          {members.map(({ row, amount }) => (
                            <div key={row.id} className="bs-row" style={{ fontSize: 12, opacity: 0.85 }}>
                              {memberLabel(row)}
                              <span style={{ color: "#dc2626" }}>{fmt(amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
