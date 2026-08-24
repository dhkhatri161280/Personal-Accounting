"use client";
import { useRef, useState } from "react";
import type { IndiaTaxData, IndiaPayslipMonth, IndiaItrYear } from "@/lib/vault-types";
import { parseIndiaPayslipFile, mergeIndiaPayslipMonths } from "@/lib/parse-india-payslip";
import { parseIndiaItrFile } from "@/lib/parse-india-itr";
import { StatIcon, type IconKind } from "@/components/Icon";
import { fmtDate } from "@/lib/format-date";
import { estimateIndiaTax, hasIndiaTaxSlabsFor, section80CCap, SECTION_80D_CAP } from "@/lib/india-tax-slabs";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// India's financial year runs Apr-Mar, one year "behind" the Assessment Year an ITR is filed
// under (income earned in FY 2013-14 is assessed/filed as AY 2014-15).
function fyOf(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  return m >= 4 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}
// One selector drives both sections: picking a Financial Year (payroll) derives the matching
// Assessment Year (the ITR filed on that year's income) instead of keeping two independent
// year pickers that can point at unrelated years.
function ayOfFy(fy: string): string {
  const startYear = Number(fy.slice(0, 4));
  return `${startYear + 1}-${String(startYear + 2).slice(-2)}`;
}
function fyOfAy(ay: string): string {
  const startYear = Number(ay.slice(0, 4));
  return `${startYear - 1}-${String(startYear).slice(-2)}`;
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

// A real per-month total pulled from the Tally ledger's "Salary Income" account -- not a real
// payslip (no Basic/HRA/PF breakdown, just the one figure the ledger recorded), but real actual
// monthly data rather than an annual estimate, so it gets its own source tag distinct from both.
const LEDGER_MONTH_SOURCE = "Manual entry — monthly total from Tally ledger salary account";

const BLANK_MANUAL_MONTH_FORM = {
  month: "", // YYYY-MM, from an <input type="month">
  employer: "",
  basic: "",
  hra: "",
  otherAllowances: "",
  pf: "",
  professionalTax: "",
  incomeTax: "",
  otherDeductions: "",
  copyToMonths: "", // comma-separated YYYY-MM list -- same values also saved to each of these
};

const BLANK_ITR_FORM = {
  assessmentYear: "",
  grossTotalIncome: "",
  deductionsChapterVIA: "",
  taxPayable: "",
  advanceTax: "",
  tds: "",
  tcs: "",
  selfAssessmentTax: "",
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
  const [bulkReconstructText, setBulkReconstructText] = useState("");
  const [bulkReconstructError, setBulkReconstructError] = useState("");
  const [addingBulkReconstructed, setAddingBulkReconstructed] = useState(false);
  const [savingBulkReconstructed, setSavingBulkReconstructed] = useState(false);
  const [bulkMonthsText, setBulkMonthsText] = useState("");
  const [bulkMonthsError, setBulkMonthsError] = useState("");
  const [addingBulkMonths, setAddingBulkMonths] = useState(false);
  const [savingBulkMonths, setSavingBulkMonths] = useState(false);
  const [manualMonthForm, setManualMonthForm] = useState(BLANK_MANUAL_MONTH_FORM);
  const [addingManualMonth, setAddingManualMonth] = useState(false);
  const [savingManualMonth, setSavingManualMonth] = useState(false);
  const [editingManualMonth, setEditingManualMonth] = useState<IndiaPayslipMonth | null>(null);
  const [addingSection80, setAddingSection80] = useState(false);
  const [savingSection80, setSavingSection80] = useState(false);
  const [section80Items, setSection80Items] = useState<{ description: string; amount: string }[]>([]);
  const [section80DForm, setSection80DForm] = useState("");
  const [reconcilingGti, setReconcilingGti] = useState(false);
  const [savingGti, setSavingGti] = useState(false);
  const [gtiGrossSalary, setGtiGrossSalary] = useState("");
  const [gtiHraExempt, setGtiHraExempt] = useState("");
  const [gtiProfTax, setGtiProfTax] = useState("");
  const [gtiStcg, setGtiStcg] = useState("");
  const [gtiLtcg, setGtiLtcg] = useState("");
  const [deletingManualMonth, setDeletingManualMonth] = useState(false);

  const [itrPassword, setItrPassword] = useState("");
  const [importingItr, setImportingItr] = useState(false);
  const [itrImportErrors, setItrImportErrors] = useState<string[]>([]);
  const [itrImportProgress, setItrImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [editingItrId, setEditingItrId] = useState<string | null>(null);
  const [itrForm, setItrForm] = useState(BLANK_ITR_FORM);
  const [savingItr, setSavingItr] = useState(false);

  const months = indiaTax?.payslips?.months ?? [];
  const itrYears = (indiaTax?.itrYears ?? []).slice().sort((a, b) => b.assessmentYear.localeCompare(a.assessmentYear));
  // A year with only an ITR on file (no payslip data) must still be reachable from this one
  // selector -- union both sources rather than driving the list off payslip months alone.
  const fyList = Array.from(new Set([
    ...months.map((m) => fyOf(m.date)),
    ...itrYears.map((y) => fyOfAy(y.assessmentYear)),
  ])).sort();
  const activeFy = selectedFy ?? fyList[fyList.length - 1] ?? null;
  const fyMonths = months.filter((m) => fyOf(m.date) === activeFy).sort((a, b) => a.date.localeCompare(b.date));
  const latestInFy = fyMonths[fyMonths.length - 1];

  const fyGross = fyMonths.reduce((s, m) => s + m.grossEarnings, 0);
  const fyDeductions = fyMonths.reduce((s, m) => s + m.totalDeductions, 0);
  const fyNet = fyMonths.reduce((s, m) => s + m.netPay, 0);
  const fyHraTotal = fyMonths.reduce((s, m) => s + m.hra, 0);
  const fyProfTaxTotal = fyMonths.reduce((s, m) => s + m.professionalTax, 0);
  const fyIncomeTaxTotal = fyMonths.reduce((s, m) => s + m.incomeTax, 0);
  const fyPfTotal = fyMonths.reduce((s, m) => s + m.pf, 0);
  const isReconstructedFy = fyMonths.length > 0 && fyMonths.every((m) => m.sourceFile === RECONSTRUCTED_SOURCE);

  const activeAy = activeFy ? ayOfFy(activeFy) : (itrYears[0]?.assessmentYear ?? null);
  const activeItrYear = itrYears.find((y) => y.assessmentYear === activeAy);
  const itrTaxesPaid = activeItrYear
    ? activeItrYear.advanceTax + activeItrYear.tds + activeItrYear.tcs + activeItrYear.selfAssessmentTax
    : 0;
  const itrEffectiveRate = activeItrYear && activeItrYear.grossTotalIncome > 0
    ? (activeItrYear.taxPayable / activeItrYear.grossTotalIncome) * 100
    : 0;
  // Refund/Demand is pure arithmetic from figures already on this card row (taxes paid minus tax
  // payable) -- no tax-law judgment involved, so it's always computed here rather than trusted
  // as a separately-typed field that can silently drift out of sync with the other two.
  const itrRefundOrDemand = activeItrYear ? itrTaxesPaid - activeItrYear.taxPayable : 0;
  // Capital gains are taxed at special flat rates (STCG under 111A, LTCG under 112/112A), not
  // the individual's slab rate -- the slab estimator below only models ordinary/salary-rate
  // taxation, so a year with capital gains on file gets no estimate at all rather than a
  // confidently wrong one that silently taxed the gain at the slab rate.
  const hasCapitalGains = !!(activeItrYear?.capitalGains && (activeItrYear.capitalGains.shortTerm !== 0 || activeItrYear.capitalGains.longTerm !== 0));
  // Tax Payable itself IS a real filed/legal figure (kept as entered, not overwritten) -- but a
  // slab-based estimate is still useful as a cross-check, and to pre-fill when adding a year by
  // hand. Only offered for Assessment Years whose slabs are actually modeled.
  const estimatedTaxPayable = activeItrYear && !hasCapitalGains && hasIndiaTaxSlabsFor(activeItrYear.assessmentYear)
    ? estimateIndiaTax(activeItrYear.assessmentYear, activeItrYear.totalIncome)
    : null;
  // Raw = exactly what was invested/paid, even past the statutory cap (real information worth
  // keeping). Capped = what's actually claimable -- Section 80C's combined cap (LIC, NSC, PPF,
  // PF, ELSS, etc. all count against ONE limit) and 80D's cap, both year-aware.
  const section80CTotalRaw = (activeItrYear?.section80CItems ?? []).reduce((s, it) => s + it.amount, 0);
  const section80DTotalRaw = activeItrYear?.section80DMedical ?? 0;
  const section80CCapForAy = activeAy ? section80CCap(activeAy) : 100000;
  const section80CTotal = Math.min(section80CTotalRaw, section80CCapForAy);
  const section80DTotal = Math.min(section80DTotalRaw, SECTION_80D_CAP);
  const section80OverCap = section80CTotalRaw > section80CCapForAy || section80DTotalRaw > SECTION_80D_CAP;
  // If the itemized 80C/80D table has never been touched for this year (e.g. deductionsChapterVIA
  // was set directly, from a real filed ITR entered before this itemized-table feature existed),
  // fall back to that lump figure for display rather than showing 0 while the ITR section right
  // below shows the real total -- saveItrForm reconciles this into real itemized data the next
  // time the ITR form saves, so this fallback is purely cosmetic, never persisted. The lump
  // figure is trusted as-is here (already the claimable amount as filed), not re-capped.
  //
  // The payroll-row "80C + 80D" card shows the RAW total (what was actually invested/paid) --
  // the 80C/80D caps are a Ch VI-A Deductions/tax-liability concept, so they only apply to the
  // ITR section's own card and the figures that feed the tax math, not this one.
  const section80RawDisplayTotal = section80CTotalRaw + section80DTotalRaw !== 0
    ? section80CTotalRaw + section80DTotalRaw
    : (activeItrYear?.deductionsChapterVIA ?? 0);
  // Estimated Gross Total Income before the reconciliation form has ever been saved for this FY
  // -- same formula (Gross Salary - HRA exempt - Professional Tax + capital gains), defaulting
  // HRA exempt to the full HRA paid, so the card has a sensible value from day one instead of
  // showing 0.
  const estimatedGti = Math.max(0,
    (activeItrYear?.grossSalaryOverride ?? fyGross) - (activeItrYear?.hraExemptOverride ?? fyHraTotal) - (activeItrYear?.professionalTaxOverride ?? fyProfTaxTotal)
  ) + (activeItrYear?.capitalGains?.shortTerm ?? 0) + (activeItrYear?.capitalGains?.longTerm ?? 0);

  const itrSummaryCards: { label: string; value: number; sub: string; icon: IconKind; color: string; onClick?: () => void }[] = activeItrYear
    ? [
        {
          label: "Gross Total Income", value: activeItrYear.grossTotalIncome,
          sub: `AY ${activeItrYear.assessmentYear} — Gross − HRA exempt − Prof. Tax${hasCapitalGains ? " + capital gains" : ""}, click to recompute →`,
          icon: "cash", color: "#1e40af", onClick: openGtiForm,
        },
        {
          label: "Ch VI-A Deductions", value: activeItrYear.deductionsChapterVIA, sub: "80C, 80D, etc. — click to edit itemized detail →",
          icon: "shield", color: "#7c3aed", onClick: open80cForm,
        },
        { label: "Total Income", value: activeItrYear.totalIncome, sub: "taxable income", icon: "receipt", color: "#0891b2" },
        {
          label: "Tax Payable", value: activeItrYear.taxPayable,
          sub: hasCapitalGains
            ? `${itrEffectiveRate.toFixed(1)}% effective rate — no slab estimate (capital gains taxed at special rates)`
            : estimatedTaxPayable == null
              ? `${itrEffectiveRate.toFixed(1)}% effective rate`
              : Math.abs(estimatedTaxPayable - activeItrYear.taxPayable) <= 10
                ? `${itrEffectiveRate.toFixed(1)}% effective rate — matches slab estimate`
                : `${itrEffectiveRate.toFixed(1)}% effective rate — slab estimate: ${fmt(estimatedTaxPayable)}`,
          icon: "scale", color: "#dc2626",
        },
        { label: "TDS", value: activeItrYear.tds, sub: "tax deducted at source", icon: "bank", color: "#d97706" },
        { label: "Advance + Self-Assessment", value: activeItrYear.advanceTax + activeItrYear.selfAssessmentTax, sub: activeItrYear.tcs > 0 ? `+ ${fmt(activeItrYear.tcs)} TCS` : "paid directly", icon: "wallet", color: "#9333ea" },
        { label: "Taxes Paid (Total)", value: itrTaxesPaid, sub: "TDS + advance + self-assessment + TCS", icon: "trending-up", color: "#16a34a" },
        {
          label: itrRefundOrDemand >= 0 ? "Refund" : "Demand Payable",
          value: Math.abs(itrRefundOrDemand),
          sub: `Taxes Paid − Tax Payable${activeItrYear.filingDate ? ` — filed ${fmtDate(activeItrYear.filingDate)}` : ""}`,
          icon: "tag",
          color: itrRefundOrDemand >= 0 ? "#16a34a" : "#dc2626",
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
  // A FY split across two employers (job change mid-year) needs two entries, not one -- April 1
  // alone would collide (same date = same merge key). Give each EMPLOYER a fixed day-of-month
  // (deterministic, not "next free slot") so the same employer+period always maps to the same
  // date no matter how many times it's pasted -- re-pasting the same row must overwrite it in
  // place, not walk forward to a new day and create a duplicate alongside the original.
  function dayForEmployer(employer: string): number {
    if (!employer) return 1;
    let hash = 0;
    for (let i = 0; i < employer.length; i++) hash = (hash * 31 + employer.charCodeAt(i)) % 27;
    return hash + 2; // 2-28, keeps day 1 reserved for the no-employer case
  }
  function buildReconstructedRow(fy: string, employer: string, gross: number, tax: number): IndiaPayslipMonth {
    const startYear = fy.slice(0, 4);
    const date = `${startYear}-04-${String(dayForEmployer(employer)).padStart(2, "0")}`;
    return {
      label: employer ? `FY ${fy} — ${employer} (reconstructed)` : `FY ${fy} (reconstructed from ITR)`,
      date,
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
  }
  async function saveReconstructedForm() {
    const fy = reconstructForm.financialYear.trim();
    if (!/^\d{4}-\d{2}$/.test(fy)) return;
    setSavingReconstructed(true);
    try {
      const gross = Number(reconstructForm.grossEarnings) || 0;
      const tax = Number(reconstructForm.incomeTax) || 0;
      const employer = reconstructForm.employer.trim();
      const row = buildReconstructedRow(fy, employer, gross, tax);
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
  // Recovery for the pre-fix duplicate-date bug: wipes every entry for a FY regardless of
  // source (reconstructed, ledger-derived, or transcribed), so a corrupted year can be re-pasted
  // clean from scratch instead of hand-deleting each duplicate row.
  async function clearFy(fy: string) {
    const next = months.filter((m) => fyOf(m.date) !== fy);
    await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
    setSelectedFy(null);
  }

  function openBulkAddReconstructed() {
    setBulkReconstructText("");
    setBulkReconstructError("");
    setAddingBulkReconstructed(true);
  }
  // One row per line: "FY, Employer, Gross[, Tax]" -- comma, tab, or pipe separated, employer
  // and tax both optional. Parses everything first and bails with no save at all if any line is
  // bad, rather than saving a partial batch silently.
  function parseBulkReconstructLines(text: string): { rows: { fy: string; employer: string; gross: number; tax: number }[]; error: string } {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const rows: { fy: string; employer: string; gross: number; tax: number }[] = [];
    for (const line of lines) {
      const parts = line.split(/[,\t|]/).map((p) => p.trim());
      const fy = parts[0] ?? "";
      if (!/^\d{4}-\d{2}$/.test(fy)) return { rows: [], error: `Bad line (expected "FY, Employer, Gross[, Tax]"): "${line}"` };
      const employer = parts[1] ?? "";
      const gross = Number(parts[2]);
      if (!Number.isFinite(gross)) return { rows: [], error: `Bad gross income (expected "FY, Employer, Gross[, Tax]"): "${line}"` };
      const tax = parts[3] ? Number(parts[3]) : 0;
      if (!Number.isFinite(tax)) return { rows: [], error: `Bad tax figure (expected "FY, Employer, Gross[, Tax]"): "${line}"` };
      rows.push({ fy, employer, gross, tax });
    }
    return { rows, error: "" };
  }
  async function saveBulkReconstructed() {
    const { rows, error } = parseBulkReconstructLines(bulkReconstructText);
    if (error) { setBulkReconstructError(error); return; }
    if (rows.length === 0) { setBulkReconstructError("Paste at least one row."); return; }
    setSavingBulkReconstructed(true);
    try {
      const newRows = rows.map((r) => buildReconstructedRow(r.fy, r.employer, r.gross, r.tax));
      const next = mergeIndiaPayslipMonths(months, newRows);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setSelectedFy(rows[rows.length - 1].fy);
      setAddingBulkReconstructed(false);
    } finally {
      setSavingBulkReconstructed(false);
    }
  }

  function openBulkAddMonths() {
    setBulkMonthsText("");
    setBulkMonthsError("");
    setAddingBulkMonths(true);
  }
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  interface LedgerMonthRowInput {
    ym: string; employer: string; basic: number; hra: number; other: number; pf: number; professionalTax: number; incomeTax: number; otherDeductions: number; note: string;
  }
  function buildLedgerMonthRow(r: LedgerMonthRowInput): IndiaPayslipMonth {
    const [y, m] = r.ym.split("-");
    const date = `${y}-${m}-${String(dayForEmployer(r.employer)).padStart(2, "0")}`;
    const grossEarnings = r.basic + r.hra + r.other;
    const totalDeductions = r.pf + r.professionalTax + r.incomeTax + r.otherDeductions;
    const labelSuffix = r.note ? ` — ${r.note}` : "";
    return {
      label: r.employer ? `${MONTH_NAMES[Number(m) - 1]} ${y} — ${r.employer} (from ledger)${labelSuffix}` : `${MONTH_NAMES[Number(m) - 1]} ${y} (from ledger)${labelSuffix}`,
      date,
      basic: r.basic,
      hra: r.hra,
      conveyance: 0,
      otherAllowances: r.other,
      grossEarnings,
      pf: r.pf,
      professionalTax: r.professionalTax,
      incomeTax: r.incomeTax,
      otherDeductions: r.otherDeductions,
      totalDeductions,
      netPay: grossEarnings - totalDeductions,
      sourceFile: LEDGER_MONTH_SOURCE,
    };
  }
  // One row per line: "YYYY-MM, Employer, Basic, HRA, Other, PF, ProfTax, IncomeTax, OtherDeductions[, Note]"
  // -- comma, tab, or pipe separated. Basic/HRA/PF/ProfTax/IncomeTax/OtherDeductions default to 0
  // if blank (a lump total with no known breakdown just goes entirely in Other). OtherDeductions
  // is for a specifically identified deduction that isn't PF/ProfTax/IncomeTax (e.g. an LIP/
  // Superannuation contribution) -- same bail-on-any-bad-line behavior as the FY bulk-add, so a
  // typo can't silently save a partial batch.
  function parseBulkMonthsLines(text: string): { rows: LedgerMonthRowInput[]; error: string } {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const rows: LedgerMonthRowInput[] = [];
    for (const line of lines) {
      const parts = line.split(/[,\t|]/).map((p) => p.trim());
      const ym = parts[0] ?? "";
      const USAGE = `expected "YYYY-MM, Employer, Basic, HRA, Other, PF, ProfTax, IncomeTax, OtherDeductions"`;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return { rows: [], error: `Bad month (${USAGE}): "${line}"` };
      const employer = parts[1] ?? "";
      // Read by explicit position (not array destructuring) so a line with fewer trailing
      // commas than fields still defaults the missing ones to 0 instead of NaN.
      const at = (i: number) => (parts[i] ? Number(parts[i]) : 0);
      const [basic, hra, other, pf, professionalTax, incomeTax, otherDeductions] = [2, 3, 4, 5, 6, 7, 8].map(at);
      if ([basic, hra, other, pf, professionalTax, incomeTax, otherDeductions].some((n) => !Number.isFinite(n))) {
        return { rows: [], error: `Bad number (${USAGE}): "${line}"` };
      }
      const note = parts[9] ?? "";
      rows.push({ ym, employer, basic, hra, other, pf, professionalTax, incomeTax, otherDeductions, note });
    }
    return { rows, error: "" };
  }
  // Real month-level data always supersedes a coarser annual "reconstructed" estimate for the
  // same financial year -- if both exist at once, the FY's totals silently double count (the
  // annual figure was ALREADY the sum of what the real months now also represent). Whenever
  // real months are added, drop any reconstructed-year entries for the FYs those months fall
  // into automatically, rather than relying on remembering to delete the old one first.
  function dropReconstructedFor(monthsArr: IndiaPayslipMonth[], touchedFys: Set<string>): IndiaPayslipMonth[] {
    return monthsArr.filter((m) => !(m.sourceFile === RECONSTRUCTED_SOURCE && touchedFys.has(fyOf(m.date))));
  }
  async function saveBulkMonths() {
    const { rows, error } = parseBulkMonthsLines(bulkMonthsText);
    if (error) { setBulkMonthsError(error); return; }
    if (rows.length === 0) { setBulkMonthsError("Paste at least one row."); return; }
    setSavingBulkMonths(true);
    try {
      const newRows = rows.map((r) => buildLedgerMonthRow(r));
      const touchedFys = new Set(newRows.map((r) => fyOf(r.date)));
      const base = dropReconstructedFor(months, touchedFys);
      const next = mergeIndiaPayslipMonths(base, newRows);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setSelectedFy(fyOf(newRows[newRows.length - 1].date));
      setAddingBulkMonths(false);
    } finally {
      setSavingBulkMonths(false);
    }
  }

  // Pulls the employer back out of a generated label so editing a row can re-save under the
  // same employer without the user retyping it -- handles both "Aug 2005 — Mafatlal (from
  // ledger)" (parenthetical suffix) and "Apr 2007 — Mafatlal" (bare, from this same manual-month
  // tool) forms. Getting this wrong silently drops the employer to blank on edit, which then
  // hashes to a different date than the original row and creates a duplicate instead of an
  // overwrite -- so this one regex is load-bearing for the whole click-to-edit feature.
  function employerFromLabel(label: string): string {
    const m = label.match(/—\s*([^(]+?)\s*(?:\(.*\))?\s*$/);
    return m ? m[1].trim() : "";
  }
  function openAddManualMonth() {
    setManualMonthForm(BLANK_MANUAL_MONTH_FORM);
    setEditingManualMonth(null);
    setDeletingManualMonth(false);
    setAddingManualMonth(true);
  }
  function openEditManualMonth(m: IndiaPayslipMonth) {
    setManualMonthForm({
      month: m.date.slice(0, 7),
      employer: employerFromLabel(m.label),
      basic: String(m.basic),
      hra: String(m.hra),
      otherAllowances: String(m.otherAllowances),
      pf: String(m.pf),
      professionalTax: String(m.professionalTax),
      incomeTax: String(m.incomeTax),
      otherDeductions: String(m.otherDeductions),
      copyToMonths: "",
    });
    setEditingManualMonth(m);
    setDeletingManualMonth(false);
    setAddingManualMonth(true);
  }
  function buildManualMonthRow(ym: string, form: typeof BLANK_MANUAL_MONTH_FORM, sourceFile: string): IndiaPayslipMonth {
    const n = (s: string) => Number(s) || 0;
    const [y, mm] = ym.split("-");
    const employer = form.employer.trim();
    const basic = n(form.basic);
    const hra = n(form.hra);
    const otherAllowances = n(form.otherAllowances);
    const pf = n(form.pf);
    const professionalTax = n(form.professionalTax);
    const incomeTax = n(form.incomeTax);
    const otherDeductions = n(form.otherDeductions);
    const grossEarnings = basic + hra + otherAllowances;
    const totalDeductions = pf + professionalTax + incomeTax + otherDeductions;
    return {
      label: employer ? `${MONTH_NAMES[Number(mm) - 1]} ${y} — ${employer}` : `${MONTH_NAMES[Number(mm) - 1]} ${y}`,
      date: `${y}-${mm}-${String(dayForEmployer(employer)).padStart(2, "0")}`,
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
      sourceFile,
    };
  }
  async function saveManualMonthForm() {
    if (!/^\d{4}-\d{2}$/.test(manualMonthForm.month)) return;
    const copyMonths = manualMonthForm.copyToMonths
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const badCopyMonth = copyMonths.find((ym) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym));
    if (badCopyMonth) { alert(`Bad month in "Also apply to": "${badCopyMonth}" (expected YYYY-MM)`); return; }
    setSavingManualMonth(true);
    try {
      const sourceFile = editingManualMonth?.sourceFile ?? TRANSCRIBED_SOURCE_PREFIX;
      const targetMonths = Array.from(new Set([manualMonthForm.month, ...copyMonths]));
      const newRows = targetMonths.map((ym) => buildManualMonthRow(ym, manualMonthForm, sourceFile));
      // Editing or copying into a month replaces whatever's already on file for that SAME
      // employer in that calendar month -- not an exact-date match on the row being edited (a
      // mis-parsed/blank employer would land on a different hashed date than the original and
      // survive as a duplicate), but also not every row in the month regardless of employer
      // (that would delete a genuinely different employer's real row for a month with a
      // mid-month job change). Scoping the replacement to month + employer gets both right.
      const targetMonthSet = new Set(targetMonths);
      const targetEmployer = manualMonthForm.employer.trim();
      const base = months.filter((m) => !(targetMonthSet.has(m.date.slice(0, 7)) && employerFromLabel(m.label) === targetEmployer));
      const touchedFys = new Set(newRows.map((r) => fyOf(r.date)));
      const afterDrop = dropReconstructedFor(base, touchedFys);
      const next = mergeIndiaPayslipMonths(afterDrop, newRows);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setSelectedFy(fyOf(newRows[0].date));
      setAddingManualMonth(false);
      setEditingManualMonth(null);
    } finally {
      setSavingManualMonth(false);
    }
  }
  async function deleteManualMonth() {
    if (!editingManualMonth) return;
    setSavingManualMonth(true);
    try {
      const next = months.filter((m) => m.date !== editingManualMonth.date);
      await onSave({ payslips: { months: next, importedAt: new Date().toISOString() }, itrYears: indiaTax?.itrYears ?? [] });
      setAddingManualMonth(false);
      setEditingManualMonth(null);
      setDeletingManualMonth(false);
    } finally {
      setSavingManualMonth(false);
    }
  }

  // Both the itemized 80C/80D table and the Gross Total Income reconciliation write onto the
  // ITR record for the FY's Assessment Year -- that's the one place these figures are actually
  // filed, so it's the right single source of truth (rather than smuggling them onto a payslip
  // month, which only ever happened because no ITR row necessarily existed yet). Creates the AY's
  // ITR record on first save if one isn't on file yet, instead of requiring "+ Add ITR" first.
  function upsertActiveItrYear(patch: Partial<IndiaItrYear>): IndiaItrYear {
    const base: IndiaItrYear = activeItrYear ?? {
      id: uid(),
      assessmentYear: activeAy!,
      grossTotalIncome: 0,
      deductionsChapterVIA: 0,
      totalIncome: 0,
      taxPayable: 0,
      advanceTax: 0,
      tds: 0,
      tcs: 0,
      selfAssessmentTax: 0,
      refundOrDemand: 0,
    };
    return { ...base, ...patch };
  }
  async function saveItrPatch(patch: Partial<IndiaItrYear>) {
    const updated = upsertActiveItrYear(patch);
    const existing = indiaTax?.itrYears ?? [];
    const next = existing.some((y) => y.id === updated.id)
      ? existing.map((y) => (y.id === updated.id ? updated : y))
      : [...existing, updated];
    await onSave({ payslips: indiaTax?.payslips, itrYears: next });
  }

  // 80C/80D relief isn't limited to what shows up on a payslip -- investments (LIC, NSC, PPF,
  // ELSS, etc.) or a medical policy premium paid directly, outside payroll, count too, each as
  // its own claimed line item (not one lump guess) -- matching how the ITR itself is filed.
  function open80cForm() {
    const items = activeItrYear?.section80CItems ?? [];
    const PF_LABEL = "Provident Fund (PF)";
    let rows: { description: string; amount: string }[];
    if (items.length > 0) {
      // Real itemized data already on file -- respected as-is. Can't safely tell whether an
      // existing lump-style line already has PF baked into it, so no auto-injection here (that
      // would risk double-counting); the fresh-year case below is where PF gets pre-filled.
      rows = items.map((it) => ({ description: it.description, amount: String(it.amount) }));
    } else {
      const lumpTotal = Math.max(0, (activeItrYear?.deductionsChapterVIA ?? 0) - (activeItrYear?.section80DMedical ?? 0));
      rows = [];
      if (lumpTotal > 0) {
        // Predates the itemized-table feature -- PF is part of that lump, not additional on top
        // of it, so break it out instead of seeding both and inflating the total.
        const remainder = Math.max(0, lumpTotal - fyPfTotal);
        if (fyPfTotal > 0) rows.push({ description: PF_LABEL, amount: String(fyPfTotal) });
        if (remainder > 0) rows.push({ description: "From ITR (remaining, not yet itemized)", amount: String(remainder) });
      } else if (fyPfTotal > 0) {
        // A brand-new year with no lump figure at all -- PF is a default 80C deduction straight
        // from this FY's payroll PF column, pre-filled here (still editable) instead of blank.
        rows.push({ description: PF_LABEL, amount: String(fyPfTotal) });
      }
    }
    setSection80Items(rows.length > 0 ? rows : [{ description: "", amount: "" }]);
    setSection80DForm(activeItrYear?.section80DMedical != null ? String(activeItrYear.section80DMedical) : "");
    setAddingSection80(true);
  }
  async function save80cForm() {
    if (!activeAy) return;
    setSavingSection80(true);
    try {
      const items = section80Items
        .map((it) => ({ description: it.description.trim(), amount: Number(it.amount) || 0 }))
        .filter((it) => it.description || it.amount);
      const section80DMedical = Number(section80DForm) || 0;
      // Items/80D are stored RAW (exactly what was invested/paid, even past the statutory cap --
      // that's real information worth keeping) but the ITR's Deductions figure that actually
      // drives Total Income must be the CAPPED, claimable amount, not the raw sum.
      const raw80C = items.reduce((s, it) => s + it.amount, 0);
      const capped80C = Math.min(raw80C, section80CCap(activeAy));
      const capped80D = Math.min(section80DMedical, SECTION_80D_CAP);
      const deductionsChapterVIA = capped80C + capped80D;
      const gti = activeItrYear?.grossTotalIncome ?? 0;
      await saveItrPatch({
        section80CItems: items,
        section80DMedical,
        deductionsChapterVIA,
        totalIncome: gti > 0 ? gti - deductionsChapterVIA : (activeItrYear?.totalIncome ?? 0),
      });
      setAddingSection80(false);
    } finally {
      setSavingSection80(false);
    }
  }

  // Payroll's Gross Salary isn't the ITR's Gross Total Income -- HRA that qualifies as exempt
  // and Professional Tax both come off first. Every figure here is editable and overridable
  // (not just HRA exempt) -- the auto-summed payroll totals are only a starting point, since the
  // payroll table can be incomplete or mid-correction and the reconciliation shouldn't be
  // blocked on it being perfectly clean first.
  function openGtiForm() {
    setGtiGrossSalary(String(activeItrYear?.grossSalaryOverride ?? fyGross));
    setGtiHraExempt(String(activeItrYear?.hraExemptOverride ?? fyHraTotal));
    setGtiProfTax(String(activeItrYear?.professionalTaxOverride ?? fyProfTaxTotal));
    setGtiStcg(activeItrYear?.capitalGains ? String(activeItrYear.capitalGains.shortTerm) : "");
    setGtiLtcg(activeItrYear?.capitalGains ? String(activeItrYear.capitalGains.longTerm) : "");
    setReconcilingGti(true);
  }
  async function saveGtiForm() {
    if (!activeAy) return;
    setSavingGti(true);
    try {
      const grossSalary = Number(gtiGrossSalary) || 0;
      const hraExempt = Number(gtiHraExempt) || 0;
      const profTax = Number(gtiProfTax) || 0;
      const shortTerm = Number(gtiStcg) || 0;
      const longTerm = Number(gtiLtcg) || 0;
      // Capital gains can be negative (a loss) -- unlike the salary side, Gross Total Income
      // isn't floored at 0 here, since a genuine capital loss should be able to bring it down.
      const salaryIncome = Math.max(0, grossSalary - hraExempt - profTax);
      const grossTotalIncome = salaryIncome + shortTerm + longTerm;
      const deductionsChapterVIA = activeItrYear?.deductionsChapterVIA ?? 0;
      await saveItrPatch({
        grossSalaryOverride: grossSalary,
        hraExemptOverride: hraExempt,
        professionalTaxOverride: profTax,
        capitalGains: shortTerm || longTerm ? { shortTerm, longTerm } : undefined,
        grossTotalIncome,
        totalIncome: grossTotalIncome - deductionsChapterVIA,
      });
      setReconcilingGti(false);
    } finally {
      setSavingGti(false);
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
          setSelectedFy(fyOfAy(parsed[parsed.length - 1].assessmentYear));
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
      taxPayable: String(y.taxPayable),
      advanceTax: String(y.advanceTax),
      tds: String(y.tds),
      tcs: String(y.tcs),
      selfAssessmentTax: String(y.selfAssessmentTax),
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
      const existing = indiaTax?.itrYears ?? [];
      const existingRow = editingItrId !== "new" ? existing.find((y) => y.id === editingItrId) : undefined;
      const enteredDeductions = n(itrForm.deductionsChapterVIA);
      const existingSection80D = existingRow?.section80DMedical ?? 0;
      const existingItemsSumRaw = (existingRow?.section80CItems ?? []).reduce((s, it) => s + it.amount, 0);
      const ayForCap = itrForm.assessmentYear.trim();
      // Compare against the CAPPED total (what's actually claimable, same figure deductionsChapterVIA
      // stores), not the raw itemized sum -- otherwise a year already correctly capped would look
      // "different" here on every save and get needlessly re-flattened into an adjustment line.
      const existingCappedTotal = Math.min(existingItemsSumRaw, section80CCap(ayForCap)) + Math.min(existingSection80D, SECTION_80D_CAP);
      // Keep the itemized 80C table in sync with this lump field in BOTH directions -- if what's
      // typed here doesn't match what the itemized breakdown currently sums to (capped), the user
      // just changed this field directly (or it predates the itemized-table feature entirely), so
      // fold the difference into one reconciling line rather than let the "80C + 80D" card and
      // this field silently show two different numbers.
      const section80CItems = enteredDeductions === existingCappedTotal
        ? existingRow?.section80CItems
        : (enteredDeductions - existingSection80D !== 0
            ? [{ description: "Adjustment (entered directly on ITR form)", amount: enteredDeductions - existingSection80D }]
            : []);
      const row: IndiaItrYear = {
        // Preserve everything the itemized-80C/GTI-reconciliation/capital-gains tools have
        // saved onto this row -- this form only ever touches the fields below, so it must never
        // silently drop the rest.
        ...existingRow,
        id: editingItrId === "new" ? uid() : editingItrId!,
        assessmentYear: itrForm.assessmentYear.trim(),
        grossTotalIncome: n(itrForm.grossTotalIncome),
        deductionsChapterVIA: enteredDeductions,
        // Pure arithmetic (Gross Total Income - Ch VI-A Deductions) -- same reasoning as
        // Refund/Demand below: a separately-typed value here can only drift out of sync
        // whenever either of those two fields changes.
        totalIncome: n(itrForm.grossTotalIncome) - enteredDeductions,
        taxPayable: n(itrForm.taxPayable),
        advanceTax: n(itrForm.advanceTax),
        tds: n(itrForm.tds),
        tcs: n(itrForm.tcs),
        selfAssessmentTax: n(itrForm.selfAssessmentTax),
        // Pure arithmetic from the other fields on this same form -- never trust a separately
        // typed value here, it can only drift out of sync with them.
        refundOrDemand: n(itrForm.advanceTax) + n(itrForm.tds) + n(itrForm.tcs) + n(itrForm.selfAssessmentTax) - n(itrForm.taxPayable),
        filingDate: itrForm.filingDate || undefined,
        notes: itrForm.notes || undefined,
        section80CItems,
      };
      const next = editingItrId === "new"
        ? [...existing, row]
        : existing.map((y) => (y.id === row.id ? row : y));
      await onSave({ payslips: indiaTax?.payslips, itrYears: next });
      setSelectedFy(fyOfAy(row.assessmentYear));
      setEditingItrId(null);
    } finally {
      setSavingItr(false);
    }
  }
  async function deleteItr(id: string) {
    const next = (indiaTax?.itrYears ?? []).filter((y) => y.id !== id);
    await onSave({ payslips: indiaTax?.payslips, itrYears: next });
  }

  const fySummaryCards: { label: string; value: number; sub: string; icon: IconKind; color: string; onClick?: () => void }[] = latestInFy
    ? [
        { label: "Gross Salary", value: fyGross, sub: `FY ${activeFy}, ${fyMonths.length} month(s)`, icon: "cash", color: "#1e40af" },
        { label: "Total Deductions", value: fyDeductions, sub: "PF + tax + other", icon: "receipt", color: "#dc2626" },
        { label: "Net Pay", value: fyNet, sub: "actually received", icon: "wallet", color: "#16a34a" },
        {
          label: "Gross Total Income (ITR)",
          value: activeItrYear?.grossTotalIncome ?? estimatedGti,
          sub: activeItrYear?.grossTotalIncome
            ? `Gross − HRA exempt − Prof. Tax — click to recompute →`
            : `estimated: Gross − HRA exempt − Prof. Tax — click to confirm & save →`,
          icon: "trending-up", color: "#0891b2",
          onClick: openGtiForm,
        },
        {
          label: "80C + 80D", value: section80RawDisplayTotal,
          sub: section80OverCap
            ? `AY ${activeAy} — total invested/paid (claimable capped in ITR below), click to edit →`
            : `AY ${activeAy} — from ITR itemized deductions, click to edit →`,
          icon: "shield", color: "#7c3aed",
          onClick: open80cForm,
        },
        {
          label: "Taxable Income",
          value: activeItrYear?.totalIncome ?? Math.max(0, estimatedGti - (activeItrYear?.deductionsChapterVIA ?? section80CTotal + section80DTotal)),
          sub: `AY ${activeAy} — Gross Total Income − Ch VI-A deductions`, icon: "scale", color: "#9333ea",
        },
        {
          label: "Tax Deducted", value: fyIncomeTaxTotal,
          sub: activeItrYear && activeItrYear.tds !== fyIncomeTaxTotal
            ? `sum of this FY's Income Tax column (ITR TDS on file: ${fmt(activeItrYear.tds)})`
            : "sum of this FY's Income Tax column",
          icon: "bank", color: "#d97706",
        },
      ]
    : [];

  const noData = months.length === 0 && itrYears.length === 0;

  return (
    <div className="data-panel tax-report">
      <div className="equity-section-head">
        <h4>India Payroll &amp; Tax {activeFy && `— FY ${activeFy}`}</h4>
      </div>

      <input ref={payslipFileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={handlePayslipImport} />
      <input ref={itrFileInputRef} type="file" accept=".pdf" multiple style={{ display: "none" }} onChange={handleItrImport} />

      {noData ? (
        <div className="equity-seed-banner">
          <p className="equity-empty">No India payslips or tax returns yet.</p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
            <input type="password" placeholder="Payslip PDF password" value={payslipPassword} onChange={(e) => setPayslipPassword(e.target.value)} className="india-tax-input" style={{ maxWidth: 200 }} />
            <button
              className="equity-seed-btn"
              onClick={() => payslipFileInputRef.current?.click()}
              disabled={importingPayslips || !payslipPassword.trim()}
              title={!payslipPassword.trim() ? "Enter the payslip PDF password first" : undefined}
            >
              {importingPayslips ? `Importing… ${payslipImportProgress ? `${payslipImportProgress.done}/${payslipImportProgress.total}` : ""}` : "📄 Import Payslip PDFs"}
            </button>
            <button className="equity-seed-btn" onClick={openAddItr}>+ Add ITR Year</button>
          </div>
        </div>
      ) : (
        <>
          <div className="equity-grant-filter">
            <span className="equity-grant-filter-label">Financial Year:</span>
            <select value={activeFy ?? ""} onChange={(e) => setSelectedFy(e.target.value)} className="india-tax-input" style={{ fontWeight: 600 }}>
              {fyList.map((fy) => (
                <option key={fy} value={fy}>{fy} (AY {ayOfFy(fy)})</option>
              ))}
            </select>
            <input type="password" placeholder="Payslip password" value={payslipPassword} onChange={(e) => setPayslipPassword(e.target.value)} className="india-tax-input" style={{ maxWidth: 150 }} />
            <button
              onClick={() => payslipFileInputRef.current?.click()}
              disabled={importingPayslips || !payslipPassword.trim()}
              title={!payslipPassword.trim() ? "Enter the payslip PDF password first" : undefined}
            >
              {importingPayslips ? `Importing… ${payslipImportProgress ? `${payslipImportProgress.done}/${payslipImportProgress.total}` : ""}` : "📄 Import Payslip PDFs"}
            </button>
            <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
              {activeItrYear ? (
                <>
                  <button onClick={() => openEditItr(activeItrYear)}>Edit ITR</button>
                  <button onClick={() => deleteItr(activeItrYear.id)}>Delete ITR</button>
                </>
              ) : (
                <button onClick={openAddItr}>+ Add ITR for AY {activeAy}</button>
              )}
            </span>
          </div>

          <details style={{ margin: "0 0 0.75rem" }}>
            <summary style={{ fontSize: 12, opacity: 0.7, cursor: "pointer", listStyle: "none" }}>
              ⚙️ Data entry tools (bulk-add, reconstruction, PDF re-import) →
            </summary>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
              <button onClick={openAddReconstructed}>✏️ Add Reconstructed Year</button>
              <button onClick={openBulkAddReconstructed}>📋 Bulk Add Reconstructed Years</button>
              <button onClick={openBulkAddMonths}>📆 Bulk Add Months (from ledger)</button>
              <button onClick={openAddManualMonth}>📝 Add Real Month (Manual)</button>
              {isReconstructedFy && (
                <button onClick={() => activeFy && deleteReconstructedFy(activeFy)} title="Delete this reconstructed entry">
                  🗑 Delete Reconstructed
                </button>
              )}
              {activeFy && fyMonths.length > 0 && (
                <button onClick={() => activeFy && clearFy(activeFy)} title="Delete every entry for this FY, regardless of source — for recovering from duplicate/corrupted data">
                  🗑 Clear FY {activeFy}
                </button>
              )}
              <input type="password" placeholder="ITR password" title="ITR PDF password (older years only)" value={itrPassword} onChange={(e) => setItrPassword(e.target.value)} className="india-tax-input" style={{ width: 110 }} />
              <button onClick={() => itrFileInputRef.current?.click()} disabled={importingItr}>
                {importingItr ? `Importing… ${itrImportProgress ? `${itrImportProgress.done}/${itrImportProgress.total}` : ""}` : "📄 Import ITR PDFs"}
              </button>
            </div>
            <p className="equity-seed-note" style={{ margin: "0.5rem 0 0" }}>
              Bulk tools read Basic, HRA, PF, Professional Tax, Income Tax, Net Pay from real payslips or reconstruct
              from a ledger/ITR total. ITR PDFs: most recent downloads aren&apos;t password-protected, older ones
              (pre-~2016) usually need PAN + DOB. Re-importing a file for a year already on record replaces it.
            </p>
          </details>

          {(payslipImportErrors.length > 0 || itrImportErrors.length > 0) && (
            <p className="equity-pdf-error" style={{ marginBottom: "0.5rem" }}>
              {[...payslipImportErrors, ...itrImportErrors].join("; ")}
            </p>
          )}

          {fyMonths.length > 0 ? (
            <>
              <div className="equity-summary-row">
                {fySummaryCards.map((c) => (
                  <div key={c.label} className="equity-summary-col">
                    <div className="equity-summary-card" style={c.onClick ? { cursor: "pointer" } : undefined} onClick={c.onClick}>
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
                    <th className="right" title="Deducted first, before 80C-eligible items like PF">Prof. Tax</th>
                    <th className="right">PF</th>
                    <th className="right" title="A specifically identified deduction that isn't PF/Professional Tax/Income Tax — e.g. an LIP/Superannuation contribution">Other Ded.</th>
                    <th className="right">Income Tax</th>
                    <th className="right">Net Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {fyMonths.map((m) => (
                    <tr key={m.date} onClick={() => openEditManualMonth(m)} style={{ cursor: "pointer" }} title="Click to edit this month">
                      <td>{m.label}</td>
                      <td className="right">{fmt(m.basic)}</td>
                      <td className="right">{fmt(m.hra)}</td>
                      <td className="right">{fmt(m.conveyance + m.otherAllowances)}</td>
                      <td className="right">{fmt(m.grossEarnings)}</td>
                      <td className="right">{fmt(m.professionalTax)}</td>
                      <td className="right">{fmt(m.pf)}</td>
                      <td className="right">{fmt(m.otherDeductions)}</td>
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
                    <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.professionalTax, 0))}</td>
                    <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.pf, 0))}</td>
                    <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.otherDeductions, 0))}</td>
                    <td className="right">{fmt(fyMonths.reduce((s, m) => s + m.incomeTax, 0))}</td>
                    <td className="right">{fmt(fyNet)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          ) : (
            <p className="equity-empty">No payslip data for FY {activeFy}.</p>
          )}

          <div className="equity-section-head" style={{ marginTop: "1.5rem" }}>
            <h4>Income Tax Return — AY {activeAy}</h4>
          </div>
          {activeItrYear ? (
            <>
              <div className="equity-summary-row">
                {itrSummaryCards.map((c) => (
                  <div key={c.label} className="equity-summary-col">
                    <div className="equity-summary-card" style={c.onClick ? { cursor: "pointer" } : undefined} onClick={c.onClick}>
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
              {activeItrYear.notes && (
                <p className="equity-seed-note" style={{ margin: "0.5rem 0 0" }}>
                  Notes: {activeItrYear.notes}
                </p>
              )}
            </>
          ) : (
            <p className="equity-empty">No ITR on file for AY {activeAy}.</p>
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
            <div style={{ fontSize: 12 }}>
              Total Income — computed, not entered
              <div className="india-tax-input" style={{ display: "block", width: "100%", background: "#f8fafc" }}>
                {fmt((Number(itrForm.grossTotalIncome) || 0) - (Number(itrForm.deductionsChapterVIA) || 0))}
                {" "}= Gross Total Income − Deductions
              </div>
            </div>
            <label style={{ fontSize: 12 }}>
              Tax Payable
              <input type="number" value={itrForm.taxPayable} onChange={(e) => setItrForm({ ...itrForm, taxPayable: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
              {hasIndiaTaxSlabsFor(itrForm.assessmentYear.trim()) && (() => {
                const formTotalIncome = (Number(itrForm.grossTotalIncome) || 0) - (Number(itrForm.deductionsChapterVIA) || 0);
                const est = estimateIndiaTax(itrForm.assessmentYear.trim(), formTotalIncome);
                return est != null ? (
                  <span style={{ display: "block", marginTop: 2, fontWeight: 400 }}>
                    Slab estimate: {fmt(est)}{" "}
                    <button type="button" onClick={() => setItrForm({ ...itrForm, taxPayable: String(est) })} style={{ fontSize: 11, padding: "1px 6px" }}>
                      Use this
                    </button>
                  </span>
                ) : null;
              })()}
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
            <div style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Refund (+) / Demand (-) — computed, not entered
              <div className="india-tax-input" style={{ display: "block", width: "100%", background: "#f8fafc" }}>
                {fmt(
                  (Number(itrForm.advanceTax) || 0) + (Number(itrForm.tds) || 0) + (Number(itrForm.tcs) || 0) +
                    (Number(itrForm.selfAssessmentTax) || 0) - (Number(itrForm.taxPayable) || 0)
                )}
                {" "}= Advance + TDS + TCS + Self-Assessment − Tax Payable
              </div>
            </div>
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

      {addingBulkReconstructed && (
        <Modal title="Bulk Add Reconstructed Years" onClose={() => setAddingBulkReconstructed(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            One row per line: <code>Financial Year, Employer, Gross Annual Income</code> (Employer optional, e.g. leave
            it blank for a single-employer year — still keep the comma). Comma, tab, or pipe (|) separated. Two rows
            with the same Financial Year but different employers both get kept, not overwritten.
          </p>
          <textarea
            value={bulkReconstructText}
            onChange={(e) => { setBulkReconstructText(e.target.value); setBulkReconstructError(""); }}
            placeholder={"2005-06, Mafatlal, 60860\n2006-07, Mafatlal, 159136\n2007-08, Mafatlal, 104043\n2007-08, RCOM, 226848"}
            rows={8}
            className="india-tax-input"
            style={{ display: "block", width: "100%", fontFamily: "monospace", fontSize: 12 }}
          />
          {bulkReconstructError && (
            <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{bulkReconstructError}</p>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setAddingBulkReconstructed(false)}>Cancel</button>
            <button onClick={saveBulkReconstructed} disabled={savingBulkReconstructed || !bulkReconstructText.trim()}>
              {savingBulkReconstructed ? "Saving…" : "Save All"}
            </button>
          </div>
        </Modal>
      )}

      {addingBulkMonths && (
        <Modal title="Bulk Add Months (from ledger)" onClose={() => setAddingBulkMonths(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            One row per line: <code>YYYY-MM, Employer, Basic, HRA, Other, PF, ProfTax, IncomeTax, OtherDeductions</code> (any
            can be left blank for 0 — a lump total with no known breakdown just goes in Other). OtherDeductions is for
            a specifically identified deduction that isn&apos;t PF/ProfTax/IncomeTax (e.g. an LIP/Superannuation
            contribution) — not a place to hide an unexplained gap. Real monthly figures, not an annual estimate — if
            a &quot;Reconstructed Year&quot; annual entry already exists for a year these months fall into, it&apos;s
            replaced automatically, not double-counted.
          </p>
          <textarea
            value={bulkMonthsText}
            onChange={(e) => { setBulkMonthsText(e.target.value); setBulkMonthsError(""); }}
            placeholder={"2005-07, Mafatlal, 11050, , , 1038, 60, , 128\n2005-08, Mafatlal, 12500, , , 1038, 70, , 128\n2013-08, BECL, 38418, 15367, 18928, 4610, 200, , "}
            rows={10}
            className="india-tax-input"
            style={{ display: "block", width: "100%", fontFamily: "monospace", fontSize: 12 }}
          />
          {bulkMonthsError && (
            <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{bulkMonthsError}</p>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setAddingBulkMonths(false)}>Cancel</button>
            <button onClick={saveBulkMonths} disabled={savingBulkMonths || !bulkMonthsText.trim()}>
              {savingBulkMonths ? "Saving…" : "Save All"}
            </button>
          </div>
        </Modal>
      )}

      {addingManualMonth && (
        <Modal title={editingManualMonth ? `Edit ${editingManualMonth.label}` : "Add / Edit Month (Manual)"} onClose={() => { setAddingManualMonth(false); setEditingManualMonth(null); }}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Enter or correct one month by hand — for a real payslip that&apos;s only a scanned image (no text layer
            to auto-read), or any figure you need to fix directly. Use &quot;Also apply to&quot; below to copy these
            exact same values to other months in one save, instead of retyping them each time.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
            <label style={{ fontSize: 12 }}>
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
              Employer (optional)
              <input value={manualMonthForm.employer} onChange={(e) => setManualMonthForm({ ...manualMonthForm, employer: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
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
              Professional Tax
              <input type="number" value={manualMonthForm.professionalTax} onChange={(e) => setManualMonthForm({ ...manualMonthForm, professionalTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              PF
              <input type="number" value={manualMonthForm.pf} onChange={(e) => setManualMonthForm({ ...manualMonthForm, pf: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Income Tax (TDS)
              <input type="number" value={manualMonthForm.incomeTax} onChange={(e) => setManualMonthForm({ ...manualMonthForm, incomeTax: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Other Deductions
              <input type="number" value={manualMonthForm.otherDeductions} onChange={(e) => setManualMonthForm({ ...manualMonthForm, otherDeductions: e.target.value })} className="india-tax-input" style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              Also apply to these months (comma-separated YYYY-MM, optional)
              <input
                value={manualMonthForm.copyToMonths}
                onChange={(e) => setManualMonthForm({ ...manualMonthForm, copyToMonths: e.target.value })}
                placeholder="2005-09, 2005-10, 2005-11"
                className="india-tax-input"
                style={{ display: "block", width: "100%" }}
              />
            </label>
          </div>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
            <div>
              {editingManualMonth && (
                deletingManualMonth ? (
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: 12 }}>
                    Delete this month for good?
                    <button onClick={deleteManualMonth} disabled={savingManualMonth} style={{ color: "#dc2626" }}>
                      {savingManualMonth ? "Deleting…" : "Yes, delete"}
                    </button>
                    <button onClick={() => setDeletingManualMonth(false)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => setDeletingManualMonth(true)} title="Delete this month's row entirely">
                    🗑 Delete this month
                  </button>
                )
              )}
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button onClick={() => { setAddingManualMonth(false); setEditingManualMonth(null); setDeletingManualMonth(false); }}>Cancel</button>
              <button onClick={saveManualMonthForm} disabled={savingManualMonth || !/^\d{4}-\d{2}$/.test(manualMonthForm.month)}>
                {savingManualMonth ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {addingSection80 && (
        <Modal title={`Section 80C / 80D — AY ${activeAy}`} onClose={() => setAddingSection80(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Investments (LIC, NSC, PPF, ELSS, etc.) or a medical policy premium paid directly, outside payroll, still
            count toward these deductions — one row per 80C investment, exactly as they&apos;d be listed on the ITR,
            plus one field for the 80D medical premium. Enter as much as you actually invested/paid — Section 80C is
            capped at {activeAy ? fmt(section80CCap(activeAy)) : "₹1,00,000"} (₹1,00,000 through AY2014-15, ₹1,50,000
            from AY2015-16 onward) and 80D at {fmt(SECTION_80D_CAP)} combined, so anything past the cap is tracked
            but doesn&apos;t count toward the deduction actually claimed. Saving updates this AY&apos;s ITR
            &quot;Deductions (Chapter VI-A)&quot; and Total Income with the CAPPED, claimable total.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.5rem" }}>
            <thead>
              <tr style={{ fontSize: 11, opacity: 0.7, textAlign: "left" }}>
                <th style={{ paddingBottom: 4 }}>80C Description (LIC, NSC, PPF, ELSS…)</th>
                <th style={{ paddingBottom: 4, width: 130 }}>Amount</th>
                <th style={{ width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {section80Items.map((item, i) => (
                <tr key={i}>
                  <td style={{ paddingRight: 6, paddingBottom: 4 }}>
                    <input
                      value={item.description}
                      onChange={(e) => setSection80Items(section80Items.map((it, j) => (j === i ? { ...it, description: e.target.value } : it)))}
                      className="india-tax-input"
                      style={{ display: "block", width: "100%" }}
                      placeholder="e.g. LIC"
                    />
                  </td>
                  <td style={{ paddingRight: 6, paddingBottom: 4 }}>
                    <input
                      type="number"
                      value={item.amount}
                      onChange={(e) => setSection80Items(section80Items.map((it, j) => (j === i ? { ...it, amount: e.target.value } : it)))}
                      className="india-tax-input"
                      style={{ display: "block", width: "100%" }}
                      placeholder="e.g. 1000"
                    />
                  </td>
                  <td style={{ paddingBottom: 4 }}>
                    <button
                      onClick={() => setSection80Items(section80Items.filter((_, j) => j !== i))}
                      disabled={section80Items.length === 1}
                      title="Remove row"
                      aria-label="Remove row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => setSection80Items([...section80Items, { description: "", amount: "" }])} style={{ fontSize: 12 }}>
            + Add 80C row
          </button>
          {(() => {
            const raw80C = section80Items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
            const cap80C = activeAy ? section80CCap(activeAy) : 100000;
            const claimable80C = Math.min(raw80C, cap80C);
            const raw80D = Number(section80DForm) || 0;
            const claimable80D = Math.min(raw80D, SECTION_80D_CAP);
            return (
              <div style={{ fontSize: 12, margin: "0.5rem 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.7 }}>
                  <span>80C total entered</span>
                  <span>{fmt(raw80C)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>80C claimable (capped at {fmt(cap80C)}{raw80C > cap80C ? ", AY " + activeAy : ""})</span>
                  <strong style={raw80C > cap80C ? { color: "#dc2626" } : undefined}>{fmt(claimable80C)}</strong>
                </div>
              </div>
            );
          })()}
          <label style={{ fontSize: 12, display: "block", marginTop: "0.5rem" }}>
            Section 80D (medical premium) entered
            <input type="number" value={section80DForm} onChange={(e) => setSection80DForm(e.target.value)} className="india-tax-input" style={{ display: "block", width: "100%" }} />
          </label>
          {(() => {
            const raw80D = Number(section80DForm) || 0;
            const claimable80D = Math.min(raw80D, SECTION_80D_CAP);
            const raw80C = section80Items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
            const cap80C = activeAy ? section80CCap(activeAy) : 100000;
            const claimable80C = Math.min(raw80C, cap80C);
            return (
              <div style={{ fontSize: 12, marginTop: "0.25rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.7 }}>
                  <span>80D claimable (capped at {fmt(SECTION_80D_CAP)})</span>
                  <span style={raw80D > SECTION_80D_CAP ? { color: "#dc2626" } : undefined}>{fmt(claimable80D)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid #e2e8f0", paddingTop: 4, marginTop: 4 }}>
                  <span>Total claimable (Ch VI-A Deductions)</span>
                  <strong>{fmt(claimable80C + claimable80D)}</strong>
                </div>
              </div>
            );
          })()}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setAddingSection80(false)}>Cancel</button>
            <button onClick={save80cForm} disabled={savingSection80}>
              {savingSection80 ? "Saving…" : "Save"}
            </button>
          </div>
        </Modal>
      )}

      {reconcilingGti && (
        <Modal title={`Gross Total Income — FY ${activeFy} → AY ${activeAy}`} onClose={() => setReconcilingGti(false)}>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>
            Gross Total Income (ITR) = Gross Salary − HRA exempt (Section 10(13A)) − Professional Tax + Capital
            Gains. Every figure below is editable — Gross Salary and Professional Tax default to this FY&apos;s
            payslip totals but can be overridden if the payroll table is incomplete or doesn&apos;t match what was
            actually filed. Capital gains (or a loss, entered negative) are taxed at special rates, not your slab
            rate — the Tax Payable slab estimate is suppressed for a year with gains on file rather than silently
            mis-taxing them. Saving writes the result to this AY&apos;s ITR Gross Total Income.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, fontSize: 13, alignItems: "center" }}>
            <label>Gross Salary</label>
            <input type="number" value={gtiGrossSalary} onChange={(e) => setGtiGrossSalary(e.target.value)} className="india-tax-input" style={{ width: 140, textAlign: "right" }} />
            <span>HRA paid, FY {activeFy} (for reference)</span>
            <strong>{fmt(fyHraTotal)}</strong>
            <label>HRA exempt</label>
            <input type="number" value={gtiHraExempt} onChange={(e) => setGtiHraExempt(e.target.value)} className="india-tax-input" style={{ width: 140, textAlign: "right" }} />
            <label>Professional Tax</label>
            <input type="number" value={gtiProfTax} onChange={(e) => setGtiProfTax(e.target.value)} className="india-tax-input" style={{ width: 140, textAlign: "right" }} />
            <label>Short-Term Capital Gain (Loss)</label>
            <input type="number" value={gtiStcg} onChange={(e) => setGtiStcg(e.target.value)} className="india-tax-input" style={{ width: 140, textAlign: "right" }} placeholder="0" />
            <label>Long-Term Capital Gain (Loss)</label>
            <input type="number" value={gtiLtcg} onChange={(e) => setGtiLtcg(e.target.value)} className="india-tax-input" style={{ width: 140, textAlign: "right" }} placeholder="0" />
            <span style={{ borderTop: "1px solid #e2e8f0", paddingTop: 6 }}>Gross Total Income</span>
            <strong style={{ borderTop: "1px solid #e2e8f0", paddingTop: 6 }}>
              {fmt(Math.max(0, (Number(gtiGrossSalary) || 0) - (Number(gtiHraExempt) || 0) - (Number(gtiProfTax) || 0)) + (Number(gtiStcg) || 0) + (Number(gtiLtcg) || 0))}
            </strong>
          </div>
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setReconcilingGti(false)}>Cancel</button>
            <button onClick={saveGtiForm} disabled={savingGti}>
              {savingGti ? "Saving…" : "Save to ITR"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
