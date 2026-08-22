"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData, ManualPayrollPeriod } from "@/lib/vault-types";
import { findPayrollVoucher, parsePeriodRange, findUncoveredSalaryVouchers, estimateManualPeriod } from "@/lib/payroll-match";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  transactions: Tx[];
  equity: EquityData | undefined;
  onSave: (payroll: PayrollData) => Promise<void>;
  onViewVoucher: (tx: Tx) => void; // only used for the explicit "Edit in Daybook" action inside the voucher popup
  fmt: (n: number) => string;
  readOnly?: boolean;
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

// Total for a row = every real pay-period value + the sheet's separate "Stocks" vesting-tax-
// event columns for that row (confirmed with the user: that money is real and should count).
function sumRow(r: PayrollRow | undefined): number {
  return (r?.values.reduce((s, v) => s + v, 0) ?? 0) + (r?.stockTotal ?? 0);
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 10, maxWidth: wide ? 760 : 480, width: "100%", maxHeight: "85vh", overflow: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.9rem 1.1rem", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, background: "#fff" }}>
          <strong>{title}</strong>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", lineHeight: 1, color: "#64748b" }}>✕</button>
        </div>
        <div style={{ padding: "1rem 1.1rem" }}>{children}</div>
      </div>
    </div>
  );
}

const linkBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" };

const MANUAL_FIELDS: { key: keyof typeof BLANK_MANUAL_FORM; label: string }[] = [
  { key: "base", label: "Base" },
  { key: "telephone", label: "Telephone" },
  { key: "medical", label: "Medical" },
  { key: "k401", label: "401K" },
  { key: "federal", label: "Federal" },
  { key: "ssn", label: "SSN" },
  { key: "medicare", label: "Medicare" },
  { key: "stateWH", label: "State W/H" },
  { key: "stateSDI", label: "State SDI" },
  { key: "net", label: "Net (bank deposit)" },
];

const BLANK_MANUAL_FORM = {
  base: "", telephone: "", medical: "", k401: "",
  federal: "", ssn: "", medicare: "", stateWH: "", stateSDI: "", net: "",
};

export function TaxReport({ payroll, transactions, equity, onSave, onViewVoucher, fmt, readOnly }: TaxReportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));
  const [showRsuModal, setShowRsuModal] = useState(false);
  const [voucherModalTx, setVoucherModalTx] = useState<Tx | null>(null);
  const [editingManualId, setEditingManualId] = useState<string | null>(null);
  const [manualForm, setManualForm] = useState(BLANK_MANUAL_FORM);
  const [savingManual, setSavingManual] = useState(false);
  const attemptedGuidsRef = useRef<Set<string>>(new Set());

  const activeYearLabel = selectedYear ?? payroll?.years[0]?.year ?? null;

  // Once a salary voucher is posted for a period the Excel doesn't cover, auto-create a
  // (marked "estimated") Tax tab line for it right away — no need to wait for a re-import.
  useEffect(() => {
    if (!payroll || readOnly) return;
    const yr = payroll.years.find((y) => y.year === activeYearLabel);
    if (!yr) return;
    const uncovered = findUncoveredSalaryVouchers(transactions, yr).filter((t) => !attemptedGuidsRef.current.has(t.guid));
    if (uncovered.length === 0) return;
    uncovered.forEach((t) => attemptedGuidsRef.current.add(t.guid));
    const newManual = uncovered.map((t) => estimateManualPeriod(yr, t));
    const updatedYears = payroll.years.map((y) =>
      y.year !== yr.year ? y : { ...y, manualPeriods: [...(y.manualPeriods ?? []), ...newManual] }
    );
    onSave({ ...payroll, years: updatedYears });
  }, [payroll, transactions, activeYearLabel, readOnly, onSave]);

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

  if (!payroll || payroll.years.length === 0) {
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

  const years = payroll.years;
  const yr: PayrollYear = years.find((y) => y.year === activeYearLabel) ?? years[0];
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

  const manualPeriods = yr.manualPeriods ?? [];
  const manualGross = manualPeriods.reduce((s, m) => s + m.base + m.telephone, 0);
  const manualFederal = manualPeriods.reduce((s, m) => s + m.federal, 0);
  const manualSsn = manualPeriods.reduce((s, m) => s + m.ssn, 0);
  const manualMedicare = manualPeriods.reduce((s, m) => s + m.medicare, 0);
  const manualStateWH = manualPeriods.reduce((s, m) => s + m.stateWH, 0);
  const manualStateSDI = manualPeriods.reduce((s, m) => s + m.stateSDI, 0);
  const manualTax = manualPeriods.reduce((s, m) => s + m.totalTax, 0);
  const manualNet = manualPeriods.reduce((s, m) => s + m.net, 0);

  const totalGross = sumRow(gross) + manualGross;
  const totalFederal = sumRow(federal) + manualFederal;
  const totalSsn = sumRow(ssn) + manualSsn;
  const totalMedicare = sumRow(medicare) + manualMedicare;
  const totalStateWH = sumRow(stateWH) + manualStateWH;
  const totalStateSDI = sumRow(stateSDI) + manualStateSDI;
  const totalTaxAll = sumRow(totalTax) + manualTax;
  const totalNet = sumRow(netSalary) + manualNet;
  const totalAfterTax = sumRow(afterTax);
  const totalEffective = sumRow(effective);
  const effectiveRate = totalGross > 0 ? (totalTaxAll / totalGross) * 100 : 0;

  // RSU vest records come from Reports > Equity (authoritative for date/shares/price) —
  // the Excel's own Stock row doesn't break its cumulative total down per vest.
  const yearVests = (equity?.grants ?? [])
    .flatMap((g) => g.vests.filter((v) => v.vestDate.startsWith(yr.year)).map((v) => ({ grant: g, vest: v })))
    .sort((a, b) => a.vest.vestDate.localeCompare(b.vest.vestDate));
  const stockVestedValue = yearVests
    .filter(({ vest }) => !vest.pending)
    .reduce((s, { vest }) => s + vest.shares * vest.vestPrice, 0);
  const stockScheduledShares = yearVests.filter(({ vest }) => vest.pending).reduce((s, { vest }) => s + vest.shares, 0);
  const stockFederal = federal?.stockTotal ?? 0;
  const stockSsn = ssn?.stockTotal ?? 0;
  const stockMedicare = medicare?.stockTotal ?? 0;
  const stockStateWH = stateWH?.stockTotal ?? 0;
  const stockStateSDI = stateSDI?.stockTotal ?? 0;
  const stockTaxTotal = totalTax?.stockTotal ?? 0;

  const summaryCards: { label: string; value: number; sub: string; onClick?: () => void }[] = [
    { label: "Gross Salary", value: totalGross, sub: "Base + Bonus + Stock + other" },
    { label: "Total Tax", value: totalTaxAll, sub: `${effectiveRate.toFixed(1)}% effective rate` },
    { label: "Net Salary", value: totalNet, sub: "after deductions" },
    { label: "After Tax Salary", value: totalAfterTax, sub: "take-home" },
    { label: "Stock (RSU) Vested", value: stockVestedValue, sub: "click for vest details →", onClick: () => setShowRsuModal(true) },
    { label: "Effective Salary", value: totalEffective, sub: "incl. employer 401K + ESPP" },
  ];

  function openVoucherModal(tx: Tx) {
    setVoucherModalTx(tx);
  }

  async function saveManualEdit(m: ManualPayrollPeriod) {
    setSavingManual(true);
    try {
      const federalV = Number(manualForm.federal) || 0;
      const ssnV = Number(manualForm.ssn) || 0;
      const medicareV = Number(manualForm.medicare) || 0;
      const stateWHV = Number(manualForm.stateWH) || 0;
      const stateSDIV = Number(manualForm.stateSDI) || 0;
      const updated: ManualPayrollPeriod = {
        ...m,
        base: Number(manualForm.base) || 0,
        telephone: Number(manualForm.telephone) || 0,
        medical: Number(manualForm.medical) || 0,
        k401: Number(manualForm.k401) || 0,
        federal: federalV,
        ssn: ssnV,
        medicare: medicareV,
        stateWH: stateWHV,
        stateSDI: stateSDIV,
        totalTax: federalV + ssnV + medicareV + stateWHV + stateSDIV,
        net: Number(manualForm.net) || 0,
        estimated: false,
      };
      const updatedYears = payroll!.years.map((y) =>
        y.year !== yr.year ? y : { ...y, manualPeriods: (y.manualPeriods ?? []).map((x) => (x.id === m.id ? updated : x)) }
      );
      await onSave({ ...payroll!, years: updatedYears });
      setEditingManualId(null);
    } finally {
      setSavingManual(false);
    }
  }

  function startManualEdit(m: ManualPayrollPeriod) {
    setManualForm({
      base: String(m.base), telephone: String(m.telephone), medical: String(m.medical), k401: String(m.k401),
      federal: String(m.federal), ssn: String(m.ssn), medicare: String(m.medicare),
      stateWH: String(m.stateWH), stateSDI: String(m.stateSDI), net: String(m.net),
    });
    setEditingManualId(m.id);
  }

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
              <div
                className="equity-summary-card"
                style={c.onClick ? { cursor: "pointer" } : undefined}
                onClick={c.onClick}
              >
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
                      <button className="tax-voucher-link" onClick={(e) => { e.stopPropagation(); openVoucherModal(linkedTx); }} title={linkedTx.narration || ""} style={linkBtnStyle}>
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
          {manualPeriods.map((m) => {
            const key = `manual-${m.id}`;
            const expanded = expandedKey === key;
            const tx = transactions.find((t) => t.guid === m.txGuid);
            const editing = editingManualId === m.id;
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: "pointer", background: "#fffbeb" }}>
                  <td title="Posted in the vault but not yet in the imported Excel file">
                    {m.label} <em style={{ fontSize: 10, opacity: 0.6 }}>{m.estimated ? "(from voucher, estimated)" : "(from voucher, edited)"}</em>
                  </td>
                  <td className="right equity-amt">{fmt(m.base + m.telephone)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.federal)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.ssn)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.medicare)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.stateWH)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.stateSDI)}</td>
                  <td className="right equity-amt">{fmt(m.totalTax)}</td>
                  <td className="right equity-amt">{fmt(m.net)}</td>
                  <td>
                    {tx ? (
                      <button className="tax-voucher-link" onClick={(e) => { e.stopPropagation(); openVoucherModal(tx); }} title={tx.narration || ""} style={linkBtnStyle}>
                        🔗 {tx.type} #{tx.number || "—"} · {new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </button>
                    ) : (
                      <span style={{ opacity: 0.4 }}>Voucher removed</span>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={10} style={{ background: "var(--panel-2, #f6f7f9)" }}>
                      {!editing ? (
                        <div style={{ padding: "0.5rem 0.25rem" }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 2rem", marginBottom: "0.75rem" }}>
                            {[
                              ["Base", m.base], ["Telephone", m.telephone], ["Medical", m.medical], ["401K", m.k401],
                              ["Federal", m.federal], ["SSN", m.ssn], ["Medicare", m.medicare],
                              ["State W/H", m.stateWH], ["State SDI", m.stateSDI], ["Net", m.net],
                            ].map(([lbl, val]) => (
                              <div key={lbl as string} style={{ minWidth: 130 }}>
                                <div style={{ fontSize: 11, opacity: 0.7 }}>{lbl}</div>
                                <strong className="equity-amt">{fmt(val as number)}</strong>
                              </div>
                            ))}
                          </div>
                          {m.estimated ? (
                            <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 0.5rem" }}>
                              Federal/SSN/Medicare/State are estimated from your closest matching pay period — replace with your real paystub numbers once you have them.
                            </p>
                          ) : null}
                          {!readOnly && (
                            <button onClick={() => startManualEdit(m)}>✎ Edit with real paystub numbers</button>
                          )}
                        </div>
                      ) : (
                        <div style={{ padding: "0.5rem 0.25rem" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.6rem" }}>
                            {MANUAL_FIELDS.map((f) => (
                              <label key={f.key} style={{ fontSize: 12 }}>
                                {f.label}
                                <input
                                  type="number"
                                  step="0.01"
                                  className="tax-manual-input"
                                  value={manualForm[f.key]}
                                  onChange={(e) => setManualForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                                  style={{ width: "100%", display: "block", marginTop: 2 }}
                                />
                              </label>
                            ))}
                          </div>
                          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
                            <button onClick={() => saveManualEdit(m)} disabled={savingManual}>{savingManual ? "Saving…" : "Save"}</button>
                            <button onClick={() => setEditingManualId(null)} disabled={savingManual}>Cancel</button>
                          </div>
                        </div>
                      )}
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
            <th className="right">{fmt(totalFederal)}</th>
            <th className="right">{fmt(totalSsn)}</th>
            <th className="right">{fmt(totalMedicare)}</th>
            <th className="right">{fmt(totalStateWH)}</th>
            <th className="right">{fmt(totalStateSDI)}</th>
            <th className="right">{fmt(totalTaxAll)}</th>
            <th className="right">{fmt(totalNet)}</th>
            <th>
              {yr.periodLabels.filter((l) => l && findPayrollVoucher(transactions, yr.year, l)).length + manualPeriods.length}
              {" / "}
              {yr.periodLabels.filter((l) => l).length + manualPeriods.length} linked
            </th>
          </tr>
        </tfoot>
      </table>
      {manualPeriods.length > 0 && (
        <p className="equity-seed-note" style={{ marginTop: "-0.5rem" }}>
          {manualPeriods.length} pay period(s) auto-added from posted vouchers, highlighted above — expand a row to edit
          its Federal/SSN/Medicare/State figures once you have the real paystub.
        </p>
      )}

      {showRsuModal && (
        <Modal title={`RSU Vesting — ${yr.year}`} onClose={() => setShowRsuModal(false)} wide>
          <table className="equity-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Vest Date</th>
                <th>Grant</th>
                <th className="right">Shares</th>
                <th className="right">Vest $/sh</th>
                <th className="right">Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {yearVests.length === 0 && (
                <tr><td colSpan={6} style={{ opacity: 0.5 }}>No RSU vests recorded for {yr.year} in the Equity report.</td></tr>
              )}
              {yearVests.map(({ grant, vest }) => (
                <tr key={vest.id}>
                  <td>{new Date(vest.vestDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</td>
                  <td className="equity-neutral" style={{ fontSize: 11 }}>{grant.ticker} granted {grant.grantDate}</td>
                  <td className="right">{vest.shares.toLocaleString()}</td>
                  <td className="right">{vest.pending ? "—" : `$${vest.vestPrice.toFixed(2)}`}</td>
                  <td className="right equity-amt">{vest.pending ? "—" : fmt(vest.shares * vest.vestPrice)}</td>
                  <td>{vest.pending ? <span style={{ color: "#888" }}>Scheduled</span> : <span style={{ color: "#16a34a" }}>Vested</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stockScheduledShares > 0 && (
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0 0" }}>{stockScheduledShares.toLocaleString()} sh still scheduled to vest in {yr.year}.</p>
          )}
          {stockTaxTotal > 0 && (
            <>
              <strong style={{ fontSize: 13, display: "block", marginTop: "1rem" }}>Additional tax withheld on vesting events (from payroll Excel)</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 2rem", marginTop: "0.5rem" }}>
                {[
                  ["Federal", stockFederal], ["SSN", stockSsn], ["Medicare", stockMedicare],
                  ["State W/H", stockStateWH], ["State SDI", stockStateSDI], ["Total", stockTaxTotal],
                ].map(([lbl, val]) => (
                  <div key={lbl as string}>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{lbl}</div>
                    <strong className="equity-amt">{fmt(val as number)}</strong>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowRsuModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {voucherModalTx && (
        <Modal title={`${voucherModalTx.type} #${voucherModalTx.number || "—"}`} onClose={() => setVoucherModalTx(null)}>
          <p style={{ margin: "0 0 0.75rem", fontSize: 13, opacity: 0.75 }}>
            {new Date(voucherModalTx.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
          </p>
          {voucherModalTx.narration && <p style={{ margin: "0 0 0.75rem", fontSize: 13 }}>{voucherModalTx.narration}</p>}
          <table className="equity-table" style={{ width: "100%" }}>
            <thead><tr><th>Account</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {voucherModalTx.entries.map((e, i) => (
                <tr key={i}><td>{e.accountName}</td><td className="right equity-amt">{fmt(Math.abs(e.amount))}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setVoucherModalTx(null)}>Close</button>
            {!readOnly && (
              <button onClick={() => { const tx = voucherModalTx; setVoucherModalTx(null); onViewVoucher(tx); }}>Edit in Daybook →</button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
