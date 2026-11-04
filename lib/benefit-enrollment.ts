import type { BenefitEnrollmentYear } from "./vault-types.ts";

// NVIDIA's own semi-monthly payroll cadence (matches PAYROLL_* constants used elsewhere in this
// app, e.g. components/vault/PlaidImport.tsx's payroll template) -- the default for a brand-new
// year's record; stored per-year on BenefitEnrollmentYear itself rather than hardcoded at every
// call site, in case pay cadence ever changes.
export const DEFAULT_PAY_PERIODS_PER_YEAR = 24;

// Keyed by year, not appended -- re-uploading or re-entering the same year is a correction/
// refresh, not a new record (same convention as mergeAmexBenefits/mergeAlpacaPaperTrades).
export function mergeBenefitEnrollmentYear(
  existing: BenefitEnrollmentYear[],
  incoming: BenefitEnrollmentYear
): BenefitEnrollmentYear[] {
  const byYear = new Map(existing.map((y) => [y.year, y]));
  byYear.set(incoming.year, incoming);
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

export function removeBenefitEnrollmentYear(existing: BenefitEnrollmentYear[], year: number): BenefitEnrollmentYear[] {
  return existing.filter((y) => y.year !== year);
}

export const costPerMonth = (y: BenefitEnrollmentYear, costPerPayPeriod: number) =>
  (costPerPayPeriod * y.payPeriodsPerYear) / 12;

export const costPerYear = (y: BenefitEnrollmentYear, costPerPayPeriod: number) =>
  costPerPayPeriod * y.payPeriodsPerYear;
