"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData, ManualPayrollPeriod, RsuGrant, RsuVest, EsppPurchase } from "@/lib/vault-types";
import { findPayrollVoucher, parsePeriodRange, findUncoveredSalaryVouchers, estimateManualPeriod, generateStandardPeriodLabels, normalizePayrollYear } from "@/lib/payroll-match";
import { StatIcon, type IconKind } from "@/components/Icon";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  transactions: Tx[];
  equity: EquityData | undefined;
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
            <td>{new Date(e.purchaseDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</td>
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

export function TaxReport({ payroll, transactions, equity, onSave, onViewVoucher, fmt, readOnly, uiTheme }: TaxReportProps) {
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

  const summaryCards: { label: string; value: number; sub: string; onClick?: () => void; icon: IconKind; color: string }[] = [
    { label: "Gross Salary", value: totalGross, sub: "Base + Bonus + Stock + other", icon: "cash", color: "#1e40af" },
    { label: "Total Tax", value: totalTaxAll, sub: `${effectiveRate.toFixed(1)}% effective rate`, icon: "receipt", color: "#dc2626" },
    { label: "Net Salary", value: totalNet, sub: "after deductions", icon: "wallet", color: "#16a34a" },
    { label: "After Tax Salary", value: totalAfterTax, sub: "take-home", icon: "bank", color: "#0891b2" },
    { label: "401K (Employee)", value: totalK401, sub: "payroll deduction", icon: "shield", color: "#7c3aed" },
    { label: "401K Employer Match", value: totalK401Emplr, sub: "not in the paycheck deposit", icon: "shield", color: "#9333ea" },
    { label: "ESPP Deduction", value: totalEsppDeduction, sub: `${fmt(esppDiscountValue)} discount value — click for details →`, onClick: () => setShowEsppModal(true), icon: "tag", color: "#d97706" },
    { label: "Stock (RSU) Vested", value: stockVestedValue, sub: "click for vest details →", onClick: () => setShowRsuModal(true), icon: "stock", color: "#1e40af" },
    { label: "Effective Salary", value: totalEffective, sub: "incl. employer 401K + ESPP", icon: "trending-up", color: "#16a34a" },
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
                  <td>{label || `Period ${i + 1}`}</td>
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
                  <td title={isOverride ? "Corrected from the Excel import" : "Posted in the vault but not yet in the imported Excel file"}>
                    {m.label} <em style={{ fontSize: 10, opacity: 0.6 }}>{isOverride ? "(edited)" : m.estimated ? "(from voucher, estimated)" : "(from voucher, edited)"}</em>
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
                        🔗 {tx.type} #{tx.number || "—"} · {new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
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
                  {new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} Vesting
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
                    onClick={(e) => { e.stopPropagation(); setPeriodVestModal({ label: `${new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} Vesting`, items }); }}
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
