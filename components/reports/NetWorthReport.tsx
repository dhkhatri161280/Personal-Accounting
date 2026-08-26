"use client";
import { StatIcon, type IconKind } from "@/components/Icon";
import type { NetWorthPoint } from "@/lib/net-worth-trend";

interface NWRow {
  id: number | string;
  name: string;
  parent?: string;
  category?: string;
  closing: number;
}

const ASSET_ORDER = ["Bank & Cash", "Investments", "Fixed Assets", "Other Assets"];
function assetCategory(parent: string): string {
  const p = (parent || "").toLowerCase();
  if (/bank accounts|cash-in-hand/.test(p)) return "Bank & Cash";
  if (/investments?/.test(p)) return "Investments";
  if (/fixed assets?/.test(p)) return "Fixed Assets";
  return "Other Assets";
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

export function NetWorthReport({
  assets,
  liabilities,
  trend,
  fmt,
  uiTheme,
}: {
  assets: NWRow[];
  liabilities: NWRow[];
  trend: NetWorthPoint[];
  fmt: (n: number) => string;
  uiTheme?: string;
}) {
  const totalAssets = assets.reduce((s, a) => s - a.closing, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.closing, 0);
  const netWorth = totalAssets - totalLiabilities;

  const assetGroups = groupTotals(assets, -1, (r) => assetCategory(r.parent || r.category || ""));
  const liabGroups = groupTotals(liabilities, 1, (r) => liabilityCategory(r.parent || r.category || "", r.name));

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

  const W = 720,
    H = 220,
    PAD = 32;
  const hasTrend = trend.length > 1;
  const vals = trend.map((p) => p.netWorth);
  const min = Math.min(0, ...vals),
    max = Math.max(0, ...vals, 1);
  const range = max - min || 1;
  const stepX = trend.length > 1 ? (W - PAD * 2) / (trend.length - 1) : 0;
  const xy = (i: number, v: number): [number, number] => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return [x, y];
  };
  const pathD = trend
    .map((p, i) => {
      const [x, y] = xy(i, p.netWorth);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
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

      {hasTrend && (
        <div className="data-panel" style={{ marginTop: "1rem" }}>
          <h4 style={{ margin: "0 0 0.75rem" }}>Net Worth Over Time</h4>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ overflow: "visible" }}>
            <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#cbd5e1" strokeDasharray="4 4" />
            <path d={pathD} fill="none" stroke={lineColor} strokeWidth={2} />
            {trend.map((p, i) => {
              const [x, y] = xy(i, p.netWorth);
              return <circle key={p.label} cx={x} cy={y} r={3} fill={p.netWorth >= 0 ? "#16a34a" : "#dc2626"} />;
            })}
          </svg>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "#64748b", marginTop: 4 }}>
            {trend.map((p) => (
              <span key={p.label}>{p.label}</span>
            ))}
          </div>
        </div>
      )}

      <div className="equity-section-head" style={{ marginTop: "1.5rem" }}>
        <h4>Breakdown</h4>
      </div>
      <div className="equity-summary-row">
        <div className="equity-summary-col" style={{ flex: "1 1 320px" }}>
          <div className="data-panel">
            <h4 style={{ marginTop: 0 }}>Assets</h4>
            {[...assetGroups.entries()]
              .sort((a, b) => ASSET_ORDER.indexOf(a[0]) - ASSET_ORDER.indexOf(b[0]))
              .map(([cat, v]) => (
                <div key={cat} className="bs-row">
                  <span>{cat}</span>
                  <span>{fmt(v)}</span>
                </div>
              ))}
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
                .map(([cat, v]) => (
                  <div key={cat} className="bs-row">
                    <span>{cat}</span>
                    <span>{fmt(v)}</span>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
