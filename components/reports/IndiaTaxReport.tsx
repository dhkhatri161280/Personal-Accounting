"use client";
import { useRef, useState } from "react";
import type { IndiaTaxData, IndiaPayslipMonth, IndiaItrYear } from "@/lib/vault-types";
import { parseIndiaPayslipFile, mergeIndiaPayslipMonths } from "@/lib/parse-india-payslip";
import { parseIndiaItrFile } from "@/lib/parse-india-itr";
import { StatIcon, type IconKind } from "@/components/Icon";
import { fmtDate } from "@/lib/format-date";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// India's financial year runs Apr-Mar, one year "behind" the Assessment Year an ITR is filed
// under (income earned in FY 2013-14 is assessed/filed as AY 2014-15) -- kept as two separate
// concepts/sections in this UI rather than one shared year selector, to avoid mislabeling.
function fyOf(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  return m >= 4 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 12, padding: "1.25rem", maxWidth: 640, width: "100%", maxHeight: "85vh", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h4 style={{ margin: 0 }}>{title}</h4>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Marks a payslip-month entry as hand-built (not parsed from a real payslip PDF) — e.g. one
// annual figure spread from an ITR when the real monthly payslips no longer exist.
const RECONSTRUCTED_SOURCE = "Manual entry — reconstructed from ITR archive";

const BLANK_RECONSTRUCTED_FORM = {
  financialYear: "", // e.g. "2007-08"
  employer: "", // optional -- a FY split across employers (job change mid-year) gets one entry each
  grossEarnings: "",
  incomeTax: "",
};

// A real payslip that exists only as a scanned image (no text layer, so the PDF importer can't
// read it) -- transcribed by hand with the full field breakdown, same shape as an auto-parsed
// month, just tagged with a different source label so it's clear how the numbers got in.
const TRANSCRIBED_SOURCE_PREFIX = "Manual entry — transcribed from scanned payslip";

const BLANK_MANUAL_MONTH_FORM = {
  month: "", // YYYY-MM, from an <input type="month">
  basic: "",
  hra: "",
  otherAllowances: "",
  pf: "",
  professionalTax: "",
  incomeTax: "",
  otherDeductions: "",
};

const BLANK_ITR_FORM = {
  assessmentYear: "",
  grossTotalIncome: "",
  deductionsChapterVIA: "",
  totalIncome: "",
  taxPayable: "",
  advanceTax: "",
  tds: "",
  tcs: "",
  selfAssessmentTax: "",
  refundOrDemand: "",
  filingDate: "",
  notes: "",
};

interface IndiaTaxReportProps {
  indiaTax: IndiaTaxData | undefined;
  onSave: (data: IndiaTaxData) => Promise<void>;
  fmt: (n: number) => string;
  uiTheme?: "classic" | "refresh";
}

export function IndiaTaxReport({ indiaTax, onSave, fmt, uiTheme }: IndiaTaxReportProps) {
  const payslipFileInputRef = useRef<HTMLInputElement>(null);
  const itrFileInputRef = useRef<HTMLInputElement>(null);
  const [payslipPassword, setPayslipPassword] = useState("");
  const [importingPayslips, setImportingPayslips] = useState(false);
  const [payslipImportErrors, setPayslipImportErrors] = useState<string[]>([]);
  const [payslipImportProgress, setPayslipImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [selectedFy, setSelectedFy] = useState<string | null>(null);
  const [reconstructForm, setReconstructForm] = useState(BLANK_RECONSTRUCTED_FORM);
  const [addingReconstructed, setAddingReconstructed] = useState(false);
  const [savingReconstructed, setSavingReconstructed] = useState(false);
  const [manualMonthForm, setManualMonthForm] = useState(BLANK_MANUAL_MONTH_FORM);
  const [addingManualMonth, setAddingManualMonth] = useState(false);
  const [savingManualMonth, setSavingManualMonth] = useState(false);

  const [itrPassword, setItrPassword] = useState("");
  const [importingItr, setImportingItr] = useState(false);
  const [itrImportErrors, setItrImportErrors] = useState<string[]>([]);
  const [itrImportProgress, setItrImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [selectedAy, setSelectedAy] = useState<string | null>(null);
  const [editingItrId, setEditingItrId] = useState<string | null>(null);
  const [itrForm, setItrForm] = useState(BLANK_ITR_FORM);
  const [savingItr, setSavingItr] = useState(false);

  const months = indiaTax?.payslips?.months ?? [];
  const fyList = Array.from(new Set(months.map((m) => fyOf(m.date)))).sort();
  const activeFy = selectedFy ?? fyList[fyList.length - 1] ?? null;
  const fyMonths = months.filter((m) => fyOf(m.date) === activeFy).sort((a, b) => a.date.localeCompare(b.date));
  const latestInFy = fyMonths[fyMonths.length - 1];

  const fyGross = fyMonths.reduce((s, m) => s + m.grossEarnings, 0);
  const fyDeductions = fyMonths.reduce((s, m) => s + m.totalDeductions, 0);
  const fyNet = fyMonths.reduce((s, m) => s + m.netPay, 0);
  const isReconstructedFy = fyMonths.length > 0 && fyMonths.every((m) => m.sourceFile === RECONSTRUCTED_SOURCE);

  const itrYears = (indiaTax?.itrYears ?? []).slice().sort((a, b) => b.assessmentYear.localeCompare(a.assessmentYear));
  const activeAy = selectedAy ?? itrYears[0]?.assessmentYear ?? null;
  const activeItrYear = itrYears.find((y) => y.assessmentYear === activeAy);
  const itrTaxesPaid = activeItrYear
    ? activeItrYear.advanceTax + activeItrYear.tds + activeItrYear.tcs + activeItrYear.selfAssessmentTax
    : 0;
  const itrEffectiveRate = activeItrYear && activeItrYear.grossTotalIncome > 0
    ? (activeItrYear.taxPayable / activeItrYear.grossTotalIncome) * 100
    : 0;

  const itrSummaryCards: { label: string; value: number; sub: string; icon: IconKind; color: string }[] = activeItrYear
    ? [
        { label: "Gross Total Income", value: activeItrYear.grossTotalIncome, sub: `AY ${activeItrYear.assessmentYear}`, icon: "cash", color: "#1e40af" },
        { label: "Ch VI-A Deductions", value: activeItrYear.deductionsChapterVIA, sub: "80C, 80D, etc.", icon: "shield", color: "#7c3aed" },
        { label: "Total Income", value: activeItrYear.totalIncome, sub: "taxable income", icon: "receipt", color: "#0891b2" },
        { label: "Tax Payable", value: activeItrYear.taxPayable, sub: `${itrEffectiveRate.toFixed(1)}% effective rate`, icon: "scale", color: "#dc2626" },
        { label: "TDS", value: activeItrYear.tds, sub: "tax deducted at source", icon: "bank", color: "#d97706" },
        { label: "Advance + Self-Assessment", value: activeItrYear.advanceTax + activeItrYear.selfAssessmentTax, sub: activeItrYear.tcs > 0 ? `+ ${fmt(activeItrYear.tcs)} TCS` : "paid directly", icon: "wallet", color: "#9333ea" },
        { label: "Taxes Paid (Total)", value: itrTaxesPaid, sub: "TDS + advance + self-assessment + TCS", icon: "trending-up", color: "#16a34a" },
        {
          label: activeItrYear.refundOrDemand >= 0 ? "Refund" : "Demand Payable",
          value: Math.abs(activeItrYear.refundOrDemand),
          sub: activeItrYear.filingDate ? `filed ${fmtDate(activeItrYear.filingDate)}` : "filing date not recorded",
          icon: "tag",
          color: activeItrYear.refundOrDemand >= 0 ? "#16a34a" : "#dc2626",
        },
      ]
    : [];

  async function handlePayslipImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = "";
    setPayslipImportErrors([]);
    setImportingPayslips(true);
    setPayslipImportProgress({ done: 0, total: files.length });
    try {
      const parsed: IndiaPayslipMonth[] = [];
      const errors: string[] = [];
      for (const file of files) {
        try {
          if (file.size === 0) throw new Error("empty file (0 bytes) — likely not downloaded locally yet; open it in the Drive app first, then retry");
          parsed.push(await parseIndiaPayslipFile(file, payslipPassword));
        } catch (err: any) {
          errors.push(`${file.name}: ${err?.message ?? "failed to parse"}`);
        }
        setPayslipImportProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
      }
      if (parsed.length > 0) {
        const merged = mergeIndiaPayslipMonths(months, parsed);
        try {
          await onSave({
            payslips: { months: merged, importedAt: new Date().toISOString() },
            itrYears: indiaTax?.itrYears ?? [],
          });
          setSelectedFy(fyOf(merged[merged.length - 1].date));
        } catch (err: any) {
          errors.unshift(`Saving to vault failed: ${err?.message ?? "unknown error"} — ${parsed.length} file(s) parsed OK but were NOT saved. Try again.`);
        }
      }
      setPayslipImportErrors(errors);
    } catch (err: any) {
      setPayslipImportErrors([`Import failed unexpectedly: ${err?.message ?? "unknown error"}`]);
    } finally {
      setImportingPayslips(false);
      setPayslipImportProgress(null);
    }
  }

  // For years where the real payslip PDFs no longer exist but an ITR was filed -- one annual
  // figure standing in for the missing months, clearly labeled so it's never mistaken for a
  // real payslip. Financial year "YYYY-YY" -> dated Apr 1 of the starting year so it sorts and
  // groups into the right FY bucket alongside real months.
  function openAddReconstructed() {
    setReconstructForm(BLANK_RECONSTRUCTED_FORM);
    setAddingReconstructed(true);
  }
  async function saveReconstructedForm() {
    const fy = reconstructForm.financialYear.trim();
    if (!/^\d{4}-\d{2}$/.test(fy)) return;
    setSavingReconstructed(true);
    try {
      const startYear = fy.slice(0, 4);
      const gross = Number(reconstructForm.grossEarnings) || 0;
      const tax = Number(reconstructForm.incomeTax) || 0;
      const employer = reconstructForm.employer.trim();
      // A FY split across two employers (job change mid-year) needs two entries, not one --
      // April 1 alone would collide (same date = same merge key, second save overwrites the
      // first). Walk forward a day at a time within April until an unused date turns up.
      let day = 1;
      const usedDates = new Set(months.map((m) => m.date));
      while (usedDates.has(`${startYear}-04-${String(day).padStart(2, "0")}`)) day++;
      const row: IndiaPayslipMonth = {
        label: employer ? `FY ${fy} — ${employer} (reconstructed)` : `FY ${fy} (reconstructed from ITR)`,
        date: `${startYear}-04-${String(day).padStart(2, "0")}`,
        basic: 0,
        hra: 0,
        conveyance: 0,
        otherAllowances: gross,
        grossEarnings: gross,
        pf: 0,
        professionalTax: 0,
        incomeTax: tax,
        otherDeductions: 0,
        totalDeductions: tax,
        netPay: gross - tax,
        sourceFile: RECONSTRUCTED_SOURCE,
      };
      const next = mergeIndiaPayslipMonths(months, [row]);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setSelectedFy(fy);
      setAddingReconstructed(false);
    } finally {
      setSavingReconstructed(false);
    }
  }
  async function deleteReconstructedFy(fy: string) {
    const next = months.filter((m) => fyOf(m.date) !== fy || m.sourceFile !== RECONSTRUCTED_SOURCE);
    await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
    setSelectedFy(null);
  }

  function openAddManualMonth() {
    setManualMonthForm(BLANK_MANUAL_MONTH_FORM);
    setAddingManualMonth(true);
  }
  async function saveManualMonthForm() {
    if (!/^\d{4}-\d{2}$/.test(manualMonthForm.month)) return;
    setSavingManualMonth(true);
    try {
      const n = (s: string) => Number(s) || 0;
      const [y, mm] = manualMonthForm.month.split("-");
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const basic = n(manualMonthForm.basic);
      const hra = n(manualMonthForm.hra);
      const otherAllowances = n(manualMonthForm.otherAllowances);
      const pf = n(manualMonthForm.pf);
      const professionalTax = n(manualMonthForm.professionalTax);
      const incomeTax = n(manualMonthForm.incomeTax);
      const otherDeductions = n(manualMonthForm.otherDeductions);
      const grossEarnings = basic + hra + otherAllowances;
      const totalDeductions = pf + professionalTax + incomeTax + otherDeductions;
      const row: IndiaPayslipMonth = {
        label: `${monthNames[Number(mm) - 1]} ${y}`,
        date: `${y}-${mm}-01`,
        basic,
        hra,
        conveyance: 0,
        otherAllowances,
        grossEarnings,
        pf,
        professionalTax,
        incomeTax,
        otherDeductions,
        totalDeductions,
        netPay: grossEarnings - totalDeductions,
        sourceFile: TRANSCRIBED_SOURCE_PREFIX,
      };
      const next = mergeIndiaPayslipMonths(months, [row]);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setSelectedFy(fyOf(row.date));
      setAddingManualMonth(false);
    } finally {
      setSavingManualMonth(false);
    }
  }

  async function handleItrImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = "";
    setItrImportErrors([]);
    setImportingItr(true);
    setItrImportProgress({ done: 0, total: files.length });
    try {
      const parsed: IndiaItrYear[] = [];
      const errors: string[] = [];
      for (const file of files) {
        try {
          if (file.size === 0) throw new Error("empty file (0 bytes) — likely not downloaded locally yet; open it in the Drive app first, then retry");
          const row = await parseIndiaItrFile(file, itrPassword);
          if (row) parsed.push({ ...row, id: uid() }); // null = Form 26AS, silently skipped
        } catch (err: any) {
          errors.push(`${file.name}: ${err?.message ?? "failed to parse"}`);
        }
        setItrImportProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
      }
      if (parsed.length > 0) {
        // A single import batch can mix document types for the same year -- an ITR-V/
        // Acknowledgement, a Receipt, and the full ITR Form -- with different fields reliably
        // extractable from each (the Form's page 1 often lacks TDS/refund; some legacy
        // Acknowledgements lack a few too). Resolve THAT conflict by keeping whichever of the
        // freshly-parsed candidates has more non-zero informative fields.
        //
        // That completeness check must NOT extend to whatever was already saved from a
        // PREVIOUS import, though -- a stale, since-fixed parsing bug could have saved a wrong
        // non-zero number that now outscores the correct (genuinely zero) re-parsed value,
        // silently keeping the bad data even after re-importing the exact same file. Once a
        // year has been freshly re-parsed in this batch, it always replaces whatever was on
        // file, full stop -- matching what the UI already promises ("re-importing a file for a
        // year already on record replaces it").
        const completeness = (y: IndiaItrYear) =>
          [y.grossTotalIncome, y.deductionsChapterVIA, y.totalIncome, y.taxPayable, y.advanceTax, y.tds, y.tcs, y.selfAssessmentTax, y.refundOrDemand]
            .filter((v) => v !== 0).length;
        const freshByYear = new Map<string, IndiaItrYear>();
        for (const row of parsed) {
          const existing = freshByYear.get(row.assessmentYear);
          if (!existing || completeness(row) >= completeness(existing)) freshByYear.set(row.assessmentYear, row);
        }
        const byYear = new Map((indiaTax?.itrYears ?? []).map((y) => [y.assessmentYear, y]));
        for (const row of freshByYear.values()) byYear.set(row.assessmentYear, row);
        const next = Array.from(byYear.values());
        try {
          await onSave({ payslips: indiaTax?.payslips, itrYears: next });
          setSelectedAy(parsed[parsed.length - 1].assessmentYear);
        } catch (err: any) {
          errors.unshift(`Saving to vault failed: ${err?.message ?? "unknown error"} — ${parsed.length} file(s) parsed OK but were NOT saved. Try again.`);
        }
      }
      setItrImportErrors(errors);
    } catch (err: any) {
      setItrImportErrors([`Import failed unexpectedly: ${err?.message ?? "unknown error"}`]);
    } finally {
      setImportingItr(false);
      setItrImportProgress(null);
    }
  }

  function openAddItr() {
    setItrForm(BLANK_ITR_FORM);
    setEditingItrId("new");
  }
  function openEditItr(y: IndiaItrYear) {
    setItrForm({
      assessmentYear: y.assessmentYear,
      grossTotalIncome: String(y.grossTotalIncome),
      deductionsChapterVIA: String(y.deductionsChapterVIA),
      totalIncome: String(y.totalIncome),
      taxPayable: String(y.taxPayable),
      advanceTax: String(y.advanceTax),
      tds: String(y.tds),
      tcs: String(y.tcs),
      selfAssessmentTax: String(y.selfAssessmentTax),
      refundOrDemand: String(y.refundOrDemand),
      filingDate: y.filingDate ?? "",
      notes: y.notes ?? "",
    });
    setEditingItrId(y.id);
  }
  async function saveItrForm() {
    if (!itrForm.assessmentYear.trim()) return;
    setSavingItr(true);
    try {
      const n = (s: string) => Number(s) || 0;
      const row: IndiaItrYear = {
        id: editingItrId === "new" ? uid() : editingItrId!,
        assessmentYear: itrForm.assessmentYear.trim(),
        grossTotalIncome: n(itrForm.grossTotalIncome),
        deductionsChapterVIA: n(itrForm.deductionsChapterVIA),
        totalIncome: n(itrForm.totalIncome),
        taxPayable: n(itrForm.taxPayable),
        advanceTax: n(itrForm.advanceTax),
        tds: n(itrForm.tds),
        tcs: n(itrForm.tcs),
        selfAssessmentTax: n(itrForm.selfAssessmentTax),
        refundOrDemand: n(itrForm.refundOrDemand),
        filingDate: itrForm.filingDate || undefined,
        notes: itrForm.notes || undefined,
      };
      const existing = indiaTax?.itrYears ?? [];
      const next = editingItrId === "new"
        ? [...existing, row]
        : existing.map((y) => (y.id === row.id ? row : y));
      await onSave({ payslips: indiaTax?.payslips, itrYears: next });
      setSelectedAy(row.assessmentYear);
      setEditingItrId(null);
    } finally {
      setSavingItr(false);
    }
  }
  async function deleteItr(id: string) {
    const next = (indiaTax?.itrYears ?? []).filter((y) => y.id !== id);
    await onSave({ payslips: indiaTax?.payslips, itrYears: next });
    setSelectedAy(null);
  }

  const fySummaryCards: { label: string; value: number; sub: string; icon: IconKind; color: string }[] = latestInFy
    ? [
        { label: "Gross Salary", value: fyGross, sub: `FY ${activeFy}, ${fyMonths.length} month(s)`, icon: "cash", color: "#1e40af" },
        { label: "Total Deductions", value: fyDeductions, sub: "PF + tax + other", icon: "receipt", color: "#dc2626" },
        { label: "Net Pay", value: fyNet, sub: "actually received", icon: "wallet", color: "#16a34a" },
        { label: "Projected Annual Income", value: latestInFy.annualIncome ?? 0, sub: `as of ${latestInFy.label}`, icon: "trending-up", color: "#0891b2" },
        { label: "80C + 80D", value: (latestInFy.section80C ?? 0) + (latestInFy.section80D ?? 0), sub: "Chapter VI-A investment relief", icon: "shield", color: "#7c3aed" },
        { label: "Total Tax Payable", value: latestInFy.totalTaxPayable ?? 0, sub: "projected, per employer", icon: "scale", color: "#9333ea" },
        { label: "Tax Deducted", value: latestInFy.taxDeductedTillDate ?? 0, sub: `till ${latestInFy.label}`, icon: "bank", color: "#d97706" },
        { label: "Balance Tax", value: latestInFy.balanceTax ?? 0, sub: "remaining per employer projection", icon: "tag", color: "#dc2626" },
      ]
    : [];

  return (
    <div className="data-panel tax-report">
      <div className="equity-section-head">
        <h4>Periodic Salary — India Payslips</h4>
      </div>

      {months.length === 0 ? (
        <div className="equity-seed-banner">
          <p className="equity-empty">No India payslips imported yet.</p>
          <input
            ref={payslipFileInputRef}
            type="file"
            accept=".pdf"
            multiple
            style={{ display: "none" }}
            onChange={handlePayslipImport}
          />
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
            <input
              type="password"
              placeholder="Payslip PDF password"
              value={payslipPassword}
              onChange={(e) => setPayslipPassword(e.target.value)}
              className="india-tax-input"
              style={{ maxWidth: 220 }}
            />
            <button
              className="equity-seed-btn"
              onClick={() => payslipFileInputRef.current?.click()}
              disabled={importingPayslips || !payslipPassword.trim()}
              title={!payslipPassword.trim() ? "Enter the payslip PDF password first" : undefined}
            >
              {importingPayslips ? `Importing… ${payslipImportProgress ? `${payslipImportProgress.done}/${payslipImportProgress.total}` : ""}` : "📄 Import Payslip PDFs"}
            </button>
            <button className="equity-seed-btn" onClick={openAddReconstructed}>
              ✏️ Add Reconstructed Year
            </button>
            <button className="equity-seed-btn" onClick={openAddManualMonth}>
              📝 Add Real Month (Manual)
            </button>
          </div>
          <p className="equity-seed-note">
            Select one or more TCS-style payslip PDFs — decrypted locally in your browser with the password above,
            never uploaded anywhere. Reads Basic, HRA, PF, Professional Tax, Income Tax, Net Pay, and the
            &quot;Projected Annual Tax Information&quot; box (80C, 80D, Total Tax Payable, Tax Deducted, Balance Tax).
            For years with no surviving payslip PDF, use &quot;Add Reconstructed Year&quot; to enter one annual
            figure (from an ITR, say) instead — clearly labeled as reconstructed, not a real payslip.
          </p>
        </div>
      ) : (
        <>
          <div className="equity-grant-filter">
            <span className="equity-grant-filter-label">FY:</span>
            {fyList.map((fy) => (
              <button
                key={fy}
                className={`equity-grant-filter-chip${activeFy === fy ? " equity-grant-filter-chip--active" : ""}`}
                onClick={() => setSelectedFy(fy)}
              >
                {fy}
              </button>
            ))}
            {isReconstructedFy && (
              <button onClick={() => activeFy && deleteReconstructedFy(activeFy)} title="Delete this reconstructed entry">
                🗑 Delete Reconstructed
              </button>
            )}
            <input
              ref={payslipFileInputRef}
              type="file"
              accept=".pdf"
              multiple
              style={{ display: "none" }}
              onChange={handlePayslipImport}
            />
            <button onClick={openAddReconstructed} style={{ marginLeft: "auto" }}>
              ✏️ Add Reconstructed Year
            </button>
            <button onClick={openAddManualMonth}>
              📝 Add Real Month (Manual)
            </button>
            <input
              type="password"
              placeholder="Payslip PDF password"
              value={payslipPassword}
              onChange={(e) => setPayslipPassword(e.target.value)}
              className="india-tax-input"
              style={{ maxWidth: 180 }}
            />
            <button
              onClick={() => payslipFileInputRef.current?.click()}
              disabled={importingPayslips || !payslipPassword.trim()}
              title={!payslipPassword.trim() ? "Enter the payslip PDF password first" : undefined}
            >
              {importingPayslips ? `Importing… ${payslipImportProgress ? `${payslipImportProgress.done}/${payslipImportProgress.total}` : ""}` : "↻ Import more payslips"}
            </button>
          </div>

          <div className="equity-summary-row">
            {fySummaryCards.map((c) => (
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

          <table className="equity-table equity-drilldown-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="right">Basic</th>
                <th className="right">HRA</th>
                <th className="right" title="Conveyance + all other allowances (Performance Pay, LTA, Personal Allowance, etc.), lumped together">Other Allowances</th>
                <th className="right">Gross</th>
                <th className="right">PF</th>
                <th className="right">Prof. Tax</th>
                <th className="right">Income Tax</th>
                <th className="right">Net Pay</th>
              </tr>
            </thead>
            <tbody>
              {fyMonths.map((m) => (
                <tr key={m.date}>
                  <td>{m.label}</td>
                  <td className="right">{fmt(m.basic)}</td>
                  <td className="right">{fmt(m.hra)}</td>
                  <td className="right">{fmt(m.conveyance + m.otherAllowances)}</td>
                  <td className="right">{fmt(m.grossEarnings)}</td>
                  <td className="right">{fmt(m.pf)}</td>
                  <td className="right">{fmt(m.professionalTax)}</td>
                  <td className="right">{fmt(m.incomeTax)}</td>
                  <td className="right">{fmt(m.netPay)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.basic, 0))}</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.hra, 0))}</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.conveyance + m.otherAllowances, 0))}</td>
                <td className="right">{fmt(fyGross)}</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.pf, 0))}</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.professionalTax, 0))}</td>
                <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.incomeTax, 0))}</td>
                <td className="right">{fmt(fyNet)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}

      {payslipImportErrors.length > 0 && (
        <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>
          {payslipImportErrors.length} file(s) failed: {payslipImportErrors.join("; ")}
        </p>
      )}

      <div className="equity-section-head" style={{ marginTop: "1.5rem" }}>
        <h4>Annual Tax Return Archive (by Assessment Year)</h4>
      </div>

      <div className="equity-grant-filter" style={{ flexWrap: "nowrap", overflowX: "auto" }}>
        {itrYears.length > 0 && (
          <>
            <span className="equity-grant-filter-label" style={{ flexShrink: 0 }}>AY:</span>
            <select
              value={activeAy ?? ""}
              onChange={(e) => setSelectedAy(e.target.value)}
              className="india-tax-input"
              style={{ flexShrink: 0, fontWeight: 600 }}
            >
              {itrYears.map((y) => (
                <option key={y.id} value={y.assessmentYear}>{y.assessmentYear}</option>
              ))}
            </select>
            {activeItrYear && (
              <span style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                <button onClick={() => openEditItr(activeItrYear)}>Edit</button>
                <button onClick={() => deleteItr(activeItrYear.id)}>Delete</button>
              </span>
            )}
          </>
        )}
        <input
          ref={itrFileInputRef}
          type="file"
          accept=".pdf"
          multiple
          style={{ display: "none" }}
          onChange={handleItrImport}
        />
        <input
          type="password"
          placeholder="ITR password"
          title="ITR PDF password (older years only)"
          value={itrPassword}
          onChange={(e) => setItrPassword(e.target.value)}
          className="india-tax-input"
          style={{ width: 110, flexShrink: 0, marginLeft: "auto" }}
        />
        <button onClick={() => itrFileInputRef.current?.click()} disabled={importingItr} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
          {importingItr ? `Importing… ${itrImportProgress ? `${itrImportProgress.done}/${itrImportProgress.total}` : ""}` : "📄 Import ITR PDFs"}
        </button>
        <button onClick={openAddItr} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>+ Add Year</button>
      </div>
      <p className="equity-seed-note" style={{ margin: "0 0 0.5rem" }}>
        Select one or more ITR-V / Acknowledgement / Receipt PDFs — most recent downloads aren&apos;t
        password-protected, older ones (pre-~2016) usually need PAN + DOB. Re-importing a file for a year
        already on record replaces it. Use &quot;+ Add Year&quot; only for a year the auto-import can&apos;t read.
      </p>

      {itrImportErrors.length > 0 && (
        <p className="equity-pdf-error" style={{ marginBottom: "0.5rem" }}>
          {itrImportErrors.length} file(s) failed: {itrImportErrors.join("; ")}
        </p>
      )}

      {itrYears.length === 0 ? (
        <p className="equity-empty">No tax years recorded yet.</p>
      ) : (
        <>
          <div className="equity-summary-row">
            {itrSummaryCards.map((c) => (
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
          {activeItrYear?.notes && (
            <p className="equity-seed-note" style={{ margin: "0.5rem 0 0" }}>
              Notes: {activeItrYear.notes}
            </p>
          )}
        </>
      )}

      {editingItrId && (
        <Modal title={editingItrId === "new" ? "Add Tax Year" : `Edit AY ${itrForm.assessmentYear}`} onClose={() => setEditingItrId(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
            <label style={{ fontSize: 12 }}>
              Assessment Year (e.g. 2018-19)
              <input value={itrForm.assessmentYear} onChange={(e) => setItrForm({ ...itrForm, assessmentYear: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Filing Date
              <input type="date" value={itrForm.filingDate} onChange={(e) => setItrForm({ ...itrForm, filingDate: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Gross Total Income
              <input type="number" value={itrForm.grossTotalIncome} onChange={(e) => setItrForm({ ...itrForm, grossTotalIncome: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Deductions (Chapter VI-A)
              <input type="number" value={itrForm.deductionsChapterVIA} onChange={(e) => setItrForm({ ...itrForm, deductionsChapterVIA: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Total Income
              <input type="number" value={itrForm.totalIncome} onChange={(e) => setItrForm({ ...itrForm, totalIncome: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Tax Payable
              <input type="number" value={itrForm.taxPayable} onChange={(e) => setItrForm({ ...itrForm, taxPayable: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Advance Tax
              <input type="number" value={itrForm.advanceTax} onChange={(e) => setItrForm({ ...itrForm, advanceTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              TDS
              <input type="number" value={itrForm.tds} onChange={(e) => setItrForm({ ...itrForm, tds: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              TCS
              <input type="number" value={itrForm.tcs} onChange={(e) => setItrForm({ ...itrForm, tcs: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Self Assessment Tax
              <input type="number" value={itrForm.selfAssessmentTax} onChange={(e) => setItrForm({ ...itrForm, selfAssessmentTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Refund (+) / Demand (-)
              <input type="number" value={itrForm.refundOrDemand} onChange={(e) => setItrForm({ ...itrForm, refundOrDemand: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Notes
              <input value={itrForm.notes} onChange={(e) => setItrForm({ ...itrForm, notes: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
          </div>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setEditingItrId(null)}>Cancel</button>
            <button onClick={saveItrForm} disabled={savingItr || !itrForm.assessmentYear.trim()}>
              {savingItr ? "Saving…" : "Save"}
            </button>
          </div>
        </Modal>
      )}

      {addingReconstructed && (
        <Modal title="Add Reconstructed Year" onClose={() => setAddingReconstructed(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            For a year with no surviving payslip PDF — enter one annual gross and tax figure (e.g. from that
            year&apos;s ITR or ledger). Saved as an entry clearly labeled &quot;reconstructed&quot;, not a real
            payslip. If a financial year had more than one employer, add one entry per employer — they won&apos;t
            overwrite each other.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
            <label style={{ fontSize: 12 }}>
              Financial Year (e.g. 2007-08)
              <input
                value={reconstructForm.financialYear}
                onChange={(e) => setReconstructForm({ ...reconstructForm, financialYear: e.target.value })}
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Employer (optional)
              <input
                value={reconstructForm.employer}
                onChange={(e) => setReconstructForm({ ...reconstructForm, employer: e.target.value })}
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Gross Annual Income
              <input
                type="number"
                value={reconstructForm.grossEarnings}
                onChange={(e) => setReconstructForm({ ...reconstructForm, grossEarnings: e.target.value })}
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Income Tax Paid
              <input
                type="number"
                value={reconstructForm.incomeTax}
                onChange={(e) => setReconstructForm({ ...reconstructForm, incomeTax: e.target.value })}
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
          </div>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setAddingReconstructed(false)}>Cancel</button>
            <button onClick={saveReconstructedForm} disabled={savingReconstructed || !/^\d{4}-\d{2}$/.test(reconstructForm.financialYear.trim())}>
              {savingReconstructed ? "Saving…" : "Save"}
            </button>
          </div>
        </Modal>
      )}

      {addingManualMonth && (
        <Modal title="Add Real Month (Manual)" onClose={() => setAddingManualMonth(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            For a real payslip that only exists as a scanned image (no text layer to auto-read) — enter the figures
            by hand, same fields as an auto-imported month.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
            <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Month
              <input
                type="month"
                value={manualMonthForm.month}
                onChange={(e) => setManualMonthForm({ ...manualMonthForm, month: e.target.value })}
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Basic Salary
              <input type="number" value={manualMonthForm.basic} onChange={(e) => setManualMonthForm({ ...manualMonthForm, basic: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              HRA
              <input type="number" value={manualMonthForm.hra} onChange={(e) => setManualMonthForm({ ...manualMonthForm, hra: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Other Allowances
              <input type="number" value={manualMonthForm.otherAllowances} onChange={(e) => setManualMonthForm({ ...manualMonthForm, otherAllowances: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              PF
              <input type="number" value={manualMonthForm.pf} onChange={(e) => setManualMonthForm({ ...manualMonthForm, pf: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Professional Tax
              <input type="number" value={manualMonthForm.professionalTax} onChange={(e) => setManualMonthForm({ ...manualMonthForm, professionalTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Income Tax (TDS)
              <input type="number" value={manualMonthForm.incomeTax} onChange={(e) => setManualMonthForm({ ...manualMonthForm, incomeTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Other Deductions
              <input type="number" value={manualMonthForm.otherDeductions} onChange={(e) => setManualMonthForm({ ...manualMonthForm, otherDeductions: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
          </div>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setAddingManualMonth(false)}>Cancel</button>
            <button onClick={saveManualMonthForm} disabled={savingManualMonth || !/^\d{4}-\d{2}$/.test(manualMonthForm.month)}>
              {savingManualMonth ? "Saving…" : "Save"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
