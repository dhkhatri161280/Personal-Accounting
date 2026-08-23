"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData, ManualPayrollPeriod, RsuGrant, RsuVest, EsppPurchase, Account } from "@/lib/vault-types";
import { findPayrollVoucher, parsePeriodRange, findUncoveredSalaryVouchers, estimateManualPeriod, generateStandardPeriodLabels, normalizePayrollYear } from "@/lib/payroll-match";
import { StatIcon, type IconKind } from "@/components/Icon";
import { classifyRsuSales, classifyEsppSales, summarizeCapitalGains } from "@/lib/tax-classify";
import { estimateUsFederalTax, computeItemizedDeduction, computeHsaDeduction, type HsaCoverage } from "@/lib/tax-usa-engine";
import { listUsTaxYears, type UsFilingStatus } from "@/lib/tax-usa-rules";
import { matchDeductionLedgers, deductionTotal, findHsaContributions } from "@/lib/tax-deductions";
import { estimateCaStateTax, computeCaItemizedDeduction } from "@/lib/tax-ca-engine";
import { fmtDate } from "@/lib/format-date";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  transactions: Tx[];
  equity: EquityData | undefined;
  accounts: Account[];
  onSave: (payroll: PayrollData) => Promise<void>;
  onViewVoucher: (tx: Tx) => void; // only used for the explicit "Edit in Daybook" action inside the voucher popup
  fmt: (n: number) => string;
  readOnly?: boolean;
  uiTheme?: "classic" | "refresh";
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

// Display-only: "Jan 01 Jan 15" -> "Jan 15" to save space in the Pay Periods table. The full
// label is still what's stored/matched against everywhere else -- only this rendering uses
// the shortened form. Falls back to the raw label if it isn't a parseable period range.
function periodEndLabel(label: string, year: string): string {
  const range = parsePeriodRange(label, year);
  if (!range) return label;
  const d = new Date(range.end + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Total for a row = every real pay-period value + the sheet's separate "Stocks" vesting-tax-
// event columns for that row (confirmed with the user: that money is real and should count).
function sumRow(r: PayrollRow | undefined): number {
  return (r?.values.reduce((s, v) => s + v, 0) ?? 0) + (r?.stockValues?.reduce((s, v) => s + v, 0) ?? 0);
}

function stockVal(r: PayrollRow | undefined, idx: number): number | null {
  const v = r?.stockValues?.[idx];
  return v === undefined ? null : v;
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

function VestTable({ items, fmt }: { items: { grant: RsuGrant; vest: RsuVest }[]; fmt: (n: number) => string }) {
  return (
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
        {items.length === 0 && (
          <tr><td colSpan={6} style={{ opacity: 0.5 }}>No RSU vests recorded.</td></tr>
        )}
        {items.map(({ grant, vest }) => (
          <tr key={vest.id}>
            <td>{new Date(vest.vestDate + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</td>
            <td className="equity-neutral" style={{ fontSize: 11 }}>{grant.ticker} granted {fmtDate(grant.grantDate)}</td>
            <td className="right">{vest.shares.toLocaleString()}</td>
            <td className="right">{vest.pending ? "—" : `$${vest.vestPrice.toFixed(2)}`}</td>
            <td className="right equity-amt">{vest.pending ? "—" : fmt(vest.shares * vest.vestPrice)}</td>
            <td>{vest.pending ? <span style={{ color: "#888" }}>Scheduled</span> : <span style={{ color: "#16a34a" }}>Vested</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EsppTable({ items, fmt }: { items: EsppPurchase[]; fmt: (n: number) => string }) {
  return (
    <table className="equity-table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Purchase Date</th>
          <th className="right">Shares</th>
          <th className="right">Offering $/sh</th>
          <th className="right">Purchase $/sh</th>
          <th className="right">Market $/sh</th>
          <th className="right">Discount Value</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 && (
          <tr><td colSpan={6} style={{ opacity: 0.5 }}>No ESPP purchases recorded.</td></tr>
        )}
        {items.map((e) => (
          <tr key={e.id}>
            <td>{new Date(e.purchaseDate + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</td>
            <td className="right">{e.shares.toLocaleString()}</td>
            <td className="right">${e.offeringPrice.toFixed(2)}</td>
            <td className="right">${e.purchasePrice.toFixed(2)}</td>
            <td className="right">${e.marketPriceAtPurchase.toFixed(2)}</td>
            <td className="right equity-amt">{fmt((e.marketPriceAtPurchase - e.purchasePrice) * e.shares)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditFieldsForm({
  form, onChange, onSave, onCancel, saving,
}: {
  form: typeof BLANK_MANUAL_FORM;
  onChange: (next: typeof BLANK_MANUAL_FORM) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div style={{ padding: "0.5rem 0.25rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.6rem" }}>
        {MANUAL_FIELDS.map((f) => (
          <label key={f.key} style={{ fontSize: 12 }}>
            {f.label}
            <input
              type="number"
              step="0.01"
              className="tax-manual-input"
              value={form[f.key]}
              onChange={(e) => onChange({ ...form, [f.key]: e.target.value })}
              style={{ width: "100%", display: "block", marginTop: 2 }}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <button onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

const MANUAL_FIELDS: { key: keyof typeof BLANK_MANUAL_FORM; label: string }[] = [
  { key: "base", label: "Base" },
  { key: "telephone", label: "Telephone" },
  { key: "medical", label: "Medical" },
  { key: "k401", label: "401K (employee)" },
  { key: "k401Emplr", label: "401K Employer Match" },
  { key: "espp", label: "ESPP Deduction" },
  { key: "federal", label: "Federal" },
  { key: "ssn", label: "SSN" },
  { key: "medicare", label: "Medicare" },
  { key: "stateWH", label: "State W/H" },
  { key: "stateSDI", label: "State SDI" },
  { key: "net", label: "Net (bank deposit)" },
];

const BLANK_MANUAL_FORM = {
  base: "", telephone: "", medical: "", k401: "", k401Emplr: "", espp: "",
  federal: "", ssn: "", medicare: "", stateWH: "", stateSDI: "", net: "",
};

export function TaxReport({ payroll, transactions, equity, accounts, onSave, onViewVoucher, fmt, readOnly, uiTheme }: TaxReportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));
  const [showRsuModal, setShowRsuModal] = useState(false);
  const [periodVestModal, setPeriodVestModal] = useState<{ label: string; items: { grant: RsuGrant; vest: RsuVest }[] } | null>(null);
  const [showEsppModal, setShowEsppModal] = useState(false);
  const [periodEsppModal, setPeriodEsppModal] = useState<{ label: string; items: EsppPurchase[] } | null>(null);
  const [voucherModalTx, setVoucherModalTx] = useState<Tx | null>(null);
  const [editingTarget, setEditingTarget] = useState<{ id: string | null; periodIndex?: number; label: string } | null>(null);
  const [manualForm, setManualForm] = useState(BLANK_MANUAL_FORM);
  const [savingManual, setSavingManual] = useState(false);
  const [startingManualYear, setStartingManualYear] = useState(false);
  const [manualYearInput, setManualYearInput] = useState(() => String(new Date().getFullYear()));
  const [filingStatus, setFilingStatus] = useState<UsFilingStatus>("mfj");
  const [hsaCoverage, setHsaCoverage] = useState<HsaCoverage>("family");
  const [showGainEventsModal, setShowGainEventsModal] = useState(false);
  const [showDeductionsModal, setShowDeductionsModal] = useState(false);
  const [periodBreakdownModal, setPeriodBreakdownModal] = useState<{ label: string; row: PayrollRow | undefined } | null>(null);
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

  async function startWithoutExcel() {
    const year = manualYearInput.trim();
    if (!/^\d{4}$/.test(year)) return;
    const newYear: PayrollYear = {
      year,
      sheetName: "(manual entry)",
      periodLabels: generateStandardPeriodLabels(year),
      rows: [],
      manualPeriods: [],
    };
    const next: PayrollData = payroll
      ? { ...payroll, years: [...payroll.years.filter((y) => y.year !== year), newYear] }
      : { years: [newYear], importedAt: new Date().toISOString(), sourceFileName: "(manual entry — no Excel)" };
    await onSave(next);
    setSelectedYear(year);
    setStartingManualYear(false);
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

          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid #e2e8f0" }}>
            {!startingManualYear ? (
              <button onClick={() => setStartingManualYear(true)}>Or track manually — no Excel needed</button>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <label style={{ fontSize: 12 }}>
                  Year
                  <input
                    type="number"
                    value={manualYearInput}
                    onChange={(e) => setManualYearInput(e.target.value)}
                    style={{ display: "block", width: 90 }}
                  />
                </label>
                <button onClick={startWithoutExcel}>Start {manualYearInput}</button>
                <button onClick={() => setStartingManualYear(false)}>Cancel</button>
              </div>
            )}
            <p className="equity-seed-note" style={{ marginTop: "0.5rem" }}>
              Creates an empty year with standard semi-monthly periods. Every salary Receipt you post from then on
              (Plaid or manual) automatically adds a line here, with Federal/SSN/Medicare/State fields you can edit yourself.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const years = payroll.years;
  const yr: PayrollYear = normalizePayrollYear(years.find((y) => y.year === activeYearLabel) ?? years[0]);
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
  const k401 = row(rows, "401K");
  const k401Emplr = row(rows, "401K Emplr");
  const esppRow = row(rows, "ESPP");
  const baseRow = row(rows, "Base");
  const telRow = row(rows, "Telephone");
  const medicalRow = row(rows, "Medical");

  // 401(k) lifetime contribution history — one row per imported year, self + employer match.
  // Uses each year's cumulative total (not the annual column, which is blank for "401K Emplr"
  // in the source sheet) so this also works for a year still in progress.
  const k401ByYear = years
    .slice()
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((y) => ({
      year: y.year,
      self: row(y.rows, "401K")?.cumulative ?? 0,
      employer: row(y.rows, "401K Emplr")?.cumulative ?? 0,
    }))
    .filter((r) => r.self > 0.005 || r.employer > 0.005);
  const k401LifetimeSelf = k401ByYear.reduce((s, r) => s + r.self, 0);
  const k401LifetimeEmployer = k401ByYear.reduce((s, r) => s + r.employer, 0);

  const allManualPeriods = yr.manualPeriods ?? [];
  // Two kinds share the same ManualPayrollPeriod record: a voucher-derived period (new pay
  // period the Excel doesn't cover) vs. a correction overlaid on an Excel-imported period
  // (periodIndex set) — the latter must NOT be added on top of the Excel row it corrects,
  // or totals would double-count it.
  const voucherPeriods = allManualPeriods.filter((m) => m.periodIndex === undefined);
  const overrideByIndex = new Map(allManualPeriods.filter((m) => m.periodIndex !== undefined).map((m) => [m.periodIndex!, m]));

  const manualGross = voucherPeriods.reduce((s, m) => s + m.base + m.telephone, 0);
  const manualFederal = voucherPeriods.reduce((s, m) => s + m.federal, 0);
  const manualSsn = voucherPeriods.reduce((s, m) => s + m.ssn, 0);
  const manualMedicare = voucherPeriods.reduce((s, m) => s + m.medicare, 0);
  const manualStateWH = voucherPeriods.reduce((s, m) => s + m.stateWH, 0);
  const manualStateSDI = voucherPeriods.reduce((s, m) => s + m.stateSDI, 0);
  const manualTax = voucherPeriods.reduce((s, m) => s + m.totalTax, 0);
  const manualNet = voucherPeriods.reduce((s, m) => s + m.net, 0);
  const manualK401 = voucherPeriods.reduce((s, m) => s + m.k401, 0);
  const manualK401Emplr = voucherPeriods.reduce((s, m) => s + (m.k401Emplr ?? 0), 0);
  const manualEspp = voucherPeriods.reduce((s, m) => s + (m.espp ?? 0), 0);

  // Sum a row across every Excel period, substituting an override's value wherever one
  // exists for that period index, then add the (unaffected) Stocks-column total.
  function overriddenTotal(baseRowForField: PayrollRow | undefined, field: keyof ManualPayrollPeriod): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? (Number(ov[field]) || 0) : (baseRowForField?.values[i] ?? 0);
    }
    return sum + (baseRowForField?.stockValues?.reduce((s, v) => s + v, 0) ?? 0);
  }
  function overriddenGrossTotal(): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? ov.base + ov.telephone : (gross?.values[i] ?? 0);
    }
    return sum + (gross?.stockValues?.reduce((s, v) => s + v, 0) ?? 0);
  }

  const totalGross = overriddenGrossTotal() + manualGross;
  const totalFederal = overriddenTotal(federal, "federal") + manualFederal;
  const totalSsn = overriddenTotal(ssn, "ssn") + manualSsn;
  const totalMedicare = overriddenTotal(medicare, "medicare") + manualMedicare;
  const totalStateWH = overriddenTotal(stateWH, "stateWH") + manualStateWH;
  const totalStateSDI = overriddenTotal(stateSDI, "stateSDI") + manualStateSDI;
  const totalTaxAll = overriddenTotal(totalTax, "totalTax") + manualTax;
  const totalNet = overriddenTotal(netSalary, "net") + manualNet;
  const totalAfterTax = sumRow(afterTax);
  const totalEffective = sumRow(effective);
  const totalK401 = overriddenTotal(k401, "k401") + manualK401;
  const totalK401Emplr = overriddenTotal(k401Emplr, "k401Emplr") + manualK401Emplr;
  const totalEsppDeduction = overriddenTotal(esppRow, "espp") + manualEspp;
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
  const stockFederal = federal?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
  const stockSsn = ssn?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
  const stockMedicare = medicare?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
  const stockStateWH = stateWH?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
  const stockStateSDI = stateSDI?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
  const stockTaxTotal = totalTax?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;

  // Group vest events by date (multiple grants can vest the same day) and line them up in
  // chronological order with the Excel's "Stocks" columns — column N is the Nth vest date of
  // the year (quarterly: Mar/Jun/Sep/Dec), not a lump sum for the whole year.
  const vestGroups = Array.from(
    yearVests.reduce((map, item) => {
      const list = map.get(item.vest.vestDate) ?? [];
      list.push(item);
      map.set(item.vest.vestDate, list);
      return map;
    }, new Map<string, { grant: RsuGrant; vest: RsuVest }[]>())
  )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items], idx) => ({ date, items, stockIdx: idx }));

  // ESPP purchases come from Reports > Equity the same way RSU vests do.
  const yearEspp = (equity?.esppPurchases ?? [])
    .filter((e) => e.purchaseDate.startsWith(yr.year))
    .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  const esppDiscountValue = yearEspp.reduce((s, e) => s + (e.marketPriceAtPurchase - e.purchasePrice) * e.shares, 0);

  // Federal tax estimate — totalGross is GROSS pay (Base+Bonus+Stock+other), not W-2 Box 1
  // federal taxable wages: a traditional 401(k) employee contribution is pretax and reduces
  // Box 1, so it has to come out here or the estimate overtaxes that money. (Assumes a
  // traditional, not Roth, 401(k) -- Roth contributions are post-tax and wouldn't reduce
  // wages; this app doesn't distinguish the two.) ESPP deductions are always post-tax and
  // correctly aren't subtracted. RSU-vest/ESPP-discount ordinary income is already included
  // in totalGross via payroll; only realized capital gains from shares actually SOLD (an
  // explicit salePrice on the vest/purchase) are added on top, split short/long term.
  const taxableWages = Math.max(0, totalGross - totalK401);
  const taxEstimateYear = listUsTaxYears().includes(yr.year) ? yr.year : listUsTaxYears()[0]!;
  const gainEvents = [
    ...classifyRsuSales(equity?.grants ?? [], yr.year, 365),
    ...classifyEsppSales(equity?.esppPurchases ?? [], yr.year, 365),
  ];
  const gainTotals = summarizeCapitalGains(gainEvents);

  // Itemized deductions — matched from expense-ledger names (medical, mortgage interest,
  // property tax, state income tax paid, charitable). Shown in the UI so a miss is obvious
  // and fixable by renaming the ledger, rather than silently wrong.
  const deductionMatches = matchDeductionLedgers(accounts, transactions, yr.year);

  // Personal (non-payroll) HSA contributions — an above-the-line federal deduction (Form
  // 8889), capped at the IRS annual limit for the selected coverage tier. California doesn't
  // conform: it's added back for the CA AGI proxy below, not carried through.
  const hsaContributions = findHsaContributions(transactions, yr.year);
  const hsaContributionTotal = hsaContributions.reduce((s, h) => s + h.amount, 0);
  const hsaDeduction = computeHsaDeduction(taxEstimateYear, hsaCoverage, hsaContributionTotal);

  const preliminaryAgi = Math.max(
    0,
    taxableWages + gainTotals.shortTermGainTaxable + gainTotals.longTermGainTaxable - gainTotals.ordinaryLossDeduction - hsaDeduction
  );
  const federalItemized = computeItemizedDeduction(preliminaryAgi, {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    stateIncomeTaxPaid: deductionTotal(deductionMatches, "stateIncomeTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  });
  const taxEstimate = estimateUsFederalTax({
    taxYear: taxEstimateYear,
    filingStatus,
    wages: taxableWages,
    federalWithheld: totalFederal,
    // Medicare wages aren't reduced by a 401(k) deferral (still FICA-taxable), unlike the
    // federal-income-tax wages above -- use gross pay, not taxableWages.
    medicareWages: totalGross,
    medicareWithheld: totalMedicare,
    shortTermGainTaxable: gainTotals.shortTermGainTaxable,
    longTermGainTaxable: gainTotals.longTermGainTaxable,
    capitalLossDeduction: gainTotals.ordinaryLossDeduction,
    aboveLineDeduction: hsaDeduction,
    itemizedDeduction: federalItemized.total,
  });

  // California state tax — the user is a full-year CA resident. Uses federal AGI as a proxy
  // for CA AGI (adding back the HSA deduction, since CA doesn't conform to federal HSA
  // treatment), and CA's own itemized rules (no SALT cap, but state income tax paid isn't
  // deductible against itself).
  const caAgi = taxEstimate.agi + taxEstimate.aboveLineDeduction;
  const caItemized = computeCaItemizedDeduction(caAgi, {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  });
  const caTaxEstimate = estimateCaStateTax({
    taxYear: taxEstimateYear,
    filingStatus,
    agi: caAgi,
    itemizedDeduction: caItemized,
    stateWithheld: totalStateWH,
  });

  const summaryCards: { label: string; value: number; sub: string; onClick?: () => void; icon: IconKind; color: string }[] = [
    { label: "Gross Salary", value: totalGross, sub: "Base + Bonus + Stock + other — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Gross Salary", row: gross }), icon: "cash", color: "#1e40af" },
    { label: "Total Tax", value: totalTaxAll, sub: `${effectiveRate.toFixed(1)}% effective rate — click for details →`, onClick: () => setPeriodBreakdownModal({ label: "Total Tax", row: totalTax }), icon: "receipt", color: "#dc2626" },
    { label: "Net Salary", value: totalNet, sub: "after deductions — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Net Salary", row: netSalary }), icon: "wallet", color: "#16a34a" },
    { label: "After Tax Salary", value: totalAfterTax, sub: "take-home — click for details →", onClick: () => setPeriodBreakdownModal({ label: "After Tax Salary", row: afterTax }), icon: "bank", color: "#0891b2" },
    { label: "401K (Employee)", value: totalK401, sub: "payroll deduction — click for details →", onClick: () => setPeriodBreakdownModal({ label: "401K (Employee)", row: k401 }), icon: "shield", color: "#7c3aed" },
    { label: "401K Employer Match", value: totalK401Emplr, sub: "not in the paycheck deposit — click for details →", onClick: () => setPeriodBreakdownModal({ label: "401K Employer Match", row: k401Emplr }), icon: "shield", color: "#9333ea" },
    { label: "ESPP Deduction", value: totalEsppDeduction, sub: `${fmt(esppDiscountValue)} discount value — click for details →`, onClick: () => setShowEsppModal(true), icon: "tag", color: "#d97706" },
    { label: "Stock (RSU) Vested", value: stockVestedValue, sub: "click for vest details →", onClick: () => setShowRsuModal(true), icon: "stock", color: "#1e40af" },
    { label: "Effective Salary", value: totalEffective, sub: "incl. employer 401K + ESPP — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Effective Salary", row: effective }), icon: "trending-up", color: "#16a34a" },
  ];

  function openVoucherModal(tx: Tx) {
    setVoucherModalTx(tx);
  }

  // Handles both cases: editing an existing ManualPayrollPeriod (voucher-derived, or an
  // already-created Excel correction) when editingTarget.id is set, or creating a brand
  // new correction overlay for an Excel period when it's null.
  async function saveEdit() {
    if (!editingTarget) return;
    setSavingManual(true);
    try {
      const federalV = Number(manualForm.federal) || 0;
      const ssnV = Number(manualForm.ssn) || 0;
      const medicareV = Number(manualForm.medicare) || 0;
      const stateWHV = Number(manualForm.stateWH) || 0;
      const stateSDIV = Number(manualForm.stateSDI) || 0;
      const fields = {
        base: Number(manualForm.base) || 0,
        telephone: Number(manualForm.telephone) || 0,
        medical: Number(manualForm.medical) || 0,
        k401: Number(manualForm.k401) || 0,
        k401Emplr: Number(manualForm.k401Emplr) || 0,
        espp: Number(manualForm.espp) || 0,
        federal: federalV,
        ssn: ssnV,
        medicare: medicareV,
        stateWH: stateWHV,
        stateSDI: stateSDIV,
        totalTax: federalV + ssnV + medicareV + stateWHV + stateSDIV,
        net: Number(manualForm.net) || 0,
        estimated: false as const,
      };
      const updatedYears = payroll!.years.map((y) => {
        if (y.year !== yr.year) return y;
        const existing = y.manualPeriods ?? [];
        if (editingTarget.id) {
          return { ...y, manualPeriods: existing.map((x) => (x.id === editingTarget.id ? { ...x, ...fields } : x)) };
        }
        const newPeriod: ManualPayrollPeriod = { id: crypto.randomUUID(), label: editingTarget.label, periodIndex: editingTarget.periodIndex, ...fields };
        return { ...y, manualPeriods: [...existing, newPeriod] };
      });
      await onSave({ ...payroll!, years: updatedYears });
      setEditingTarget(null);
    } finally {
      setSavingManual(false);
    }
  }

  function startEditExisting(m: ManualPayrollPeriod) {
    setManualForm({
      base: String(m.base), telephone: String(m.telephone), medical: String(m.medical),
      k401: String(m.k401), k401Emplr: String(m.k401Emplr ?? 0), espp: String(m.espp ?? 0),
      federal: String(m.federal), ssn: String(m.ssn), medicare: String(m.medicare),
      stateWH: String(m.stateWH), stateSDI: String(m.stateSDI), net: String(m.net),
    });
    setEditingTarget({ id: m.id, periodIndex: m.periodIndex, label: m.label });
  }

  function startEditExcel(i: number, label: string) {
    setManualForm({
      base: String(at(baseRow, i)), telephone: String(at(telRow, i)), medical: String(at(medicalRow, i)),
      k401: String(at(k401, i)), k401Emplr: String(at(k401Emplr, i)), espp: String(at(esppRow, i)),
      federal: String(at(federal, i)), ssn: String(at(ssn, i)), medicare: String(at(medicare, i)),
      stateWH: String(at(stateWH, i)), stateSDI: String(at(stateSDI, i)), net: String(at(netSalary, i)),
    });
    setEditingTarget({ id: null, periodIndex: i, label });
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
      </div>

      {k401ByYear.length > 0 && (
        <details style={{ margin: "0 0 0.75rem" }}>
          <summary style={{ fontSize: 12, cursor: "pointer", listStyle: "none", fontWeight: 600 }}>
            401(k) Contributions by Year — lifetime {fmt(k401LifetimeSelf)} self + {fmt(k401LifetimeEmployer)} employer ={" "}
            {fmt(k401LifetimeSelf + k401LifetimeEmployer)} (click to expand)
          </summary>
          <table className="equity-table equity-drilldown-table" style={{ marginTop: "0.5rem" }}>
            <thead>
              <tr>
                <th>Year</th>
                <th className="right">Your Contribution</th>
                <th className="right">Employer Match</th>
                <th className="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {k401ByYear.map((r) => (
                <tr key={r.year}>
                  <td>{r.year}</td>
                  <td className="right">{fmt(r.self)}</td>
                  <td className="right">{fmt(r.employer)}</td>
                  <td className="right">{fmt(r.self + r.employer)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Lifetime</td>
                <td className="right">{fmt(k401LifetimeSelf)}</td>
                <td className="right">{fmt(k401LifetimeEmployer)}</td>
                <td className="right">{fmt(k401LifetimeSelf + k401LifetimeEmployer)}</td>
              </tr>
            </tfoot>
          </table>
        </details>
      )}

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
            <th>ESPP</th>
            <th>Voucher</th>
          </tr>
        </thead>
        <tbody>
          {yr.periodLabels.map((label, i) => {
            // Once a period has a correction overlaid on it, the allManualPeriods row below
            // is the sole renderer for it (full edit history, no duplicate row).
            if (overrideByIndex.has(i)) return null;
            const g = at(gross, i);
            const fed = at(federal, i);
            const ssnV = at(ssn, i);
            const med = at(medicare, i);
            const swh = at(stateWH, i);
            const ssdi = at(stateSDI, i);
            const t = at(totalTax, i);
            const net = at(netSalary, i);
            if (!g && !t && !fed) return null; // skip empty future periods
            const key = `excel-${i}`;
            const expanded = expandedKey === key;
            const editing = editingTarget?.id === null && editingTarget?.periodIndex === i;
            const linkedTx = label ? findPayrollVoucher(transactions, yr.year, label) : undefined;
            const match = yr.matches?.find((mt) => mt.periodIndex === i);
            const expectedNet = at(netSalary, i);
            const variance = match ? match.depositAmount - expectedNet : 0;
            const varianceFlag = match && Math.abs(variance) > 1;
            const range = label ? parsePeriodRange(label, yr.year) : null;
            const isPast = range ? range.end < todayIso : false;
            const periodEspp = range ? yearEspp.filter((e) => e.purchaseDate >= range.start && e.purchaseDate <= range.end) : [];
            const periodEsppShares = periodEspp.reduce((s, e) => s + e.shares, 0);
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: "pointer" }}>
                  <td title={label || undefined}>{label ? periodEndLabel(label, yr.year) : `Period ${i + 1}`}</td>
                  <td className="right">{fmt(g)}</td>
                  <td className="right">{fmt(fed)}</td>
                  <td className="right">{fmt(ssnV)}</td>
                  <td className="right">{fmt(med)}</td>
                  <td className="right">{fmt(swh)}</td>
                  <td className="right">{fmt(ssdi)}</td>
                  <td className="right">{fmt(t)}</td>
                  <td className="right">{fmt(net)}</td>
                  <td>
                    {periodEspp.length > 0 ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); setPeriodEsppModal({ label: label || `Period ${i + 1}`, items: periodEspp }); }}
                        style={linkBtnStyle}
                      >
                        🏷️ {periodEsppShares.toLocaleString()} sh
                      </button>
                    ) : (
                      <span style={{ opacity: 0.3 }}>—</span>
                    )}
                  </td>
                  <td>
                    {linkedTx ? (
                      <button className="tax-voucher-link" onClick={(e) => { e.stopPropagation(); openVoucherModal(linkedTx); }} title={linkedTx.narration || ""} style={linkBtnStyle}>
                        🔗 {linkedTx.type} #{linkedTx.number || "—"} · {new Date(linkedTx.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
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
                    <td colSpan={11} style={{ background: "var(--panel-2, #f6f7f9)" }}>
                      {editing ? (
                        <EditFieldsForm form={manualForm} onChange={setManualForm} onSave={saveEdit} onCancel={() => setEditingTarget(null)} saving={savingManual} />
                      ) : (
                        <div style={{ display: "flex", gap: "1.25rem", alignItems: "center", padding: "0.5rem 0.25rem" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "0.6rem 1.25rem", flex: 1 }}>
                            {rows.map((r, ri) => (
                              <div key={ri}>
                                <div style={{ fontSize: 11, opacity: 0.7 }}>{r.label}</div>
                                <strong className="equity-amt">{fmt(r.values[i] ?? 0)}</strong>
                              </div>
                            ))}
                          </div>
                          {!readOnly && (
                            <button
                              onClick={() => startEditExcel(i, label)}
                              title="Edit with real paystub numbers"
                              aria-label="Edit with real paystub numbers"
                              style={{ flexShrink: 0, fontSize: 15, lineHeight: 1, padding: "6px 9px", cursor: "pointer" }}
                            >
                              ✎
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {allManualPeriods.map((m) => {
            const key = `manual-${m.id}`;
            const expanded = expandedKey === key;
            const isOverride = m.periodIndex !== undefined;
            const tx = m.txGuid ? transactions.find((t) => t.guid === m.txGuid) : findPayrollVoucher(transactions, yr.year, m.label);
            const editing = editingTarget?.id === m.id;
            const mRange = parsePeriodRange(m.label, yr.year);
            const mEspp = mRange ? yearEspp.filter((e) => e.purchaseDate >= mRange.start && e.purchaseDate <= mRange.end) : [];
            const mEsppShares = mEspp.reduce((s, e) => s + e.shares, 0);
            return (
              <Fragment key={key}>
                <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: "pointer", background: isOverride ? "#eff6ff" : "#fffbeb" }}>
                  <td title={`${m.label} — ${isOverride ? "corrected from the Excel import" : "posted in the vault but not yet in the imported Excel file"}`}>
                    {periodEndLabel(m.label, yr.year)} <em style={{ fontSize: 10, opacity: 0.6 }}>{isOverride ? "(edited)" : m.estimated ? "(from voucher, estimated)" : "(from voucher, edited)"}</em>
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
                    {mEspp.length > 0 ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); setPeriodEsppModal({ label: m.label, items: mEspp }); }}
                        style={linkBtnStyle}
                      >
                        🏷️ {mEsppShares.toLocaleString()} sh
                      </button>
                    ) : (
                      <span style={{ opacity: 0.3 }}>—</span>
                    )}
                  </td>
                  <td>
                    {tx ? (
                      <button className="tax-voucher-link" onClick={(e) => { e.stopPropagation(); openVoucherModal(tx); }} title={tx.narration || ""} style={linkBtnStyle}>
                        🔗 {tx.type} #{tx.number || "—"} · {new Date(tx.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                      </button>
                    ) : (
                      <span style={{ opacity: 0.4 }}>{m.txGuid ? "Voucher removed" : "—"}</span>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={11} style={{ background: "var(--panel-2, #f6f7f9)" }}>
                      {!editing ? (
                        <div style={{ padding: "0.5rem 0.25rem" }}>
                          {m.estimated ? (
                            <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 0.6rem" }}>
                              Federal/SSN/Medicare/State are estimated from your closest matching pay period — replace with your real paystub numbers once you have them.
                            </p>
                          ) : null}
                          <div style={{ display: "flex", gap: "1.25rem", alignItems: "center" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "0.6rem 1.25rem", flex: 1 }}>
                              {[
                                ["Base", m.base], ["Telephone", m.telephone], ["Medical", m.medical],
                                ["401K (employee)", m.k401], ["401K Employer Match", m.k401Emplr ?? 0], ["ESPP Deduction", m.espp ?? 0],
                                ["Federal", m.federal], ["SSN", m.ssn], ["Medicare", m.medicare],
                                ["State W/H", m.stateWH], ["State SDI", m.stateSDI], ["Net", m.net],
                              ].map(([lbl, val]) => (
                                <div key={lbl as string}>
                                  <div style={{ fontSize: 11, opacity: 0.7 }}>{lbl}</div>
                                  <strong className="equity-amt">{fmt(val as number)}</strong>
                                </div>
                              ))}
                            </div>
                            {!readOnly && (
                              <button
                                onClick={() => startEditExisting(m)}
                                title="Edit with real paystub numbers"
                                aria-label="Edit with real paystub numbers"
                                style={{ flexShrink: 0, fontSize: 15, lineHeight: 1, padding: "6px 9px", cursor: "pointer" }}
                              >
                                ✎
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <EditFieldsForm form={manualForm} onChange={setManualForm} onSave={saveEdit} onCancel={() => setEditingTarget(null)} saving={savingManual} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {vestGroups.map(({ date, items, stockIdx }) => {
            const key = `vest-${date}`;
            const expanded = expandedKey === key;
            const anyPending = items.some(({ vest }) => vest.pending);
            const shares = items.reduce((s, { vest }) => s + vest.shares, 0);
            const grossVal = items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
            const fed = stockVal(federal, stockIdx);
            const ssnV = stockVal(ssn, stockIdx);
            const med = stockVal(medicare, stockIdx);
            const swh = stockVal(stateWH, stockIdx);
            const ssdi = stockVal(stateSDI, stockIdx);
            const taxV = stockVal(totalTax, stockIdx);
            const showDash = (v: number | null) => (v === null ? <span style={{ opacity: 0.3 }}>—</span> : fmt(v));
            return (
              <tr
                key={key}
                onClick={() => setExpandedKey(expanded ? null : key)}
                style={{ cursor: "pointer", background: "#eef2ff" }}
              >
                <td title="Quarterly RSU vesting event, from the payroll Excel's 'Stocks' columns">
                  {new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} Vesting
                  {anyPending && <em style={{ fontSize: 10, opacity: 0.6 }}> (scheduled)</em>}
                </td>
                <td className="right">{anyPending ? <span style={{ opacity: 0.3 }}>—</span> : <span className="equity-amt">{fmt(grossVal)}</span>}</td>
                <td className="right">{showDash(fed)}</td>
                <td className="right">{showDash(ssnV)}</td>
                <td className="right">{showDash(med)}</td>
                <td className="right">{showDash(swh)}</td>
                <td className="right">{showDash(ssdi)}</td>
                <td className="right">{showDash(taxV)}</td>
                <td className="right"><span style={{ opacity: 0.3 }}>—</span></td>
                <td><span style={{ opacity: 0.3 }}>—</span></td>
                <td>
                  <button
                    className="tax-voucher-link"
                    onClick={(e) => { e.stopPropagation(); setPeriodVestModal({ label: `${new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} Vesting`, items }); }}
                    style={linkBtnStyle}
                  >
                    📈 {shares.toLocaleString()} sh
                  </button>
                </td>
              </tr>
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
            <th>{(yearEspp.reduce((s, e) => s + e.shares, 0)).toLocaleString()} sh</th>
            <th>
              {yr.periodLabels.filter((l) => l && findPayrollVoucher(transactions, yr.year, l)).length + voucherPeriods.length}
              {" / "}
              {yr.periodLabels.filter((l) => l).length + voucherPeriods.length} linked
            </th>
          </tr>
        </tfoot>
      </table>
      {allManualPeriods.length > 0 && (
        <p className="equity-seed-note" style={{ marginTop: "-0.5rem" }}>
          {voucherPeriods.length > 0 && `${voucherPeriods.length} pay period(s) auto-added from posted vouchers. `}
          {overrideByIndex.size > 0 && `${overrideByIndex.size} period(s) corrected from the Excel import. `}
          Rows highlighted above — expand any row (including regular Excel-imported ones) and click "✎ Edit" to enter real paystub numbers.
        </p>
      )}

      <div className="equity-section-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h4>Estimated Tax Liability — {yr.year} (Federal)</h4>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Filing status
            <select value={filingStatus} onChange={(e) => setFilingStatus(e.target.value as UsFilingStatus)}>
              <option value="mfj">Married filing jointly</option>
              <option value="single">Single</option>
            </select>
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: "0.4rem" }}>
            HSA coverage
            <select value={hsaCoverage} onChange={(e) => setHsaCoverage(e.target.value as HsaCoverage)}>
              <option value="family">Family</option>
              <option value="self-only">Self-only</option>
            </select>
          </label>
        </div>
      </div>
      <details style={{ margin: "0 0 0.75rem" }}>
        <summary style={{ fontSize: 12, opacity: 0.7, cursor: "pointer", listStyle: "none" }}>
          ℹ️ Estimate only — not tax advice. Click for assumptions &amp; limitations →
        </summary>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0 0" }}>
          Wages = gross pay less your 401(k) employee contribution (assumed traditional/pretax — Roth 401(k)
          contributions are post-tax and wouldn&apos;t reduce this; not distinguished here) and any personal HSA
          contributions found (transactions narrated "HSA", capped at the IRS annual limit for the coverage tier
          selected above). No other pretax deductions (e.g. health premiums) are subtracted since the app
          doesn&apos;t separately track them. Federal: includes Additional Medicare Tax and NIIT (both validated
          against a real return), but not AMT (didn&apos;t apply in that same return despite a large SALT addback —
          not modeled, watch for it changing at materially higher income). NIIT&apos;s net investment income only
          includes realized capital gains — interest/dividends aren&apos;t tracked, so it&apos;s understated if you
          have meaningful amounts of either. ESPP disqualifying-disposition ordinary income isn&apos;t modeled
          (treated as capital gain). CA: uses federal AGI as a proxy for CA AGI, adding the HSA deduction back since
          California doesn&apos;t conform to federal HSA treatment; no other CA-specific addback/subtraction items
          modeled. Mortgage interest isn&apos;t capped to the $750k acquisition-debt limit (can&apos;t be checked
          from ledger data alone). Based on {taxEstimate.rules.ruleVersion} / {caTaxEstimate.rules.ruleVersion}.
        </p>
      </details>
      <div className="equity-summary-row">
        {[
          {
            label: "AGI", value: taxEstimate.agi,
            sub: hsaDeduction > 0
              ? `wages less 401(k) & ${fmt(hsaDeduction)} HSA + net capital gains`
              : `wages less ${fmt(totalK401)} 401(k) + net capital gains`,
            icon: "wallet" as IconKind, color: "#1e40af",
          },
          {
            label: "Deduction Used", value: taxEstimate.deductionUsed,
            sub: deductionMatches.length > 0 || hsaContributions.length > 0
              ? `${taxEstimate.usedItemized ? "itemized" : "standard"} — click for details →`
              : (taxEstimate.usedItemized ? "itemized (beats standard)" : "standard deduction"),
            icon: "cash" as IconKind, color: "#0891b2",
            onClick: deductionMatches.length > 0 || hsaContributions.length > 0 ? () => setShowDeductionsModal(true) : undefined,
          },
          {
            label: gainTotals.ordinaryLossDeduction > 0 ? "Capital Loss Deduction" : "Long-Term Capital Gain",
            value: gainTotals.ordinaryLossDeduction > 0 ? gainTotals.ordinaryLossDeduction : taxEstimate.longTermGain,
            sub: gainEvents.length > 0 ? `${gainEvents.length} sale(s) — click for details →` : "no sales matched",
            icon: "trending-up" as IconKind, color: "#7c3aed",
            onClick: gainEvents.length > 0 ? () => setShowGainEventsModal(true) : undefined,
          },
          {
            label: "Estimated Federal Tax", value: taxEstimate.estimatedTax,
            sub: `ordinary ${fmt(taxEstimate.ordinaryTax)} + LTCG ${fmt(taxEstimate.ltcgTax)} + Medicare ${fmt(taxEstimate.additionalMedicareTax)} + NIIT ${fmt(taxEstimate.niit)}`,
            icon: "receipt" as IconKind, color: "#dc2626",
          },
          {
            label: "Federal Withheld", value: taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld,
            sub: taxEstimate.additionalMedicareWithheld > 0
              ? `${fmt(taxEstimate.federalWithheld)} income tax + ${fmt(taxEstimate.additionalMedicareWithheld)} Medicare`
              : "from payroll",
            icon: "shield" as IconKind, color: "#16a34a",
          },
          taxEstimate.refund > 0
            ? { label: "Estimated Federal Refund", value: taxEstimate.refund, sub: "withheld exceeds estimated tax", icon: "scale" as IconKind, color: "#16a34a" }
            : { label: "Estimated Federal Balance Due", value: taxEstimate.balanceDue, sub: "estimated tax exceeds withheld", icon: "scale" as IconKind, color: "#dc2626" },
        ].map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div
              className="equity-summary-card"
              style={c.onClick ? { cursor: "pointer" } : undefined}
              onClick={c.onClick}
            >
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
      {deductionMatches.length === 0 && (
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
          No deduction ledgers matched (looking for names containing "medical", "mortgage interest"/"interest on
          home loan", "property tax", "state tax", or "donation"/"charity") — using the standard deduction. Rename
          a ledger to match if you track one of these separately.
        </p>
      )}

      <div className="equity-section-head">
        <h4>California State Tax — {yr.year}</h4>
      </div>
      <div className="equity-summary-row">
        {[
          { label: "CA Taxable Income", value: caTaxEstimate.taxableIncome, sub: caTaxEstimate.usedItemized ? "itemized (beats CA standard)" : "CA standard deduction", icon: "cash" as IconKind, color: "#0891b2" },
          { label: "Estimated CA Tax", value: caTaxEstimate.estimatedTax, sub: caTaxEstimate.mentalHealthTax > 0 ? `incl. ${fmt(caTaxEstimate.mentalHealthTax)} Mental Health Services Tax` : "brackets only", icon: "receipt" as IconKind, color: "#dc2626" },
          { label: "CA Withheld", value: caTaxEstimate.stateWithheld, sub: "from payroll (State W/H)", icon: "shield" as IconKind, color: "#16a34a" },
          caTaxEstimate.refund > 0
            ? { label: "Estimated CA Refund", value: caTaxEstimate.refund, sub: "withheld exceeds estimated tax", icon: "scale" as IconKind, color: "#16a34a" }
            : { label: "Estimated CA Balance Due", value: caTaxEstimate.balanceDue, sub: "estimated tax exceeds withheld", icon: "scale" as IconKind, color: "#dc2626" },
        ].map((c) => (
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

      {showRsuModal && (
        <Modal title={`RSU Vesting — ${yr.year}`} onClose={() => setShowRsuModal(false)} wide>
          <VestTable items={yearVests} fmt={fmt} />
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

      {periodVestModal && (
        <Modal title={`RSU Vesting — ${periodVestModal.label}`} onClose={() => setPeriodVestModal(null)} wide>
          <VestTable items={periodVestModal.items} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setPeriodVestModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {showEsppModal && (
        <Modal title={`ESPP Purchases — ${yr.year}`} onClose={() => setShowEsppModal(false)} wide>
          <EsppTable items={yearEspp} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowEsppModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {periodBreakdownModal && (
        <Modal title={`${periodBreakdownModal.label} — ${yr.year}`} onClose={() => setPeriodBreakdownModal(null)} wide>
          <table className="equity-table equity-drilldown-table">
            <thead>
              <tr>
                <th>Period</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {yr.periodLabels.map((label, i) => {
                const v = periodBreakdownModal.row?.values[i] ?? 0;
                if ((gross?.values[i] ?? 0) === 0 && v === 0) return null; // no pay period recorded yet
                return (
                  <tr key={label || i}>
                    <td title={label || undefined}>{label ? periodEndLabel(label, yr.year) : `Period ${i + 1}`}</td>
                    <td className="right">{fmt(v)}</td>
                  </tr>
                );
              })}
              {vestGroups.map(({ date, stockIdx }) => {
                const v = periodBreakdownModal.row?.stockValues?.[stockIdx];
                if (v === undefined || Math.abs(v) < 0.005) return null;
                return (
                  <tr key={date}>
                    <td>{fmtDate(date)} (vesting)</td>
                    <td className="right">{fmt(v)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="right">{fmt(sumRow(periodBreakdownModal.row))}</td>
              </tr>
            </tfoot>
          </table>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setPeriodBreakdownModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {showGainEventsModal && (
        <Modal title={`RSU & ESPP Sales — ${yr.year}`} onClose={() => setShowGainEventsModal(false)} wide>
          <table className="equity-table">
            <thead>
              <tr><th>Sale</th><th className="right">Shares</th><th className="right">Cost Basis</th><th className="right">Proceeds</th><th className="right">Gain/(Loss)</th><th>Term</th></tr>
            </thead>
            <tbody>
              {gainEvents.map((g) => (
                <tr key={g.id}>
                  <td>{g.label}</td>
                  <td className="right">{g.shares.toLocaleString()}</td>
                  <td className="right">{fmt(g.costBasis)}</td>
                  <td className="right">{fmt(g.proceeds)}</td>
                  <td className="right equity-amt" style={{ color: g.gain >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(g.gain)}</td>
                  <td>{g.term === "long" ? "Long-term" : "Short-term"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.75rem" }}>
            Only lots with an entered sale price count as a realized sale — see Reports → Equity to add one.
            Net short-term {fmt(gainTotals.netShortTerm)}, net long-term {fmt(gainTotals.netLongTerm)}
            (raw totals before netting one against the other).
          </p>
          {gainTotals.ordinaryLossDeduction > 0 ? (
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
              Net overall capital loss of {fmt(gainTotals.netShortTerm + gainTotals.netLongTerm).replace("-", "")} — up to $3,000/year is
              deductible against ordinary income; {fmt(gainTotals.ordinaryLossDeduction)} of that is applied above, reducing AGI.
              {gainTotals.lossCarryforward > 0 && ` The remaining ${fmt(gainTotals.lossCarryforward)} isn't tracked as a carryforward to next year by this app — note it yourself.`}
            </p>
          ) : (
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
              Taxed as {fmt(gainTotals.shortTermGainTaxable)} ordinary income + {fmt(gainTotals.longTermGainTaxable)} at preferential
              LTCG rates (a loss in one category first offsets a gain in the other before any rate is applied).
            </p>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowGainEventsModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showDeductionsModal && (
        <Modal title={`Itemized Deductions — ${yr.year}`} onClose={() => setShowDeductionsModal(false)} wide>
          <table className="equity-table">
            <thead>
              <tr><th>Category</th><th>Matched Ledger(s)</th><th className="right">Amount</th></tr>
            </thead>
            <tbody>
              {deductionMatches.map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.label}
                    {m.excludedCount ? (
                      <span title="Excluded from this total: transactions whose narration mentions HSA/FSA — those aren't separately deductible as a medical expense (they get their own above-the-line deduction, not modeled here).">
                        {" "}<em style={{ fontSize: 10, opacity: 0.6 }}>({m.excludedCount} HSA/FSA excluded)</em>
                      </span>
                    ) : null}
                  </td>
                  <td>{m.ledgers.map((l) => l.name).join(", ")}</td>
                  <td className="right equity-amt">{fmt(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.75rem" }}>
            Federal itemized total {fmt(federalItemized.total)} (medical above 7.5% AGI floor: {fmt(federalItemized.medicalDeductible)};
            SALT capped at {fmt(federalItemized.saltCap)}: {fmt(federalItemized.saltDeductible)}; mortgage interest {fmt(federalItemized.mortgageInterestDeductible)};
            charitable {fmt(federalItemized.charitableDeductible)}) vs. standard deduction {fmt(taxEstimate.rules.standardDeduction)} —
            {taxEstimate.usedItemized ? " itemizing wins, used above." : " standard deduction wins, used above."}
          </p>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
            California itemized total {fmt(caItemized)} (no SALT cap, but state income tax paid doesn&apos;t count
            against the CA return) vs. CA standard deduction {fmt(caTaxEstimate.rules.standardDeduction)} —
            {caTaxEstimate.usedItemized ? " itemizing wins for CA." : " CA standard deduction wins."}
          </p>
          {hsaContributions.length > 0 && (
            <>
              <h5 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>HSA Contributions (above-the-line, federal only)</h5>
              <table className="equity-table">
                <thead>
                  <tr><th>Date</th><th>Narration</th><th className="right">Amount</th></tr>
                </thead>
                <tbody>
                  {hsaContributions.map((h) => (
                    <tr key={h.txGuid}>
                      <td>{fmtDate(h.date)}</td>
                      <td>{h.narration}</td>
                      <td className="right equity-amt">{fmt(h.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
                Total {fmt(hsaContributionTotal)}, capped at the {hsaCoverage} IRS limit — {fmt(hsaDeduction)} actually deducted from
                federal AGI. Not deductible on your CA return (California doesn&apos;t conform to federal HSA treatment), so it&apos;s
                added back for the CA calculation above.
              </p>
            </>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowDeductionsModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {periodEsppModal && (
        <Modal title={`ESPP Purchases — ${periodEsppModal.label}`} onClose={() => setPeriodEsppModal(null)} wide>
          <EsppTable items={periodEsppModal.items} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setPeriodEsppModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {voucherModalTx && (
        <Modal title={`${voucherModalTx.type} #${voucherModalTx.number || "—"}`} onClose={() => setVoucherModalTx(null)}>
          <p style={{ margin: "0 0 0.75rem", fontSize: 13, opacity: 0.75 }}>
            {new Date(voucherModalTx.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
          </p>
          {voucherModalTx.narration && <p style={{ margin: "0 0 0.75rem", fontSize: 13 }}>{voucherModalTx.narration}</p>}
          <table className="equity-table" style={{ width: "100%" }}>
            <thead><tr><th>Account</th><th className="right">Debit</th><th className="right">Credit</th></tr></thead>
            <tbody>
              {voucherModalTx.entries.map((e, i) => (
                <tr key={i}>
                  <td>{e.accountName}</td>
                  <td className="right equity-amt">{e.amount < 0 ? fmt(Math.abs(e.amount)) : ""}</td>
                  <td className="right equity-amt">{e.amount > 0 ? fmt(e.amount) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th className="right">{fmt(voucherModalTx.entries.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0))}</th>
                <th className="right">{fmt(voucherModalTx.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0))}</th>
              </tr>
            </tfoot>
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
