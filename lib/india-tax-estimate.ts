import type { IndiaPayslipMonth, IndiaItrYear } from "./vault-types.ts";
import { estimateIndiaTax, hasIndiaTaxSlabsFor, section80CCap, SECTION_80D_CAP } from "./india-tax-slabs.ts";
import { computeHouseProperty } from "./india-house-property.ts";

// VERBATIM copy of components/reports/IndiaTaxReport.tsx's own private fyOf/ayOfFy/fyOfAy and
// summarizeFy (as of the commit that added lib/assistant-tools.ts's get_india_tax_estimate tool)
// -- same rationale as lib/us-tax-estimate.ts's own comment: copying rather than extracting+
// refactoring the real component avoids any regression risk to a real tax-filing report this
// environment has no way to live-test after a change. If IndiaTaxReport.tsx's own versions change,
// this file needs the same change made here too, or the two will silently drift.

// India's financial year runs Apr-Mar, one year "behind" the Assessment Year an ITR is filed
// under (income earned in FY 2013-14 is assessed/filed as AY 2014-15).
export function fyOf(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  return m >= 4 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}
export function ayOfFy(fy: string): string {
  const startYear = Number(fy.slice(0, 4));
  return `${startYear + 1}-${String(startYear + 2).slice(-2)}`;
}
export function fyOfAy(ay: string): string {
  const startYear = Number(ay.slice(0, 4));
  return `${startYear - 1}-${String(startYear).slice(-2)}`;
}

export interface IndiaFySummaryRow {
  fy: string;
  ay: string;
  gross: number;
  deductions: number;
  net: number;
  section80Raw: number;
  taxDeductedPayroll: number;
  grossTotalIncome: number;
  chVIA: number;
  taxableIncome: number;
  taxPayable: number;
  tds: number;
  advanceSelfAssessment: number;
  taxesPaidTotal: number;
  refund: number;
}

export function summarizeFy(fy: string, allMonths: IndiaPayslipMonth[], allItrYears: IndiaItrYear[]): IndiaFySummaryRow {
  const ay = ayOfFy(fy);
  const fyMonths = allMonths.filter((m) => fyOf(m.date) === fy);
  const gross = fyMonths.reduce((s, m) => s + m.grossEarnings, 0);
  const deductions = fyMonths.reduce((s, m) => s + m.totalDeductions, 0);
  const net = fyMonths.reduce((s, m) => s + m.netPay, 0);
  const hraTotal = fyMonths.reduce((s, m) => s + m.hra, 0);
  const profTaxTotal = fyMonths.reduce((s, m) => s + m.professionalTax, 0);
  const taxDeductedPayroll = fyMonths.reduce((s, m) => s + m.incomeTax, 0);
  const itrYear = allItrYears.find((y) => y.assessmentYear === ay);

  const items80C = itrYear?.section80CItems ?? [];
  const raw80C = items80C.reduce((s, it) => s + it.amount, 0);
  const raw80D = itrYear?.section80DMedical ?? 0;
  const capped80C = Math.min(raw80C, section80CCap(ay));
  const capped80D = Math.min(raw80D, SECTION_80D_CAP);
  const hasItemized = items80C.length > 0 || raw80D > 0;
  const chVIA = itrYear ? (hasItemized ? capped80C + capped80D : itrYear.deductionsChapterVIA) : 0;
  const section80Raw = raw80C + raw80D !== 0 ? raw80C + raw80D : (itrYear?.deductionsChapterVIA ?? 0);

  const houseProperty = computeHouseProperty(ay, itrYear?.houseRentIncome ?? 0, itrYear?.homeLoanInterest ?? 0, itrYear?.homeLoanInterestCapOverride);
  const estimatedSalaryIncome = Math.max(0, (itrYear?.grossSalaryOverride ?? gross) - (itrYear?.hraExemptOverride ?? hraTotal) - (itrYear?.professionalTaxOverride ?? profTaxTotal));
  const estimatedGrossTotalIncome = estimatedSalaryIncome
    + (itrYear?.capitalGains?.shortTerm ?? 0) + (itrYear?.capitalGains?.longTerm ?? 0)
    + houseProperty.allowedAgainstOtherIncome + (itrYear?.otherSourcesIncome ?? 0);
  const grossTotalIncome = itrYear?.grossTotalIncome ?? estimatedGrossTotalIncome;
  const taxableIncome = itrYear
    ? (hasItemized ? grossTotalIncome - chVIA : itrYear.totalIncome)
    : Math.max(0, estimatedGrossTotalIncome - chVIA);
  const taxPayable = itrYear?.taxPayable ?? 0;
  const tds = itrYear?.tds ?? 0;
  const advanceSelfAssessment = itrYear ? itrYear.advanceTax + itrYear.selfAssessmentTax : 0;
  const taxesPaidTotal = itrYear ? itrYear.advanceTax + itrYear.tds + itrYear.tcs + itrYear.selfAssessmentTax : 0;
  const refund = taxesPaidTotal - taxPayable;

  return {
    fy, ay, gross, deductions, net, section80Raw, taxDeductedPayroll,
    grossTotalIncome, chVIA, taxableIncome, taxPayable, tds, advanceSelfAssessment, taxesPaidTotal, refund,
  };
}

export interface IndiaTaxEstimateResult {
  fy: string;
  ay: string;
  hasFiledItr: boolean;
  taxableIncome: number;
  taxPayable: number;
  isEstimate: boolean;
  tds: number;
  advanceSelfAssessment: number;
  taxesPaidTotal: number;
  refund: number;
}

// Built on summarizeFy rather than replicating IndiaTaxReport.tsx's OWN "estimatedTaxPayable"
// inline logic (lines ~280-387 of that component) -- that logic is tightly coupled to dozens of
// component-local useState/useMemo variables (activeItrYear, activeAy, fyGross, fyHraTotal, ...)
// and also layers in capital-gains special-rate tax (Secs 111A/112A), which this does NOT
// replicate. Deliberate scope cut: whenever a real filed ITR exists, summarizeFy's own taxPayable
// IS that real filed figure already -- more authoritative than any estimate, capital-gains-aware
// or not, so this only ever falls back to its OWN simplified slab estimate (ordinary rates only,
// no capital-gains special rate) for a year with NO filed ITR on record, where literal "0" would
// otherwise be silently reported as if that were a real answer.
export function estimateIndiaTaxForFy(fy: string, allMonths: IndiaPayslipMonth[], allItrYears: IndiaItrYear[]): IndiaTaxEstimateResult {
  const summary = summarizeFy(fy, allMonths, allItrYears);
  const hasFiledItr = allItrYears.some((y) => y.assessmentYear === summary.ay);
  let taxPayable = summary.taxPayable;
  let isEstimate = false;
  if (!hasFiledItr && hasIndiaTaxSlabsFor(summary.ay)) {
    const est = estimateIndiaTax(summary.ay, summary.taxableIncome);
    if (est !== null) {
      taxPayable = est;
      isEstimate = true;
    }
  }
  return {
    fy: summary.fy,
    ay: summary.ay,
    hasFiledItr,
    taxableIncome: summary.taxableIncome,
    taxPayable,
    isEstimate,
    tds: summary.tds,
    advanceSelfAssessment: summary.advanceSelfAssessment,
    taxesPaidTotal: summary.taxesPaidTotal,
    refund: summary.taxesPaidTotal - taxPayable,
  };
}
