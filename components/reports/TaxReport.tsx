"use client";
import { Fragment, useMemo, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData } from "@/lib/vault-types";
import { findPayrollVoucher, parsePeriodRange, findUncoveredSalaryVouchers, buildShadowPeriod, type ShadowPeriod } from "@/lib/payroll-match";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  transactions: Tx[];
  equity: EquityData | undefined;
  onSave: (payroll: PayrollData) => Promise<void>;
  onViewVoucher: (tx: Tx) => void;
  onViewGrant: (grantId: string) => void;
  fmt: (n: number) => string;
  readOnly?: boolean;
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

// Some rows (Effective Salary, 401K Emplr, Total Inv) never got a full-year figure typed
// into the Excel's "Salary" column — only CUMULATIVE (YTD actual) is populated for them.
// Prefer annual when it's real; otherwise fall back to YTD rather than showing a bare $0.
function annualOrYtd(r: PayrollRow | undefined): { value: number; ytd: boolean } {
  if (!r) return { value: 0, ytd: false };
  if (r.annual > 0) return { value: r.annual, ytd: false };
  return { value: r.cumulative, ytd: r.cumulative > 0 };
}

export function TaxReport({ payroll, transactions, equity, onSave, onViewVoucher, onViewGrant, fmt, readOnly }: TaxReportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));

  const years = payroll?.years ?? [];
  const activeYear: PayrollYear | undefined = useMemo(
    () => years.find((y) => y.year === selectedYear) ?? years[0],
    [years, selectedYear]
  );

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportError("");
    setImporting(true);
    try {
      const { parsePayrollXlsx } = await import("@/lib/parse-payroll-xlsx");
      const parsed = await parsePayrollXlsx(file);
      if (parsed.years.length === 0) {
        setImportError('No "Yearly <year>" sheets found in this file.');
        return;
      }
      await onSave(parsed);
      setSelectedYear(parsed.years[0].year);
    } catch (err: any) {
      setImportError("Failed to parse Excel file: " + (err?.message ?? "Unknown error"));
    } finally {
      setImporting(false);
    }
  }

  if (!payroll || years.length === 0) {
    return (
      <div className="data-panel tax-report">
        <div className="equity-seed-banner">
          <p className="equity-empty">No paystub/tax data imported yet.</p>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleUpload} />
          <button className="equity-seed-btn" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            {importing ? "Importing…" : "📄 Import Paystub Excel (Total Salary Details.xlsx)"}
          </button>
          <p className="equity-seed-note">
            Reads each &quot;Yearly &lt;year&gt;&quot; sheet — Base, Bonus, Stock (RSU), Federal, SSN, Medicare,
            State W/H, State SDI, and Net/After-Tax Salary — broken down per pay period.
          </p>
          {importError && <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{importError}</p>}
        </div>
      </div>
    );
  }

  const yr = activeYear!;
  const rows = yr.rows;
  const gross = row(rows, "Gross Salary");
  const federal = row(rows, "Federal");
  const ssn = row(rows, "SSN");
  const medicare = row(rows, "Medicare");
  const stateWH = row(rows, "State W/H");
  const stateSDI = row(rows, "State SDI");
  const totalTax = row(rows, "Total Tax");
  const netSalary = row(rows, "Net Salary", 1) ?? row(rows, "Net Salary", 0);
  const afterTax = row(rows, "After Tax Salary");
  const effective = row(rows, "Effective Salary");

  // Vault salary vouchers posted for a pay period beyond what the last Excel import covers —
  // shown alongside the imported periods so the tab stays current between Excel re-imports.
  // Only the lump Total Tax is known here (vouchers don't itemize Federal/SSN/Medicare/State);
  // the detailed columns show "—" for these rather than a fabricated $0.
  const shadowPeriods: ShadowPeriod[] = findUncoveredSalaryVouchers(transactions, yr)
    .map(buildShadowPeriod)
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date));
  const shadowGross = shadowPeriods.reduce((s, p) => s + p.base + p.telephone, 0);
  const shadowTax = shadowPeriods.reduce((s, p) => s + p.tax, 0);
  const shadowNet = shadowPeriods.reduce((s, p) => s + p.net, 0);

  const totalGross = (gross?.annual ?? 0) + shadowGross;
  const totalTaxAll = (totalTax?.annual ?? 0) + shadowTax;
  const effectiveRate = totalGross > 0 ? (totalTaxAll / totalGross) * 100 : 0;

  // The Excel's per-row "Salary" (annual) column is blank/0 for Stock — it only tracks a
  // CUMULATIVE total there, not a real annual figure, and doesn't break it out per vest date.
  // The Equity report's vest records are the authoritative source for RSU activity, so use
  // those (already reconciled against grants) instead of the Excel's Stock row.
  const yearVests = (equity?.grants ?? [])
    .flatMap((g) => g.vests.filter((v) => v.vestDate.startsWith(yr.year)).map((v) => ({ grant: g, vest: v })))
    .sort((a, b) => a.vest.vestDate.localeCompare(b.vest.vestDate));
  const stockVestedValue = yearVests
    .filter(({ vest }) => !vest.pending)
    .reduce((s, { vest }) => s + vest.shares * vest.vestPrice, 0);
  // Pending vests carry vestPrice 0 (unknown until the vest actually happens), so a share
  // count is the only honest "what's pending" figure — a $ total would just read as $0.
  const stockScheduledShares = yearVests.filter(({ vest }) => vest.pending).reduce((s, { vest }) => s + vest.shares, 0);

  const effectiveSalary = annualOrYtd(effective);

  const summaryCards: { label: string; value: number; sub: string }[] = [
    { label: "Gross Salary", value: totalGross, sub: "Base + Bonus + Stock + other" },
    { label: "Total Tax", value: totalTaxAll, sub: `${effectiveRate.toFixed(1)}% effective rate` },
    { label: "Net Salary", value: (netSalary?.annual ?? 0) + shadowNet, sub: "after deductions" },
    { label: "After Tax Salary", value: afterTax?.annual ?? 0, sub: "take-home" },
    { label: "Stock (RSU) Vested", value: stockVestedValue, sub: "from Equity report vest records" },
    {
      label: "Effective Salary",
      value: effectiveSalary.value,
      sub: effectiveSalary.ytd ? "YTD actual — Excel has no full-year figure for this row" : "incl. employer 401K + ESPP",
    },
  ];

  return (
    <div className="data-panel tax-report">
      <div className="equity-header">
        <div className="equity-title-row">
          <h3>Tax &amp; Paystub Details</h3>
          <div className="equity-price-row">
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleUpload} />
            {!readOnly && (
              <button className="equity-refresh" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                {importing ? "Importing…" : "↻ Re-import from Excel"}
              </button>
            )}
          </div>
        </div>
        {importError && <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{importError}</p>}
        <p className="equity-seed-note">
          Imported {new Date(payroll.importedAt).toLocaleDateString()} from {payroll.sourceFileName}
        </p>

        <div className="equity-grant-filter">
          <span className="equity-grant-filter-label">Year:</span>
          {years.map((y) => (
            <button
              key={y.year}
              className={`equity-grant-filter-chip${yr.year === y.year ? " equity-grant-filter-chip--active" : ""}`}
              onClick={() => { setSelectedYear(y.year); setExpandedKey(null); }}
            >
              {y.year}
            </button>
          ))}
        </div>

        <div className="equity-summary-row">
          {summaryCards.map((c) => (
            <div key={c.label} className="equity-summary-col">
              <div className="equity-summary-card">
                <span>{c.label}</span>
                <strong className="equity-amt">{fmt(c.value)}</strong>
                <em>{c.sub}</em>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="equity-section-head">
        <h4>Pay Periods — {yr.year}</h4>
      </div>

      <table className="equity-table equity-drilldown-table">
        <thead>
          <tr>
            <th>Period</th>
            <th className="right">Gross</th>
            <th className="right">Federal</th>
            <th className="right">SSN</th>
            <th className="right">Medicare</th>
            <th className="right">State W/H</th>
            <th className="right">State SDI</th>
            <th className="right">Total Tax</th>
            <th className="right">Net</th>
            <th>Voucher</th>
          </tr>
        </thead>
        <tbody>
          {yr.periodLabels.map((label, i) => {
            const g = at(gross, i);
            const t = at(totalTax, i);
            if (!g && !t && !at(federal, i)) return null; // skip empty future periods
            const key = `excel-${i}`;
            const expanded = expandedKey === key;
            const linkedTx = label ? findPayrollVoucher(transactions, yr.year, label) : undefined;
            const match = yr.matches?.find((m) => m.periodIndex === i);
            const expectedNet = at(netSalary, i);
            const variance = match ? match.depositAmount - expectedNet : 0;
            const varianceFlag = match && Math.abs(variance) > 1;
            const range = label ? parsePeriodRange(label, yr.year) : null;
            const isPast = range ? range.end < todayIso : false;
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: "pointer" }}>
                  <td>{label || `Period ${i + 1}`}</td>
                  <td className="right">{fmt(g)}</td>
                  <td className="right">{fmt(at(federal, i))}</td>
                  <td className="right">{fmt(at(ssn, i))}</td>
                  <td className="right">{fmt(at(medicare, i))}</td>
                  <td className="right">{fmt(at(stateWH, i))}</td>
                  <td className="right">{fmt(at(stateSDI, i))}</td>
                  <td className="right">{fmt(t)}</td>
                  <td className="right">{fmt(at(netSalary, i))}</td>
                  <td>
                    {linkedTx ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); onViewVoucher(linkedTx); }}
                        title={linkedTx.narration || ""}
                        style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}
                      >
                        🔗 {linkedTx.type} #{linkedTx.number || "—"} · {new Date(linkedTx.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </button>
                    ) : match ? (
                      <span
                        className="equity-amt"
                        title={`Confirmed via Plaid on ${new Date(match.confirmedAt).toLocaleDateString()}${varianceFlag ? ` — differs from expected net by ${fmt(variance)}` : ""}`}
                        style={{ color: varianceFlag ? "#dc2626" : "#16a34a" }}
                      >
                        ✓ {fmt(match.depositAmount)} (no voucher link)
                      </span>
                    ) : (
                      <span style={{ opacity: 0.4 }}>{isPast ? "Not posted" : "—"}</span>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={10} style={{ background: "var(--panel-2, #f6f7f9)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 2rem", padding: "0.5rem 0.25rem" }}>
                        {rows.map((r, ri) => (
                          <div key={ri} style={{ minWidth: 140 }}>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>{r.label}</div>
                            <strong className="equity-amt">{fmt(r.values[i] ?? 0)}</strong>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {shadowPeriods.map((s, i) => {
            const key = `shadow-${i}`;
            const expanded = expandedKey === key;
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: "pointer", background: "#fffbeb" }}>
                  <td title="Posted in the vault but not yet in the imported Excel file">{s.label} <em style={{ fontSize: 10, opacity: 0.6 }}>(from voucher)</em></td>
                  <td className="right equity-amt">{fmt(s.base + s.telephone)}</td>
                  <td className="right" style={{ opacity: 0.4 }}>—</td>
                  <td className="right" style={{ opacity: 0.4 }}>—</td>
                  <td className="right" style={{ opacity: 0.4 }}>—</td>
                  <td className="right" style={{ opacity: 0.4 }}>—</td>
                  <td className="right" style={{ opacity: 0.4 }}>—</td>
                  <td className="right equity-amt" title="Lump total — voucher doesn't itemize Federal/SSN/Medicare/State">{fmt(s.tax)}</td>
                  <td className="right equity-amt">{fmt(s.net)}</td>
                  <td>
                    <button
                      className="tax-voucher-link"
                      onClick={(e) => { e.stopPropagation(); onViewVoucher(s.tx); }}
                      title={s.tx.narration || ""}
                      style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}
                    >
                      🔗 {s.tx.type} #{s.tx.number || "—"} · {new Date(s.tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={10} style={{ background: "var(--panel-2, #f6f7f9)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 2rem", padding: "0.5rem 0.25rem" }}>
                        {[
                          ["Base", s.base], ["Telephone", s.telephone], ["Medical", s.medical],
                          ["401K", s.k401], ["Tax (lump)", s.tax], ["Net", s.net],
                        ].map(([lbl, val]) => (
                          <div key={lbl as string} style={{ minWidth: 140 }}>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>{lbl}</div>
                            <strong className="equity-amt">{fmt(val as number)}</strong>
                          </div>
                        ))}
                        <p style={{ width: "100%", fontSize: 11, opacity: 0.6, margin: 0 }}>
                          Not yet in the imported Excel — re-import an updated Total Salary Details.xlsx for the full Federal/SSN/Medicare/State breakdown.
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th className="right">{fmt(totalGross)}</th>
            <th className="right">{fmt(federal?.annual ?? 0)}</th>
            <th className="right">{fmt(ssn?.annual ?? 0)}</th>
            <th className="right">{fmt(medicare?.annual ?? 0)}</th>
            <th className="right">{fmt(stateWH?.annual ?? 0)}</th>
            <th className="right">{fmt(stateSDI?.annual ?? 0)}</th>
            <th className="right">{fmt(totalTaxAll)}</th>
            <th className="right">{fmt((netSalary?.annual ?? 0) + shadowNet)}</th>
            <th>
              {yr.periodLabels.filter((l) => l && findPayrollVoucher(transactions, yr.year, l)).length + shadowPeriods.length}
              {" / "}
              {yr.periodLabels.filter((l) => l).length + shadowPeriods.length} linked
            </th>
          </tr>
        </tfoot>
      </table>
      {shadowPeriods.length > 0 && (
        <p className="equity-seed-note" style={{ marginTop: "-0.5rem" }}>
          {shadowPeriods.length} pay period(s) found in your books beyond the last Excel import (highlighted above) —
          only Base/Telephone/lump Tax/Net are known from the voucher. Re-import Total Salary Details.xlsx once it's
          updated to get the full Federal/SSN/Medicare/State breakdown for these.
        </p>
      )}

      <div className="equity-section-head">
        <h4>RSU Vesting — {yr.year}</h4>
      </div>
      <p className="equity-seed-note" style={{ marginTop: "-0.25rem" }}>
        Full dollar detail (award value, gain, tax withheld, sale price) lives in Reports → Equity — click a row to jump straight to that grant.
        {stockScheduledShares > 0 && ` ${stockScheduledShares.toLocaleString()} sh still scheduled to vest in ${yr.year}.`}
      </p>
      <table className="equity-table equity-drilldown-table">
        <thead>
          <tr>
            <th>Vest Date</th>
            <th>Grant</th>
            <th className="right">Shares</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {yearVests.length === 0 && (
            <tr>
              <td colSpan={4} style={{ opacity: 0.5 }}>No RSU vests recorded for {yr.year} in the Equity report.</td>
            </tr>
          )}
          {yearVests.map(({ grant, vest }) => (
            <tr
              key={vest.id}
              onClick={() => onViewGrant(grant.id)}
              style={{ cursor: "pointer" }}
              title="View this grant in Reports → Equity"
            >
              <td>{new Date(vest.vestDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</td>
              <td>
                <button
                  className="tax-voucher-link"
                  onClick={(e) => { e.stopPropagation(); onViewGrant(grant.id); }}
                  style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" }}
                >
                  🔗 {grant.ticker} granted {grant.grantDate}
                </button>
              </td>
              <td className="right">{vest.shares.toLocaleString()}</td>
              <td>
                {vest.pending
                  ? <span style={{ color: "#888" }}>Scheduled</span>
                  : <span style={{ color: "#16a34a" }}>Vested</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
