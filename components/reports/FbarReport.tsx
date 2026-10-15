"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeFbarSummary, TREASURY_YEAR_END_RATE_INR, FBAR_THRESHOLD_USD, type FbarAccountRow } from "@/lib/fbar";
import { buildFbarXfaDatasets, fillFbarPdf, downloadFbarPdf, fbarFilerProfileComplete } from "@/lib/fbar-pdf";
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
  onSaveFilerProfile,
  onSetManualTreasuryRate,
}: {
  data: Ledger;
  onSetTreatment: (accountId: number, treatment: FbarAccountRow["treatment"]) => void;
  onSetManualValue: (accountId: number, year: number, valueInr: number | null) => void;
  onSaveFilerProfile: (profile: NonNullable<Ledger["fbarFilerProfile"]>) => void;
  onSetManualTreasuryRate: (year: number, rate: number | null) => void;
}) {
  const rateYears = Object.keys(TREASURY_YEAR_END_RATE_INR).map(Number);
  const [year, setYear] = useState(rateYears.length ? Math.max(...rateYears) : new Date().getFullYear() - 1);
  const [showInfo, setShowInfo] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

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
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

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
      "Account Number", "IFSC / Routing", "SWIFT / BIC", "Branch", "Institution Address", "City", "State", "Postal Code", "Country",
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
        acct?.bankCity ?? "",
        acct?.bankState ?? "",
        acct?.bankPostalCode ?? "",
        acct?.bankCountry || "India",
      ];
    });
    rows.push(["TOTAL", "", "", "", "", summary.totalUsd, "", "", "", "", "", "", "", "", ""]);
    await exportWorkbook(`FBAR Worksheet CY${year}.xlsx`, [{ name: `FBAR CY${year}`, rows: [header, ...rows] }]);
  }

  const filerProfile = data.fbarFilerProfile;
  const filerProfileReady = fbarFilerProfileComplete(filerProfile);
  const pdfDisabledReason = !summary.rate
    ? `No Treasury rate on file for ${year} yet.`
    : needsAttentionCount > 0
      ? "Enter the missing manual value(s) below first."
      : !filerProfileReady
        ? "Complete your FBAR filer profile in Masters > Settings first (name, SSN/ITIN, DOB, address)."
        : null;

  async function generatePdf() {
    if (!filerProfile || !filerProfileReady || !summary.rate) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      // Only reportable rows go on the actual form -- "exclude" is explicitly marked as having no
      // reportable value, and a "manual" row still missing its figure for this year can't be put
      // on a government filing as $0 (see needsAttentionCount's own guard above).
      const reportableRows = summary.rows.filter((r) => r.treatment !== "exclude" && !r.needsManualValue);
      const xml = buildFbarXfaDatasets({ year, filer: filerProfile, rows: reportableRows, accountById });
      const bytes = await fillFbarPdf(xml);
      downloadFbarPdf(bytes, `FinCEN Form 114 - CY${year} (pre-filled draft).pdf`);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "Could not generate the PDF.");
    } finally {
      setPdfBusy(false);
    }
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
              or legal advice -- verify every figure yourself before filing; this report is only a worksheet, not a
              filing. FBARs are filed electronically through FinCEN's own BSA E-Filing System at bsaefiling.fincen.gov
              -- this app cannot file on your behalf. "Generate FinCEN PDF" downloads a pre-filled DRAFT of the
              actual Form 114 PDF (using your FBAR filer
              profile from Masters &gt; Settings plus the rows below) -- it's a dynamic Adobe form, so it only opens
              correctly in Adobe Reader, not a browser or Preview. Review every field yourself before signing and
              submitting it on FinCEN's site.
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
        <button
          type="button"
          className="tr-refresh-btn"
          onClick={generatePdf}
          disabled={!!pdfDisabledReason || pdfBusy}
          title={pdfDisabledReason || "Downloads a pre-filled draft of the real FinCEN Form 114 PDF -- open it in Adobe Reader, review every field, then submit at bsaefiling.fincen.gov."}
        >
          {pdfBusy ? "Generating…" : "Generate FinCEN PDF"}
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => setShowSettingsPanel((v) => !v)}>
          {showSettingsPanel ? "Hide filer profile & rates" : "Filer profile & rates"}
        </button>
      </div>
      {showSettingsPanel && (
        <FbarSettingsPanel data={data} onSaveFilerProfile={onSaveFilerProfile} onSetManualTreasuryRate={onSetManualTreasuryRate} />
      )}
      {pdfError && (
        <p style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" }}>
          {pdfError}
        </p>
      )}

      {summary.rate ? (
        <p
          style={{
            margin: "0 0 14px",
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            background: summary.thresholdExceeded || extendedDeadlinePassed ? "#fee2e2" : "#dcfce7",
            color: summary.thresholdExceeded || extendedDeadlinePassed ? "#991b1b" : "#166534",
            border: `1px solid ${summary.thresholdExceeded || extendedDeadlinePassed ? "#fecaca" : "#bbf7d0"}`,
          }}
        >
          {summary.thresholdExceeded
            ? `FBAR filing required for CY${year} -- peak value ${fmtUsd(summary.totalUsd)} exceeds ${fmtUsd(FBAR_THRESHOLD_USD)}. ${extendedDeadlinePassed ? `Deadline (${deadline}) has passed.` : `Due ${deadline}.`}`
            : `No FBAR required for CY${year} -- peak value ${fmtUsd(summary.totalUsd)} is under ${fmtUsd(FBAR_THRESHOLD_USD)}.`}
          {needsAttentionCount > 0 ? " (Missing manual values below -- this may change once entered.)" : ""}
        </p>
      ) : (
        <p style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#fef9c3", color: "#713f12", border: "1px solid #fde047" }}>
          {extendedDeadlinePassed ? `CY${year} FBAR deadline (${deadline}) has passed.` : `CY${year} FBAR is due ${deadline}.`}
        </p>
      )}

      {needsAttentionCount > 0 && (
        <p style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" }}>
          {needsAttentionCount} account{needsAttentionCount !== 1 ? "s" : ""} marked "Manual value" still need{needsAttentionCount === 1 ? "s" : ""} a {year} figure entered below -- not included in the total yet.
        </p>
      )}

      {!summary.rate && (
        <p style={{ opacity: 0.7 }}>
          No Treasury year-end exchange rate is on file for {year} yet. Treasury typically publishes the December 31
          rate a few weeks into the following January -- once it's out, add it yourself in Masters &gt; Settings
          &gt; "FBAR Treasury rates (manual)", or ping Claude to add it to the app's own reviewed table.
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
            <div className="equity-summary-col">
              <div className="equity-summary-card">
                <div className="equity-summary-card-body">
                  <span>Exchange rate used{summary.rate ? ` (as of ${fmtDate(summary.rate.asOf)})` : ""}</span>
                  <strong className="equity-amt">{summary.rate ? `${summary.rate.rate} INR/USD` : "—"}</strong>
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
                <th className="right">USD Equivalent{summary.rate ? ` @ ${summary.rate.rate}` : ""}</th>
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

// Lives here (not Masters > Settings) deliberately -- both pieces are used ONLY from this report,
// so bundling them into the app-wide Settings form made that already-long page heavier for every
// screen that touches it, for something most people only ever open from here. Collapsed by
// default (see showSettingsPanel above) so it doesn't compete with the worksheet itself.
function FbarSettingsPanel({
  data,
  onSaveFilerProfile,
  onSetManualTreasuryRate,
}: {
  data: Ledger;
  onSaveFilerProfile: (profile: NonNullable<Ledger["fbarFilerProfile"]>) => void;
  onSetManualTreasuryRate: (year: number, rate: number | null) => void;
}) {
  const profile = data.fbarFilerProfile;
  // Editable rows for the manual Treasury rates table -- initialized from saved data once, then
  // owned here like any add/remove row list (not re-derived from `data` every render, which
  // would stomp an in-progress edit the instant an unrelated save elsewhere refreshes `data`).
  // `originalYear` tracks the key this row last actually saved under, separate from the `year`
  // field's current (possibly mid-edit) value -- needed so editing an existing row's year on
  // blur clears the OLD key rather than leaving it orphaned in data.fbarManualTreasuryRates.
  const [rateRows, setRateRows] = useState<{ originalYear: string | null; year: string; rate: string }[]>(() =>
    Object.entries(data.fbarManualTreasuryRates || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([year, rate]) => ({ originalYear: year, year, rate: String(rate) }))
  );

  function commitRate(index: number) {
    setRateRows((rows) => {
      const row = rows[index];
      if (!row) return rows;
      const rate = Number(row.rate);
      if (row.originalYear && row.originalYear !== row.year) onSetManualTreasuryRate(Number(row.originalYear), null);
      const valid = /^\d{4}$/.test(row.year) && Number.isFinite(rate) && rate > 0;
      if (valid) onSetManualTreasuryRate(Number(row.year), rate);
      return rows.map((r, i) => (i === index ? { ...r, originalYear: valid ? row.year : null } : r));
    });
  }

  return (
    <div className="data-panel" style={{ marginBottom: 18, padding: 14 }}>
      <h4 style={{ margin: "0 0 10px" }}>Filer profile & Treasury rates</h4>

      <p className="field-hint" style={{ marginTop: 0, marginBottom: 10 }}>
        Your own identity details for FinCEN Form 114 (FBAR) Part I -- nothing to do with ledger accounts, entered
        once so "Generate FinCEN PDF" above doesn't need these re-typed every filing year. Name/address are split to
        match the form's own fields exactly, since guessing how to split a single free-text name or address back
        apart isn't safe on an actual government filing.
      </p>
      <form
        className="master-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            firstName = String(f.get("firstName") || "").trim(),
            middleName = String(f.get("middleName") || "").trim(),
            lastName = String(f.get("lastName") || "").trim(),
            suffix = String(f.get("suffix") || "").trim(),
            ssnOrItin = String(f.get("ssnOrItin") || "").replace(/[^0-9]/g, ""),
            dateOfBirth = String(f.get("dateOfBirth") || "").trim(),
            street = String(f.get("street") || "").trim(),
            city = String(f.get("city") || "").trim(),
            state = String(f.get("state") || "").trim().toUpperCase(),
            zip = String(f.get("zip") || "").trim(),
            country = String(f.get("country") || "").trim();
          onSaveFilerProfile({
            firstName: firstName || undefined,
            middleName: middleName || undefined,
            lastName: lastName || undefined,
            suffix: suffix || undefined,
            ssnOrItin: ssnOrItin || undefined,
            dateOfBirth: dateOfBirth || undefined,
            street: street || undefined,
            city: city || undefined,
            state: state || undefined,
            zip: zip || undefined,
            country: country || "United States",
          });
        }}
      >
        <label>
          First name
          <input name="firstName" defaultValue={profile?.firstName || ""} autoComplete="off" />
        </label>
        <label>
          Middle name (optional)
          <input name="middleName" defaultValue={profile?.middleName || ""} autoComplete="off" />
        </label>
        <label>
          Last name
          <input name="lastName" defaultValue={profile?.lastName || ""} autoComplete="off" />
        </label>
        <label>
          Suffix (optional)
          <input name="suffix" defaultValue={profile?.suffix || ""} placeholder="Jr., Sr., III" autoComplete="off" />
        </label>
        <label>
          SSN / ITIN
          <input name="ssnOrItin" defaultValue={profile?.ssnOrItin || ""} placeholder="123456789 (digits only)" autoComplete="off" />
        </label>
        <label>
          Date of birth
          <input type="date" name="dateOfBirth" defaultValue={profile?.dateOfBirth || ""} autoComplete="off" />
        </label>
        <label>
          Street address
          <input name="street" defaultValue={profile?.street || ""} autoComplete="off" />
        </label>
        <label>
          City
          <input name="city" defaultValue={profile?.city || ""} autoComplete="off" />
        </label>
        <label>
          State
          <input name="state" defaultValue={profile?.state || ""} placeholder="CA" maxLength={2} autoComplete="off" />
        </label>
        <label>
          ZIP
          <input name="zip" defaultValue={profile?.zip || ""} autoComplete="off" />
        </label>
        <label>
          Country
          <input name="country" defaultValue={profile?.country || "United States"} autoComplete="off" />
        </label>
        <button className="primary">Save filer profile</button>
      </form>

      <h4 style={{ margin: "18px 0 6px" }}>Treasury rates</h4>
      <p className="field-hint" style={{ marginTop: 0, marginBottom: 10 }}>
        The years below are already reviewed and built into the app -- add a row only for a year this worksheet
        shows "no rate on file" for (Treasury publishes the December 31 rate a few weeks into the following January,
        at api.fiscaldata.treasury.gov). A manual entry never overrides a year already built in.
      </p>
      <table className="fx-ledger-table" style={{ marginBottom: 10 }}>
        <thead>
          <tr>
            <th>Year</th>
            <th className="right">Rate (INR/USD)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(TREASURY_YEAR_END_RATE_INR)
            .sort(([a], [b]) => Number(b) - Number(a))
            .map(([y, info]) => (
              <tr key={y} style={{ opacity: 0.6 }}>
                <td>{y}</td>
                <td className="right">{info.rate}</td>
                <td>
                  <em style={{ fontStyle: "normal", fontSize: 12 }}>Built into the app</em>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <table className="fx-ledger-table" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th>Year</th>
            <th className="right">Rate (INR/USD)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rateRows.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ opacity: 0.6, fontSize: 12 }}>
                No manual entries yet.
              </td>
            </tr>
          ) : (
            rateRows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="number"
                    value={row.year}
                    placeholder="2026"
                    style={{ width: 90 }}
                    onChange={(e) => setRateRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, year: e.target.value } : r)))}
                    onBlur={() => commitRate(i)}
                  />
                </td>
                <td className="right">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={row.rate}
                    placeholder="89.5"
                    style={{ width: 100, textAlign: "right" }}
                    onChange={(e) => setRateRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, rate: e.target.value } : r)))}
                    onBlur={() => commitRate(i)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="master-delete"
                    onClick={() => {
                      if (row.originalYear) onSetManualTreasuryRate(Number(row.originalYear), null);
                      setRateRows((rows) => rows.filter((_, ri) => ri !== i));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <button type="button" className="tr-refresh-btn" onClick={() => setRateRows((rows) => [...rows, { originalYear: null, year: "", rate: "" }])}>
        + Add year
      </button>
    </div>
  );
}
