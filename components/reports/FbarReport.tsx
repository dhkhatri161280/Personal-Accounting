"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeFbarSummary, TREASURY_YEAR_END_RATE_INR, FBAR_THRESHOLD_USD } from "@/lib/fbar";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Computational aid for FinCEN Form 114 (FBAR) -- surfaces the two numbers the form actually
// needs per account (the calendar year's peak native-currency balance, and its USD equivalent at
// the Treasury's own Dec 31 Reporting Rate of Exchange, NOT the IRS's year-average rate used for
// income tax). This app does not file anything -- FBARs are submitted electronically through
// FinCEN's own BSA E-Filing System (bsaefiling.fincen.gov), which has no API this app could
// submit to even if it wanted to. See lib/fbar.ts's own doc comment for the exact rules this
// follows.
export function FbarReport({ data }: { data: Ledger }) {
  const availableYears = Object.keys(TREASURY_YEAR_END_RATE_INR).map(Number).sort((a, b) => b - a);
  const [year, setYear] = useState(availableYears[0] ?? new Date().getFullYear() - 1);
  const [showInfo, setShowInfo] = useState(false);

  const summary = useMemo(() => computeFbarSummary(data, year), [data, year]);
  const deadline = `April 15, ${year + 1} (automatically extended to October 15, ${year + 1} -- no request needed)`;
  const today = todayLocalIso();
  const extendedDeadlinePassed = today > `${year + 1}-10-15`;

  async function exportFbar() {
    const header = ["Account", "Group", "Nature", `Peak Balance (INR)`, "Peak Date", `USD @ ${summary.rate?.rate ?? ""} (Treasury ${summary.rate?.asOf ?? ""})`];
    const rows = summary.rows.map((r) => [r.name, r.parent, r.nature, r.maxBalanceNative, r.maxBalanceDate ? fmtDate(r.maxBalanceDate) : "(carried from before this year)", r.maxBalanceUsd]);
    rows.push(["TOTAL", "", "", "", "", summary.totalUsd]);
    await exportWorkbook(`FBAR Worksheet CY${year}.xlsx`, [{ name: `FBAR CY${year}`, rows: [header, ...rows] }]);
  }

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        FBAR Worksheet (FinCEN Form 114)
        <span className="info-icon-wrap" onMouseEnter={() => setShowInfo(true)} onMouseLeave={() => setShowInfo(false)}>
          <button type="button" className="info-icon-btn" aria-label="How this works" onClick={() => setShowInfo((v) => !v)}>
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              A US person with a financial interest in (or signature authority over) foreign financial accounts
              totaling more than $10,000 at ANY point during the calendar year must file an FBAR. For each account
              below, this finds the single highest balance it reached during the year (not the Dec 31 closing
              balance, not an average), then converts it to USD using the US Treasury's own Reporting Rate of
              Exchange as of December 31 of that year -- the specific rate FBAR requires, different from the IRS's
              year-average rate used for income tax. This is a computational aid only, not tax or legal advice --
              verify every figure yourself before filing, and confirm which rows are genuinely reportable (this
              lists every Bank/Investment-nature account; some may not apply to you, e.g. a closed or jointly-owned-
              with-no-interest account). FBARs are filed electronically through FinCEN's own BSA E-Filing System at{" "}
              bsaefiling.fincen.gov -- this app cannot file on your behalf.
            </div>
          )}
        </span>
      </h3>

      <div className="master-toolbar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {availableYears.map((y) => (
            <option key={y} value={y}>
              Calendar Year {y}
            </option>
          ))}
        </select>
        <ExportButton onExport={exportFbar} disabled={summary.rows.length === 0} />
      </div>

      <p
        style={{
          margin: "0 0 14px",
          padding: "10px 14px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          background: extendedDeadlinePassed ? "#fee2e2" : "#fef9c3",
          color: extendedDeadlinePassed ? "#991b1b" : "#713f12",
          border: `1px solid ${extendedDeadlinePassed ? "#fecaca" : "#fde047"}`,
        }}
      >
        {extendedDeadlinePassed
          ? `CY${year} FBAR deadline (${deadline}) has passed.`
          : `CY${year} FBAR is due ${deadline}.`}{" "}
        File electronically at bsaefiling.fincen.gov -- this report is only a worksheet to help you fill it out.
      </p>

      {!summary.rate && (
        <p style={{ opacity: 0.7 }}>
          No Treasury year-end exchange rate is on file for {year} yet (lib/fbar.ts's TREASURY_YEAR_END_RATE_INR) --
          USD figures below can't be computed until that's added.
        </p>
      )}

      {summary.rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No Bank or Investment-nature accounts found.</p>
      ) : (
        <>
          <section className="equity-summary-row" style={{ marginBottom: 18 }}>
            <div className="equity-summary-col">
              <div className="equity-summary-card">
                <div className="equity-summary-card-body">
                  <span>Combined peak value (USD)</span>
                  <strong className="equity-amt">{summary.rate ? fmtUsd(summary.totalUsd) : "—"}</strong>
                </div>
              </div>
            </div>
            <div className="equity-summary-col">
              <div className="equity-summary-card">
                <div className="equity-summary-card-body">
                  <span>Filing threshold</span>
                  <strong
                    className="equity-amt"
                    style={{ color: summary.thresholdExceeded ? "#dc2626" : "#16a34a" }}
                  >
                    {summary.thresholdExceeded ? `Exceeds ${fmtUsd(FBAR_THRESHOLD_USD)} — filing required` : `Under ${fmtUsd(FBAR_THRESHOLD_USD)}`}
                  </strong>
                </div>
              </div>
            </div>
          </section>

          <table className="fx-ledger-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Group</th>
                <th className="right">Peak Balance (INR)</th>
                <th>Peak Date</th>
                <th className="right">USD Equivalent</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.accountId}>
                  <td>{r.name}</td>
                  <td>{r.parent}</td>
                  <td className="right">{fmtInr(r.maxBalanceNative)}</td>
                  <td>{r.maxBalanceDate ? fmtDate(r.maxBalanceDate) : <em style={{ opacity: 0.6 }}>carried from before {year}</em>}</td>
                  <td className="right">{summary.rate ? fmtUsd(r.maxBalanceUsd) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={4}>Total</th>
                <th className="right">{summary.rate ? fmtUsd(summary.totalUsd) : "—"}</th>
              </tr>
            </tfoot>
          </table>

          {summary.rate && (
            <p style={{ fontSize: 11, opacity: 0.6, marginTop: 10 }}>
              Converted at {summary.rate.rate} INR/USD — {summary.rate.source}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
