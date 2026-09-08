"use client";
import type React from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeMultiYearTrend, type FyTrendPoint } from "@/lib/multi-year-trend";
import type { DrilldownRequest } from "@/components/reports/ColumnarSection";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";
const ZERO_TOL = 0.005;

function cell(v: number, fmt: (n: number) => string): string {
  return Math.abs(v) < ZERO_TOL ? "–" : fmt(v);
}
function pct(v: number | null): string {
  return v === null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function growthColor(v: number | null, favorableWhenPositive: boolean): string | undefined {
  if (v === null || Math.abs(v) < 0.05) return undefined;
  const favorable = favorableWhenPositive ? v >= 0 : v <= 0;
  return favorable ? MONEY_IN : MONEY_OUT;
}

export function MultiYearTrend({
  data,
  fmt,
  onDrilldown,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onDrilldown?: (req: DrilldownRequest) => void;
}) {
  const points = computeMultiYearTrend(data);

  if (points.length === 0) {
    return (
      <div className="data-panel">
        <p style={{ opacity: 0.7 }}>No transaction history yet to build a multi-year trend from.</p>
      </div>
    );
  }

  const drill = (p: FyTrendPoint, kind: "income" | "expense") => () =>
    onDrilldown?.({
      label: `${kind === "income" ? "Income" : "Expense"} — ${p.label}`,
      accountIds: kind === "income" ? p.incomeAccountIds : p.expenseAccountIds,
      start: p.start,
      end: p.end,
    });

  const rows: {
    label: string;
    render: (p: FyTrendPoint) => React.ReactNode;
  }[] = [
    { label: "Income", render: (p) => (onDrilldown ? <button type="button" className="columnar-cell-btn" onClick={drill(p, "income")}>{cell(p.income, fmt)}</button> : cell(p.income, fmt)) },
    { label: "Expense", render: (p) => (onDrilldown ? <button type="button" className="columnar-cell-btn" onClick={drill(p, "expense")}>{cell(p.expense, fmt)}</button> : cell(p.expense, fmt)) },
    { label: "Surplus / (Deficit)", render: (p) => <span style={{ color: p.surplus >= 0 ? MONEY_IN : MONEY_OUT }}>{cell(p.surplus, fmt)}</span> },
    { label: "Savings Rate", render: (p) => <span style={{ color: p.savingsRate === null ? undefined : p.savingsRate >= 0 ? MONEY_IN : MONEY_OUT }}>{p.savingsRate === null ? "–" : `${p.savingsRate.toFixed(1)}%`}</span> },
    { label: "Net Worth", render: (p) => cell(p.netWorth, fmt) },
    { label: "Income Growth", render: (p) => <span style={{ color: growthColor(p.incomeGrowthPct, true) }}>{pct(p.incomeGrowthPct)}</span> },
    { label: "Expense Growth", render: (p) => <span style={{ color: growthColor(p.expenseGrowthPct, false) }}>{pct(p.expenseGrowthPct)}</span> },
    { label: "Net Worth Growth", render: (p) => <span style={{ color: growthColor(p.netWorthGrowthPct, true) }}>{pct(p.netWorthGrowthPct)}</span> },
  ];

  async function exportTrend() {
    const header = ["", ...points.map((p) => p.label)];
    const exportRows: { label: string; value: (p: FyTrendPoint) => string | number }[] = [
      { label: "Income", value: (p) => p.income },
      { label: "Expense", value: (p) => p.expense },
      { label: "Surplus / (Deficit)", value: (p) => p.surplus },
      { label: "Savings Rate", value: (p) => (p.savingsRate === null ? "" : `${p.savingsRate.toFixed(1)}%`) },
      { label: "Net Worth", value: (p) => p.netWorth },
      { label: "Income Growth", value: (p) => pct(p.incomeGrowthPct) },
      { label: "Expense Growth", value: (p) => pct(p.expenseGrowthPct) },
      { label: "Net Worth Growth", value: (p) => pct(p.netWorthGrowthPct) },
    ];
    const body = exportRows.map((row) => [row.label, ...points.map((p) => row.value(p))]);
    await exportWorkbook("Multi-Year Trend.xlsx", [{ name: "Multi-Year Trend", rows: [header, ...body] }]);
  }

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <h3 style={{ margin: 0 }}>Multi-Year Trend</h3>
        <ExportButton onExport={exportTrend} />
      </div>
      <div className="columnar-report-scroll">
        <table className="columnar-report-table">
          <thead>
            <tr>
              <th></th>
              {points.map((p) => (
                <th className="right" key={p.fy}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="columnar-ledger-row">
                <td className="columnar-ledger-name">{row.label}</td>
                {points.map((p) => (
                  <td className="right" key={p.fy}>
                    {row.render(p)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
