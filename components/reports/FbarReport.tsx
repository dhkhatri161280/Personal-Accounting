"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeFbarSummary, TREASURY_YEAR_END_RATE_INR, FBAR_THRESHOLD_USD, type FbarAccountRow } from "@/lib/fbar";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TREATMENT_LABEL: Record<FbarAccountRow["treatment"], string> = {
  include: "Include (ledger balance)",
  exclude: "Exclude",
  manual: "Manual value",
};

// Computational aid for FinCEN Form 114 (FBAR) -- surfaces the two numbers the form actually
// needs per account (the calendar year's peak native-currency balance, and its USD equivalent at
// the Treasury's own Dec 31 Reporting Rate of Exchange, NOT the IRS's year-average rate used for
// income tax). This app does not file anything -- FBARs are submitted electronically through
// FinCEN's own BSA E-Filing System (bsaefiling.fincen.gov), which has no API this app could
// submit to even if it wanted to. See lib/fbar.ts's own doc comment for the exact rules this
// follows.
//
// Not every Bank/Investment-nature account is actually a reportable balance -- confirmed live: a
// ledger like "LIC Premium" tracks cumulative premiums PAID, not a policy's real cash surrender
// value, and showing its running balance as the "FBAR amount" would have been a genuine, material
// overstatement. The Treatment dropdown per row lets the user mark a ledger like that "Exclude"
// (it has no reportable value of its own) or "Manual value" (it IS a real foreign financial
// account -- e.g. a non-term life insurance policy -- but its true value, like a cash surrender
// value, isn't what this ledger's balance reflects, so the user enters the real figure directly).
// Both choices are stored on the account itself (Account.fbarTreatment), so they carry forward to
// next year's filing automatically instead of needing to be re-decided from scratch every year.
export function FbarReport({
  data,
  onSetTreatment,
  onSetManualValue,
}: {
  data: Ledger;
  onSetTreatment: (accountId: number, treatment: FbarAccountRow["treatment"]) => void;
  onSetManualValue: (accountId: number, year: number, valueInr: number | null) => void;
}) {
  const rateYears = Object.keys(TREASURY_YEAR_END_RATE_INR).map(Number);
  const [year, setYear] = useState(rateYears.length ? Math.max(...rateYears) : new Date().getFullYear() - 1);
  const [showInfo, setShowInfo] = useState(false);

  // Every calendar year worth reviewing -- not just the ones with a published Treasury rate on
  // file, so a prior year can still be browsed (rate-less years just show "—" for USD, same as
  // the existing "no rate on file" handling) and the dropdown doesn't silently hide a year just
  // because lib/fbar.ts hasn't been updated with that year's rate yet.
  const availableYears = useMemo(() => {
    let minYear = Infinity, maxYear = -Infinity;
    for (const t of data.transactions) {
      if (t.deleted) continue;
      const y = Number(t.date.slice(0, 4));
      if (Number.isFinite(y)) { if (y < minYear) minYear = y; if (y > maxYear) maxYear = y; }
    }
    const thisYear = new Date().getFullYear();
    const hi = Math.max(thisYear, maxYear, ...(rateYears.length ? rateYears : [thisYear]));
    const lo = Number.isFinite(minYear) ? minYear : hi;
    const years: number[] = [];
    for (let y = hi; y >= lo; y--) years.push(y);
    return years;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.transactions]);
  // Local draft text per manual-value input, keyed by accountId -- lets the field be edited
  // freely (including clearing it to type a new number) without committing on every keystroke;
  // only saved on blur/Enter.
  const [manualDrafts, setManualDrafts] = useState<Record<number, string>>({});

  const summary = useMemo(() => computeFbarSummary(data, year), [data, year]);
  const deadline = `April 15, ${year + 1} (automatically extended to October 15, ${year + 1} -- no request needed)`;
  const today = todayLocalIso();
  const extendedDeadlinePassed = today > `${year + 1}-10-15`;
  const needsAttentionCount = summary.rows.filter((r) => r.needsManualValue).length;

  function commitManualValue(accountId: number) {
    const draft = manualDrafts[accountId];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const n = trimmed === "" ? null : Number(trimmed);
    if (n !== null && (!Number.isFinite(n) || n < 0)) return; // ignore garbage input, leave the stored value as-is
    onSetManualValue(accountId, year, n);
    setManualDrafts((prev) => {
      const next = { ...prev };
      delete next[accountId];
      return next;
    });
  }

  const accountById = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);

  async function exportFbar() {
    // Everything Form 114 Part III asks for per account (Account Number, Mailing Address of the
    // Financial Institution), plus IFSC/routing and SWIFT, pulled straight from Masters -- so the
    // export is something to fill the actual PDF from, not just the computed balances.
    const header = [
      "Account", "Group", "Treatment", "Peak Balance (INR)", "Peak Date",
      `USD @ ${summary.rate?.rate ?? ""} (Treasury ${summary.rate?.asOf ?? ""})`,
      "Account Number", "IFSC / Routing", "SWIFT / BIC", "Branch", "Institution Address",
    ];
    const rows = summary.rows.map((r) => {
      const acct = accountById.get(r.accountId);
      return [
        r.name,
        r.parent,
        TREATMENT_LABEL[r.treatment] + (r.needsManualValue ? " — NEEDS VALUE" : ""),
        r.treatment === "exclude" ? "" : r.maxBalanceNative,
        r.maxBalanceDate ? fmtDate(r.maxBalanceDate) : r.treatment === "include" ? "(carried from before this year)" : "",
        r.treatment === "exclude" ? "" : r.maxBalanceUsd,
        acct?.bankAccountNumber ?? "",
        acct?.bankIfscOrRouting ?? "",
        acct?.bankSwiftCode ?? "",
        acct?.bankBranch ?? "",
        acct?.address ?? "",
      ];
    });
    rows.push(["TOTAL", "", "", "", "", summary.totalUsd, "", "", "", "", ""]);
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
              totaling more than $10,000 at ANY point during the calendar year must file an FBAR. For an "Include"
              account, this finds the single highest balance it reached during the year (not the Dec 31 closing
              balance, not an average), then converts it to USD using the US Treasury's own Reporting Rate of
              Exchange as of December 31 of that year -- the specific rate FBAR requires, different from the IRS's
              year-average rate used for income tax. "Exclude" is for a ledger that tracks something other than a
              real balance (e.g. premiums paid into a policy, not the policy's own value). "Manual value" is for a
              real foreign financial account (e.g. a life insurance policy's cash surrender value) whose true value
              isn't what this ledger's balance reflects -- enter the real figure directly, per year. Both choices
              are remembered on the account for next year automatically. This is a computational aid only, not tax
              or legal advice -- verify every figure yourself before filing. FBARs are filed electronically through
              FinCEN's own BSA E-Filing System at bsaefiling.fincen.gov -- this app cannot file on your behalf.
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

      {needsAttentionCount > 0 && (
        <p style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" }}>
          {needsAttentionCount} account{needsAttentionCount !== 1 ? "s" : ""} marked "Manual value" still need{needsAttentionCount === 1 ? "s" : ""} a {year} figure entered below -- not included in the total yet.
        </p>
      )}

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
                <th>Treatment</th>
                <th className="right">Peak Balance (INR)</th>
                <th>Peak Date</th>
                <th className="right">USD Equivalent</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.accountId} style={r.treatment === "exclude" ? { opacity: 0.5 } : r.needsManualValue ? { background: "#fef2f2" } : undefined}>
                  <td>{r.name}</td>
                  <td>{r.parent}</td>
                  <td>
                    <select
                      className="period-select-inline"
                      value={r.treatment}
                      onChange={(e) => onSetTreatment(r.accountId, e.target.value as FbarAccountRow["treatment"])}
                    >
                      <option value="include">{TREATMENT_LABEL.include}</option>
                      <option value="exclude">{TREATMENT_LABEL.exclude}</option>
                      <option value="manual">{TREATMENT_LABEL.manual}</option>
                    </select>
                  </td>
                  <td className="right">
                    {r.treatment === "exclude" ? (
                      <em style={{ opacity: 0.6 }}>excluded</em>
                    ) : r.treatment === "manual" ? (
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder={`${year} value needed`}
                        value={manualDrafts[r.accountId] ?? (r.needsManualValue ? "" : String(r.maxBalanceNative))}
                        onChange={(e) => setManualDrafts((prev) => ({ ...prev, [r.accountId]: e.target.value }))}
                        onBlur={() => commitManualValue(r.accountId)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        style={{ width: 130, textAlign: "right" }}
                      />
                    ) : (
                      fmtInr(r.maxBalanceNative)
                    )}
                  </td>
                  <td>
                    {r.treatment === "exclude" ? (
                      "—"
                    ) : r.treatment === "manual" ? (
                      <em style={{ opacity: 0.6 }}>entered for {year}</em>
                    ) : r.maxBalanceDate ? (
                      fmtDate(r.maxBalanceDate)
                    ) : (
                      <em style={{ opacity: 0.6 }}>carried from before {year}</em>
                    )}
                  </td>
                  <td className="right">{r.treatment === "exclude" ? "—" : summary.rate ? fmtUsd(r.maxBalanceUsd) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={5}>Total</th>
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
