import type { PayrollData, PayrollRow } from "./vault-types";

function row(rows: PayrollRow[], label: string): PayrollRow | undefined {
  return rows.find((r) => r.label === label);
}

export type K401YearTotal = { year: string; self: number; employer: number };

// Lifetime employee vs. employer 401(k) contribution totals across every imported payroll year --
// same computation TaxReport.tsx's "401(k) Contributions by Year" drilldown uses: one row per
// year, sourced from each year's CUMULATIVE "401K"/"401K Emplr" column (not the annual column,
// which is blank for employer match in the source sheet), so this also works for a year still in
// progress.
export function compute401kByYear(payroll: PayrollData | undefined): K401YearTotal[] {
  if (!payroll) return [];
  return payroll.years
    .slice()
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((y) => ({
      year: y.year,
      self: row(y.rows, "401K")?.cumulative ?? 0,
      employer: row(y.rows, "401K Emplr")?.cumulative ?? 0,
    }))
    .filter((r) => r.self > 0.005 || r.employer > 0.005);
}

export function compute401kLifetimeTotals(payroll: PayrollData | undefined): { self: number; employer: number } {
  const byYear = compute401kByYear(payroll);
  return {
    self: byYear.reduce((s, r) => s + r.self, 0),
    employer: byYear.reduce((s, r) => s + r.employer, 0),
  };
}
