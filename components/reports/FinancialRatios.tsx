"use client";
import type React from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeFinancialRatios, type RatioPoint } from "@/lib/financial-ratios";

const GOOD = "#16a34a";
const BAD = "#dc2626";
const ZERO_TOL = 0.005;

function cell(v: number, fmt: (n: number) => string): string {
  return Math.abs(v) < ZERO_TOL ? "–" : fmt(v);
}
function pct(v: number | null): string {
  return v === null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function FinancialRatios({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const points = computeFinancialRatios(data);

  if (points.length === 0) {
    return (
      <div className="data-panel">
        <p style={{ opacity: 0.7 }}>No transaction history yet to build financial ratios from.</p>
      </div>
    );
  }

  const rows: { label: string; render: (p: RatioPoint) => React.ReactNode }[] = [
    { label: "Savings Rate", render: (p) => <span style={{ color: p.savingsRate === null ? undefined : p.savingsRate >= 0 ? GOOD : BAD }}>{p.savingsRate === null ? "–" : `${p.savingsRate.toFixed(1)}%`}</span> },
    { label: "Liquid Assets (Bank + Cash)", render: (p) => cell(p.liquidAssets, fmt) },
    { label: "Total Debt", render: (p) => cell(p.totalDebt, fmt) },
    {
      label: "Emergency Fund (months)",
      render: (p) =>
        p.emergencyFundMonths === null ? (
          "–"
        ) : (
          <span style={{ color: p.emergencyFundMonths >= 3 ? GOOD : BAD }}>{p.emergencyFundMonths.toFixed(1)}</span>
        ),
    },
    {
      label: "Debt-to-Income",
      render: (p) => (p.debtToIncome === null ? "–" : <span style={{ color: p.debtToIncome <= 3 ? GOOD : BAD }}>{p.debtToIncome.toFixed(2)}×</span>),
    },
    { label: "Net Worth Growth", render: (p) => <span style={{ color: p.netWorthGrowthPct === null || p.netWorthGrowthPct >= 0 ? GOOD : BAD }}>{pct(p.netWorthGrowthPct)}</span> },
  ];

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <h3>Financial Ratios</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Emergency Fund = liquid assets ÷ monthly expense (3+ months is a common baseline). Debt-to-Income = total debt ÷ annual
        income (lower is better; includes the mortgage balance when this book has a "Home" account).
      </p>
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
