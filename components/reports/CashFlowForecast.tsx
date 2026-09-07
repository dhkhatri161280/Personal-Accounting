"use client";
import { useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeCashFlowForecast } from "@/lib/cash-flow-forecast";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const GOOD = "#16a34a";
const BAD = "#dc2626";

export function CashFlowForecast({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [months, setMonths] = useState(6);
  const { points, unplacedYearly } = computeCashFlowForecast(data, months);

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <h3>Cash Flow Forecast</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Projects cash forward using active monthly Recurring Transactions and active Loan payments only -- Fixed Asset
        depreciation and Prepaid amortization are non-cash and excluded. Assumes today's recurring amounts and loan terms stay
        constant; doesn't account for one-off spending.
      </p>
      <div className="master-toolbar">
        <label>
          Months ahead{" "}
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <ExportButton
          onExport={async () => {
            const header = ["", ...points.map((p) => p.label)];
            const body = [
              ["Recurring Net", ...points.map((p) => p.recurringNet)],
              ["Loan Payments", ...points.map((p) => p.loanPayments)],
              ["Projected Cash", ...points.map((p) => p.projectedCash)],
              [],
              ["Upcoming annual items (timing not tracked)"],
              ["Item", "Amount"],
              ...unplacedYearly.map((item) => [item.label, item.amount]),
            ];
            await exportWorkbook("Cash Flow Forecast.xlsx", [{ name: "Cash Flow Forecast", rows: [header, ...body] }]);
          }}
        />
      </div>
      <div className="columnar-report-scroll">
        <table className="columnar-report-table">
          <thead>
            <tr>
              <th></th>
              {points.map((p) => (
                <th className="right" key={p.period}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Recurring Net</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.recurringNet >= 0 ? GOOD : BAD }}>
                  {fmt(p.recurringNet)}
                </td>
              ))}
            </tr>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Loan Payments</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.loanPayments > 0 ? BAD : undefined }}>
                  {p.loanPayments > 0 ? `(${fmt(p.loanPayments)})` : fmt(0)}
                </td>
              ))}
            </tr>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">
                <strong>Projected Cash</strong>
              </td>
              {points.map((p) => (
                <td className="right" key={p.period}>
                  <strong style={{ color: p.projectedCash >= 0 ? GOOD : BAD }}>{fmt(p.projectedCash)}</strong>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {unplacedYearly.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: "0 0 8px" }}>Upcoming annual items (timing not tracked)</h4>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
            These recur yearly but the app doesn't know which month -- not included in the projection above.
          </p>
          {unplacedYearly.map((item) => (
            <div className="report-line" key={item.label}>
              <span>{item.label}</span>
              <span style={{ color: item.amount >= 0 ? GOOD : BAD }}>{fmt(item.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
