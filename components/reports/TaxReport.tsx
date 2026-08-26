"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData, ManualPayrollPeriod, RsuGrant, RsuVest, EsppPurchase, Account } from "@/lib/vault-types";
import { findPayrollVoucher, parsePeriodRange, findUncoveredSalaryVouchers, estimateManualPeriod, generateStandardPeriodLabels, normalizePayrollYear } from "@/lib/payroll-match";
import { StatIcon, type IconKind } from "@/components/Icon";
import { DonutChart, type DonutSegment } from "@/components/DonutChart";
import { VoucherTypeBadge, VoucherFlow } from "@/components/VoucherVisual";
import { FloatingWindow as Modal } from "@/components/FloatingWindow";
import { classifyRsuSales, classifyEsppSales, summarizeCapitalGains } from "@/lib/tax-classify";
import { estimateUsFederalTax, computeItemizedDeduction, computeHsaDeduction, type HsaCoverage } from "@/lib/tax-usa-engine";
import { listUsTaxYears, type UsFilingStatus } from "@/lib/tax-usa-rules";
import { matchDeductionLedgers, deductionTotal, findHsaContributions } from "@/lib/tax-deductions";
import { estimateCaStateTax, computeCaItemizedDeduction } from "@/lib/tax-ca-engine";
import { estimateNjStateTax, computeNjPropertyTaxDeduction } from "@/lib/tax-nj-engine";
import { estimateAzStateTax, computeAzItemizedDeduction } from "@/lib/tax-az-engine";
import { resolveStateResidency } from "@/lib/tax-state-residency";
import { computeTaxPlanningScenarios, type TaxPlanningScenario } from "@/lib/tax-planning";
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
  livePrice?: number | null;
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

// Fixed color per component (not palette-cycled) so a given slice means the same thing across
// every paystub you open -- comparing periods side by side relies on Federal always being red,
// Net always being green, etc. Take-home is computed as the REMAINDER (gross minus every other
// slice), not read from a separately-stored "net" figure -- this app has more than one "Net"
// concept on a paystub (e.g. "Net Salary" is gross minus tax only, before 401K/medical/ESPP;
// "After Tax Salary" is the true final take-home), and picking the wrong one silently produces
// slices that don't sum to gross. Computing the remainder guarantees they always do.
function paystubDonutSegments({
  gross, federal, ssn, medicare, state, k401, medical, espp,
}: {
  gross: number; federal: number; ssn: number; medicare: number; state: number; k401: number; medical: number; espp: number;
}): DonutSegment[] {
  const otherSlices = Math.max(0, federal) + Math.max(0, ssn) + Math.max(0, medicare) + Math.max(0, state) + Math.max(0, k401) + Math.max(0, medical) + Math.max(0, espp);
  return [
    { label: "Net Take-Home", value: Math.max(0, gross - otherSlices), color: "#16a34a" },
    { label: "Federal Tax", value: Math.max(0, federal), color: "#dc2626" },
    { label: "SSN + Medicare", value: Math.max(0, ssn + medicare), color: "#d97706" },
    { label: "State Tax", value: Math.max(0, state), color: "#7c3aed" },
    { label: "401K", value: Math.max(0, k401), color: "#0891b2" },
    { label: "Medical", value: Math.max(0, medical), color: "#0d9488" },
    { label: "ESPP", value: Math.max(0, espp), color: "#db2777" },
  ];
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

export function TaxReport({ payroll, transactions, equity, accounts, onSave, onViewVoucher, fmt, readOnly, uiTheme, livePrice }: TaxReportProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  // Clicking a pay period (Excel-imported, manual/voucher-derived, or an RSU vest event) opens
  // a popup with a donut + full detail, rather than expanding an inline row.
  const [viewPeriod, setViewPeriod] = useState<
    | { type: "excel"; index: number }
    | { type: "manual"; id: string }
    | { type: "vest"; date: string }
    | { type: "ytd" }
    | null
  >(null);
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
  const [showTaxPlanningModal, setShowTaxPlanningModal] = useState(false);
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
  const manualMedical = voucherPeriods.reduce((s, m) => s + m.medical, 0);
  const manualBase = voucherPeriods.reduce((s, m) => s + m.base, 0);
  const manualTelephone = voucherPeriods.reduce((s, m) => s + m.telephone, 0);

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
  const totalMedical = overriddenTotal(medicalRow, "medical") + manualMedical;
  const totalBaseYtd = overriddenTotal(baseRow, "base") + manualBase;
  const totalTelephoneYtd = overriddenTotal(telRow, "telephone") + manualTelephone;
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
  const federalItemized = computeItemizedDeduction(taxEstimateYear, preliminaryAgi, {
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

  // State tax — dispatches to whichever state the user actually lived/worked in for this tax
  // year (lib/tax-state-residency.ts). AZ conforms to federal HSA treatment (no addback needed);
  // CA and NJ don't, so the HSA deduction is added back to approximate state AGI for those two.
  const stateResidency = resolveStateResidency(taxEstimateYear);
  const stateAgi = stateResidency.code === "AZ" ? taxEstimate.agi : taxEstimate.agi + taxEstimate.aboveLineDeduction;
  const stateItemizedInputs = {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  };
  const stateItemized =
    stateResidency.code === "NJ"
      ? computeNjPropertyTaxDeduction(stateItemizedInputs.propertyTax)
      : stateResidency.code === "AZ"
        ? computeAzItemizedDeduction(stateAgi, stateItemizedInputs)
        : computeCaItemizedDeduction(stateAgi, stateItemizedInputs);
  const stateTaxEstimate =
    stateResidency.code === "NJ"
      ? estimateNjStateTax({
          taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
          propertyTax: stateItemizedInputs.propertyTax, stateWithheld: totalStateWH,
        })
      : stateResidency.code === "AZ"
        ? estimateAzStateTax({
            taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
            itemizedDeduction: stateItemized, stateWithheld: totalStateWH,
          })
        : estimateCaStateTax({
            taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
            itemizedDeduction: stateItemized, stateWithheld: totalStateWH,
          });

  // Computed "what if" scenarios (own tax engine only, no external AI/data-sharing) -- see
  // lib/tax-planning.ts. RSU/ESPP hold-timing scenarios are skipped internally when no live
  // price is available; everything else (401K/HSA room, itemize/bunch, withholding check)
  // doesn't need one.
  const taxPlanningScenarios: TaxPlanningScenario[] = computeTaxPlanningScenarios({
    taxYear: taxEstimateYear,
    filingStatus,
    stateCode: stateResidency.code,
    stateName: stateResidency.name,
    longTermHoldingDays: taxEstimate.rules.longTermHoldingDays,
    taxableWages,
    totalGross,
    totalFederal,
    totalMedicare,
    shortTermGainTaxable: gainTotals.shortTermGainTaxable,
    longTermGainTaxable: gainTotals.longTermGainTaxable,
    capitalLossDeduction: gainTotals.ordinaryLossDeduction,
    federalItemizedTotal: federalItemized.total,
    hsaContributionTotal,
    hsaCoverage,
    totalK401,
    totalStateWH,
    stateItemizedTotal: stateItemized,
    stateHsaConforms: stateResidency.code === "AZ",
    baselineFederalTax: taxEstimate.estimatedTax,
    baselineStateTax: stateTaxEstimate.estimatedTax,
    baselineFederalBalanceDue: taxEstimate.balanceDue,
    baselineFederalStandardDeduction: taxEstimate.rules.standardDeduction,
    grants: equity?.grants ?? [],
    esppPurchases: equity?.esppPurchases ?? [],
    livePrice: livePrice ?? null,
    todayIso,
  });
  const taxPlanningTotalSavings = taxPlanningScenarios.reduce((s, sc) => s + sc.totalSavings, 0);

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
              onClick={() => { setSelectedYear(y.year); setViewPeriod(null); }}
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
                <tr onClick={() => setViewPeriod({ type: "excel", index: i })} style={{ cursor: "pointer" }}>
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
              </Fragment>
            );
          })}
          {allManualPeriods.map((m) => {
            const key = `manual-${m.id}`;
            const isOverride = m.periodIndex !== undefined;
            const tx = m.txGuid ? transactions.find((t) => t.guid === m.txGuid) : findPayrollVoucher(transactions, yr.year, m.label);
            const editing = editingTarget?.id === m.id;
            const mRange = parsePeriodRange(m.label, yr.year);
            const mEspp = mRange ? yearEspp.filter((e) => e.purchaseDate >= mRange.start && e.purchaseDate <= mRange.end) : [];
            const mEsppShares = mEspp.reduce((s, e) => s + e.shares, 0);
            return (
              <Fragment key={key}>
                <tr onClick={() => setViewPeriod({ type: "manual", id: m.id })} style={{ cursor: "pointer", background: isOverride ? "#eff6ff" : "#fffbeb" }}>
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
              </Fragment>
            );
          })}
          {vestGroups.map(({ date, items, stockIdx }) => {
            const key = `vest-${date}`;
            const anyPending = items.some(({ vest }) => vest.pending);
            const shares = items.reduce((s, { vest }) => s + vest.shares, 0);
            const grossVal = items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
            const fed = stockVal(federal, stockIdx);
            const ssnV = stockVal(ssn, stockIdx);
            const med = stockVal(medicare, stockIdx);
            const swh = stockVal(stateWH, stockIdx);
            const ssdi = stockVal(stateSDI, stockIdx);
            const taxV = stockVal(totalTax, stockIdx);
            // Vest events don't carry a stored "Net" figure the way a paystub period does --
            // compute it the same way the popup's donut does (gross minus everything withheld).
            const netVal = grossVal - (fed ?? 0) - (ssnV ?? 0) - (med ?? 0) - (swh ?? 0) - (ssdi ?? 0);
            const showDash = (v: number | null) => (v === null ? <span style={{ opacity: 0.3 }}>—</span> : fmt(v));
            return (
              <tr
                key={key}
                onClick={() => setViewPeriod({ type: "vest", date })}
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
                <td className="right">{anyPending ? <span style={{ opacity: 0.3 }}>—</span> : <span className="equity-amt" style={{ color: "#16a34a" }}>{fmt(netVal)}</span>}</td>
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
          <tr onClick={() => setViewPeriod({ type: "ytd" })} style={{ cursor: "pointer" }} title="Click for the year-to-date breakdown">
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
          <button onClick={() => setShowTaxPlanningModal(true)}>
            💡 Tax Planning{taxPlanningTotalSavings > 0 ? ` (up to ${fmt(taxPlanningTotalSavings)})` : ""}
          </button>
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
          (treated as capital gain). {stateResidency.code}: uses federal AGI as a proxy for {stateResidency.code} AGI
          {stateResidency.code !== "AZ" && <> , adding the HSA deduction back since {stateResidency.name} doesn&apos;t
          conform to federal HSA treatment</>}; no other {stateResidency.code}-specific addback/subtraction items
          modeled. Mortgage interest isn&apos;t capped to the $750k acquisition-debt limit (can&apos;t be checked
          from ledger data alone). State of residence for {yr.year} is assumed to be {stateResidency.name}. Based on
          {" "}{taxEstimate.rules.ruleVersion} / {stateTaxEstimate.rules.ruleVersion}.
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
        <h4>{stateResidency.name} State Tax — {yr.year}</h4>
      </div>
      <div className="equity-summary-row">
        {[
          { label: `${stateResidency.code} Taxable Income`, value: stateTaxEstimate.taxableIncome, sub: stateTaxEstimate.usedItemized ? `itemized (beats ${stateResidency.code} standard)` : `${stateResidency.code} standard deduction`, icon: "cash" as IconKind, color: "#0891b2" },
          { label: `Estimated ${stateResidency.code} Tax`, value: stateTaxEstimate.estimatedTax, sub: stateTaxEstimate.mentalHealthTax > 0 ? `incl. ${fmt(stateTaxEstimate.mentalHealthTax)} Mental Health Services Tax` : "brackets only", icon: "receipt" as IconKind, color: "#dc2626" },
          { label: `${stateResidency.code} Withheld`, value: stateTaxEstimate.stateWithheld, sub: "from payroll (State W/H)", icon: "shield" as IconKind, color: "#16a34a" },
          stateTaxEstimate.refund > 0
            ? { label: `Estimated ${stateResidency.code} Refund`, value: stateTaxEstimate.refund, sub: "withheld exceeds estimated tax", icon: "scale" as IconKind, color: "#16a34a" }
            : { label: `Estimated ${stateResidency.code} Balance Due`, value: stateTaxEstimate.balanceDue, sub: "estimated tax exceeds withheld", icon: "scale" as IconKind, color: "#dc2626" },
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

      {viewPeriod && (() => {
        // Excel-imported and manually-entered (or voucher-derived) periods carry the same
        // fields under different names -- normalize both into one shape so the popup below is
        // written once, not duplicated per period type.
        let period: {
          label: string; gross: number; federal: number; ssn: number; medicare: number;
          stateWH: number; stateSDI: number; totalTax: number; k401: number; k401Emplr: number;
          medical: number; espp: number; base: number; telephone: number;
          isEditing: boolean; onEdit: (() => void) | null; estimated?: boolean;
          isVest?: boolean; shares?: number; onViewShares?: () => void;
        } | null = null;

        if (viewPeriod.type === "ytd") {
          period = {
            label: `Year-to-Date Total`,
            gross: totalGross, federal: totalFederal, ssn: totalSsn, medicare: totalMedicare,
            stateWH: totalStateWH, stateSDI: totalStateSDI, totalTax: totalTaxAll,
            k401: totalK401, k401Emplr: totalK401Emplr, medical: totalMedical, espp: totalEsppDeduction,
            base: totalBaseYtd, telephone: totalTelephoneYtd,
            isEditing: false,
            onEdit: null,
          };
        } else if (viewPeriod.type === "vest") {
          const vg = vestGroups.find((g) => g.date === viewPeriod.date);
          if (vg) {
            const shares = vg.items.reduce((s, { vest }) => s + vest.shares, 0);
            const grossVal = vg.items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
            const vestLabel = `${new Date(vg.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} Vesting`;
            period = {
              label: vestLabel,
              gross: grossVal,
              federal: stockVal(federal, vg.stockIdx) ?? 0,
              ssn: stockVal(ssn, vg.stockIdx) ?? 0,
              medicare: stockVal(medicare, vg.stockIdx) ?? 0,
              stateWH: stockVal(stateWH, vg.stockIdx) ?? 0,
              stateSDI: stockVal(stateSDI, vg.stockIdx) ?? 0,
              totalTax: stockVal(totalTax, vg.stockIdx) ?? 0,
              k401: 0, k401Emplr: 0, medical: 0, espp: 0, base: 0, telephone: 0,
              isEditing: false,
              onEdit: null,
              isVest: true,
              shares,
              onViewShares: () => { setViewPeriod(null); setPeriodVestModal({ label: vestLabel, items: vg.items }); },
            };
          }
        } else if (viewPeriod.type === "excel") {
          const i = viewPeriod.index;
          const lbl = yr.periodLabels[i];
          period = {
            label: lbl ? periodEndLabel(lbl, yr.year) : `Period ${i + 1}`,
            gross: at(gross, i), federal: at(federal, i), ssn: at(ssn, i), medicare: at(medicare, i),
            stateWH: at(stateWH, i), stateSDI: at(stateSDI, i), totalTax: at(totalTax, i),
            k401: at(k401, i), k401Emplr: at(k401Emplr, i), medical: at(medicalRow, i), espp: at(esppRow, i),
            base: at(baseRow, i), telephone: at(telRow, i),
            isEditing: editingTarget?.id === null && editingTarget?.periodIndex === i,
            onEdit: readOnly ? null : () => startEditExcel(i, lbl),
          };
        } else {
          const m = allManualPeriods.find((p) => p.id === viewPeriod.id);
          if (m) {
            period = {
              label: periodEndLabel(m.label, yr.year),
              gross: m.base + m.telephone, federal: m.federal, ssn: m.ssn, medicare: m.medicare,
              stateWH: m.stateWH, stateSDI: m.stateSDI, totalTax: m.totalTax,
              k401: m.k401, k401Emplr: m.k401Emplr ?? 0, medical: m.medical, espp: m.espp ?? 0,
              base: m.base, telephone: m.telephone,
              isEditing: editingTarget?.id === m.id,
              onEdit: readOnly ? null : () => startEditExisting(m),
              estimated: m.estimated,
            };
          }
        }

        if (!period) {
          // The period this popup pointed at no longer exists under its old identity (e.g. an
          // Excel period just got saved as a new manual override) -- close rather than show a
          // stale/broken view.
          setViewPeriod(null);
          return null;
        }

        // Green = added to you (earned pay, employer-paid benefits); red = comes out of your
        // paycheck (taxes, your own contributions/premiums) -- same "money in / money out"
        // convention as the donut's Net Take-Home (green) vs. tax/deduction slices (red/warm).
        // Net Take-Home is computed the same way for every period type -- gross minus every
        // other line below -- rather than trusting a separately-stored figure, so it can never
        // silently be missing (a vest event never had one at all) or drift from what's shown.
        const netTakeHome = Math.max(
          0,
          period.gross - period.federal - period.ssn - period.medicare - period.stateWH - period.stateSDI - period.k401 - period.medical - period.espp
        );
        const grid: { label: string; value: number; kind: "in" | "out" }[] = period.isVest
          ? [
              { label: "Net Take-Home", value: netTakeHome, kind: "in" },
              { label: "Federal", value: period.federal, kind: "out" },
              { label: "SSN", value: period.ssn, kind: "out" },
              { label: "Medicare", value: period.medicare, kind: "out" },
              { label: "State W/H", value: period.stateWH, kind: "out" },
              { label: "State SDI", value: period.stateSDI, kind: "out" },
              { label: "Total Tax", value: period.totalTax, kind: "out" },
            ]
          : [
              { label: "Net Take-Home", value: netTakeHome, kind: "in" },
              { label: "Base", value: period.base, kind: "in" },
              { label: "Telephone", value: period.telephone, kind: "in" },
              { label: "401K Employer Match", value: period.k401Emplr, kind: "in" },
              { label: "Medical", value: period.medical, kind: "out" },
              { label: "401K (employee)", value: period.k401, kind: "out" },
              { label: "ESPP Deduction", value: period.espp, kind: "out" },
              { label: "Federal", value: period.federal, kind: "out" },
              { label: "SSN", value: period.ssn, kind: "out" },
              { label: "Medicare", value: period.medicare, kind: "out" },
              { label: "State W/H", value: period.stateWH, kind: "out" },
              { label: "State SDI", value: period.stateSDI, kind: "out" },
              { label: "Total Tax", value: period.totalTax, kind: "out" },
            ];

        return (
          <Modal title={`${period.label} — ${yr.year}`} onClose={() => setViewPeriod(null)} wide>
            {period.isEditing ? (
              <EditFieldsForm
                form={manualForm}
                onChange={setManualForm}
                onSave={async () => { await saveEdit(); setViewPeriod(null); }}
                onCancel={() => setEditingTarget(null)}
                saving={savingManual}
              />
            ) : (
              <>
                {period.estimated && (
                  <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 0.75rem" }}>
                    Federal/SSN/Medicare/State are estimated from your closest matching pay period — replace with your real paystub numbers once you have them.
                  </p>
                )}
                {period.gross > 0 && (
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: "1rem" }}>
                    <DonutChart
                      segments={paystubDonutSegments({
                        gross: period.gross, federal: period.federal, ssn: period.ssn, medicare: period.medicare,
                        state: period.stateWH + period.stateSDI, k401: period.k401, medical: period.medical, espp: period.espp,
                      })}
                      size={170}
                      thickness={24}
                      centerLabel="Gross"
                      centerValue={fmt(period.gross)}
                    />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.75rem 1.25rem" }}>
                  {grid.map((g) => (
                    <div key={g.label}>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>{g.label}</div>
                      <strong className="equity-amt" style={{ color: g.kind === "in" ? "#16a34a" : "#dc2626" }}>{fmt(g.value)}</strong>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                  {period.onViewShares && (
                    <button onClick={period.onViewShares}>View {period.shares?.toLocaleString()} sh breakdown</button>
                  )}
                  {period.onEdit && (
                    <button onClick={period.onEdit}>Edit with real paystub numbers</button>
                  )}
                  <button onClick={() => setViewPeriod(null)}>Close</button>
                </div>
              </>
            )}
          </Modal>
        );
      })()}

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
            {stateResidency.code === "NJ" ? (
              <>NJ deduction: {fmt(stateTaxEstimate.rules.standardDeduction)} personal exemption + {fmt(stateItemized)} property
              tax (capped at $15,000) — NJ doesn&apos;t have a standard-vs-itemized choice; both apply together, unlike the
              federal/CA/AZ returns above.</>
            ) : stateResidency.code === "AZ" ? (
              <>Arizona itemized total {fmt(stateItemized)} (SALT-capped at $10,000) vs. AZ standard deduction {fmt(stateTaxEstimate.rules.standardDeduction)} —
              {stateTaxEstimate.usedItemized ? " itemizing wins for AZ." : " AZ standard deduction wins."}</>
            ) : (
              <>California itemized total {fmt(stateItemized)} (no SALT cap, but state income tax paid doesn&apos;t count
              against the CA return) vs. CA standard deduction {fmt(stateTaxEstimate.rules.standardDeduction)} —
              {stateTaxEstimate.usedItemized ? " itemizing wins for CA." : " CA standard deduction wins."}</>
            )}
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
                federal AGI. {stateResidency.code === "AZ"
                  ? <>{stateResidency.name} conforms to federal HSA treatment, so no addback is needed for the AZ calculation above.</>
                  : <>Not deductible on your {stateResidency.code} return ({stateResidency.name} doesn&apos;t conform to federal HSA treatment),
                  so it&apos;s added back for the {stateResidency.code} calculation above.</>}
              </p>
            </>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowDeductionsModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showTaxPlanningModal && (
        <Modal title={`Tax Planning — ${yr.year}`} onClose={() => setShowTaxPlanningModal(false)} wide>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 1rem" }}>
            Every number below is computed by this app's own tax-rule tables and formulas — the same ones used
            elsewhere in this report — not by an external AI/LLM, and none of your data leaves the app. These are
            estimates to inform a conversation with a CPA, not tax advice, and not a substitute for one.
          </p>
          {(["Contribution Room", "Equity Timing", "Deduction Strategy", "Withholding", "Informational"] as const).map((cat) => {
            const items = taxPlanningScenarios.filter((s) => s.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} style={{ marginBottom: "1.25rem" }}>
                <h5 style={{ margin: "0 0 0.5rem", fontSize: 13, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.6 }}>{cat}</h5>
                {items.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.85rem 1rem", marginBottom: "0.6rem",
                      background: s.actionable ? "#fff" : "#f8fafc",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{s.title}</strong>
                      {s.totalSavings > 0 && (
                        <strong className="equity-amt" style={{ color: "#16a34a", fontSize: 14, whiteSpace: "nowrap" }}>
                          up to {fmt(s.totalSavings)}
                        </strong>
                      )}
                    </div>
                    <p style={{ fontSize: 12, margin: "0.4rem 0 0", color: "#334155" }}>{s.description}</p>
                    {s.totalSavings > 0 && (
                      <p style={{ fontSize: 11, margin: "0.4rem 0 0", opacity: 0.75 }}>
                        Federal: {fmt(s.fedSavings)} {s.stateSavings > 0 && <>· {stateResidency.name}: {fmt(s.stateSavings)}</>}
                        {s.deadline && <> · by {fmtDate(s.deadline)}</>}
                      </p>
                    )}
                    {s.caveat && (
                      <p style={{ fontSize: 10.5, margin: "0.4rem 0 0", opacity: 0.6, fontStyle: "italic" }}>{s.caveat}</p>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowTaxPlanningModal(false)}>Close</button>
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
          {uiTheme === "refresh" && <VoucherTypeBadge type={voucherModalTx.type} />}
          <p style={{ margin: "0.5rem 0 0.75rem", fontSize: 13, opacity: 0.75 }}>
            {new Date(voucherModalTx.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
          </p>
          {voucherModalTx.narration && <p style={{ margin: "0 0 0.75rem", fontSize: 13 }}>{voucherModalTx.narration}</p>}
          {uiTheme === "refresh" ? (
            <VoucherFlow entries={voucherModalTx.entries} fmt={fmt} />
          ) : (
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
          )}
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
