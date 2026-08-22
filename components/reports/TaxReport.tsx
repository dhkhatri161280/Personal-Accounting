"use client";
import { Fragment, useMemo, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear } from "@/lib/vault-types";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  onSave: (payroll: PayrollData) => Promise<void>;
  fmt: (n: number) => string;
  readOnly?: boolean;
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

export function TaxReport({ payroll, onSave, fmt, readOnly }: TaxReportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [expandedPeriod, setExpandedPeriod] = useState<number | null>(null);

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
  const stock = row(rows, "Stock");
  const federal = row(rows, "Federal");
  const ssn = row(rows, "SSN");
  const medicare = row(rows, "Medicare");
  const stateWH = row(rows, "State W/H");
  const stateSDI = row(rows, "State SDI");
  const totalTax = row(rows, "Total Tax");
  const netSalary = row(rows, "Net Salary", 1) ?? row(rows, "Net Salary", 0);
  const afterTax = row(rows, "After Tax Salary");
  const effective = row(rows, "Effective Salary");

  const effectiveRate = gross && gross.annual > 0 && totalTax ? (totalTax.annual / gross.annual) * 100 : 0;

  const summaryCards: { label: string; value: number; sub: string }[] = [
    { label: "Gross Salary", value: gross?.annual ?? 0, sub: "Base + Bonus + Stock + other" },
    { label: "Total Tax", value: totalTax?.annual ?? 0, sub: `${effectiveRate.toFixed(1)}% effective rate` },
    { label: "Net Salary", value: netSalary?.annual ?? 0, sub: "after deductions" },
    { label: "After Tax Salary", value: afterTax?.annual ?? 0, sub: "take-home" },
    { label: "Stock (RSU)", value: stock?.annual ?? 0, sub: "included in gross + taxed" },
    { label: "Effective Salary", value: effective?.annual ?? 0, sub: "incl. employer 401K + ESPP" },
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
              onClick={() => { setSelectedYear(y.year); setExpandedPeriod(null); }}
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
            <th className="right">Bank Deposit</th>
          </tr>
        </thead>
        <tbody>
          {yr.periodLabels.map((label, i) => {
            const g = at(gross, i);
            const t = at(totalTax, i);
            if (!g && !t && !at(federal, i)) return null; // skip empty future periods
            const expanded = expandedPeriod === i;
            const match = yr.matches?.find((m) => m.periodIndex === i);
            const expectedNet = at(netSalary, i);
            const variance = match ? match.depositAmount - expectedNet : 0;
            const varianceFlag = match && Math.abs(variance) > 1;
            return (
              <Fragment key={i}>
                <tr onClick={() => setExpandedPeriod(expanded ? null : i)} style={{ cursor: "pointer" }}>
                  <td>{label || `Period ${i + 1}`}</td>
                  <td className="right">{fmt(g)}</td>
                  <td className="right">{fmt(at(federal, i))}</td>
                  <td className="right">{fmt(at(ssn, i))}</td>
                  <td className="right">{fmt(at(medicare, i))}</td>
                  <td className="right">{fmt(at(stateWH, i))}</td>
                  <td className="right">{fmt(at(stateSDI, i))}</td>
                  <td className="right">{fmt(t)}</td>
                  <td className="right">{fmt(at(netSalary, i))}</td>
                  <td className="right">
                    {match ? (
                      <span
                        title={`Confirmed via Plaid on ${new Date(match.confirmedAt).toLocaleDateString()}${varianceFlag ? ` — differs from expected net by ${fmt(variance)}` : ""}`}
                        style={{ color: varianceFlag ? "#dc2626" : "#16a34a" }}
                      >
                        ✓ {fmt(match.depositAmount)}
                      </span>
                    ) : (
                      <span style={{ opacity: 0.4 }}>Pending</span>
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
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th className="right">{fmt(gross?.annual ?? 0)}</th>
            <th className="right">{fmt(federal?.annual ?? 0)}</th>
            <th className="right">{fmt(ssn?.annual ?? 0)}</th>
            <th className="right">{fmt(medicare?.annual ?? 0)}</th>
            <th className="right">{fmt(stateWH?.annual ?? 0)}</th>
            <th className="right">{fmt(stateSDI?.annual ?? 0)}</th>
            <th className="right">{fmt(totalTax?.annual ?? 0)}</th>
            <th className="right">{fmt(netSalary?.annual ?? 0)}</th>
            <th className="right">{fmt((yr.matches ?? []).reduce((s, m) => s + m.depositAmount, 0))}</th>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
