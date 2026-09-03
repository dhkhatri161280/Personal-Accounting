import type { PayrollData, PayrollRow, EsppPurchase } from "./vault-types";
import { parsePeriodRange } from "./payroll-match";

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

// Most recent non-zero per-period "ESPP" payroll deduction across every imported period, newest
// first -- used to project a still-open or future ESPP cycle forward at a constant contribution
// rate (last known $/period, held flat) rather than the true-but-currently-$0 actual-so-far sum
// a brand-new offering period would otherwise show (nothing's been deducted yet in the first few
// days of a new cycle). NVIDIA pays semi-monthly (24 periods/year), so this is meant to be
// multiplied by ~12 periods per 6-month ESPP cycle by the caller.
export function mostRecentEsppPerPeriod(payroll: PayrollData | undefined): number {
  if (!payroll) return 0;
  const candidates: { end: string; value: number }[] = [];
  for (const y of payroll.years) {
    const esppRow = row(y.rows, "ESPP");
    if (!esppRow) continue;
    for (let i = 0; i < y.periodLabels.length; i++) {
      const value = esppRow.values[i] ?? 0;
      if (value <= 0) continue;
      const range = parsePeriodRange(y.periodLabels[i], y.year);
      if (!range) continue;
      candidates.push({ end: range.end, value });
    }
  }
  candidates.sort((a, b) => b.end.localeCompare(a.end));
  return candidates[0]?.value ?? 0;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const lastDayIso = (y: number, m: number) => `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`;

// Every actually-imported, NON-ZERO "ESPP" payroll deduction, keyed by that period's end date.
// Zero values are deliberately excluded -- a payroll Excel import typically pre-fills every
// period column for the whole year, including ones that haven't been paid yet, as 0/blank. A
// genuine $0 real deduction and an unposted future period both come through the same way here;
// treating them as "no real data" (falling back to the projected constant rate instead) is the
// correct read for this projection's purpose, and matches the same skip already used by
// mostRecentEsppPerPeriod above.
function realEsppByPeriodEnd(payroll: PayrollData | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!payroll) return map;
  for (const y of payroll.years) {
    const esppRow = row(y.rows, "ESPP");
    if (!esppRow) continue;
    for (let i = 0; i < y.periodLabels.length; i++) {
      const value = esppRow.values[i] ?? 0;
      if (value <= 0) continue;
      const range = parsePeriodRange(y.periodLabels[i], y.year);
      if (!range) continue;
      map.set(range.end, value);
    }
  }
  return map;
}

// Generates the semi-monthly (1st-15th, 16th-EOM) period boundaries NVIDIA payroll uses, from
// (startYear, startMonth) through (endYear, endMonth) inclusive.
function semiMonthlyPeriods(startYear: number, startMonth: number, endYear: number, endMonth: number) {
  const periods: { start: string; end: string }[] = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    periods.push({ start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-15` });
    periods.push({ start: `${y}-${pad2(m)}-16`, end: lastDayIso(y, m) });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return periods;
}

export type EsppCycleWindow = { key: string; start: string; end: string; purchaseDate: string };

// NVIDIA's two ESPP offering windows: Sep 1-end of Feb, and Mar 1-Aug 31. Generates `count`
// consecutive windows starting from whichever one `firstOfferingDate` falls in.
export function generateEsppCycleWindows(firstOfferingDate: string, count: number): EsppCycleWindow[] {
  let [y, m] = firstOfferingDate.split("-").map(Number);
  const windows: EsppCycleWindow[] = [];
  for (let i = 0; i < count; i++) {
    const isSepCycle = m === 9;
    const endY = isSepCycle ? y + 1 : y;
    const endM = isSepCycle ? 2 : 8;
    const start = `${y}-${pad2(m)}-01`;
    const end = lastDayIso(endY, endM);
    windows.push({ key: start, start, end, purchaseDate: end });
    if (isSepCycle) { y = endY; m = 3; } else { y = endY; m = 9; }
  }
  return windows;
}

// Under 423(b) plan rules, the $25,000 IRS purchase limit (= $21,250 contribution cap after the
// 15% discount) is attributed to the calendar year the OFFERING PERIOD begins, not the calendar
// year contributions are withheld -- so for a plan whose offerings start in September and March,
// the real "limit year" runs Sep 1-Aug 31, not Jan-Dec. Its two cycles (Sep-Feb, Mar-Aug) SHARE
// one cap that resets every Sep 1, not split at Dec 31/Jan 1.
function mostRecentSep1OnOrBefore(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  return `${m >= 9 ? y : y - 1}-09-01`;
}

// Simulates ESPP payroll deductions period-by-period across the given cycle windows, applying
// the $21,250/plan-year contribution cap: deductions pause once a plan year's (Sep 1-Aug 31)
// cumulative contribution hits the cap, then resume fresh on the next Sep 1. Uses REAL imported
// payroll data for any period that's actually happened (so the cap-consumption carried into a
// still-open or future cycle reflects what you actually contributed, not a re-guess), and
// `perPeriodRate` (held constant) for periods with no real data yet.
export function simulateEsppCycleContributions(
  payroll: PayrollData | undefined,
  perPeriodRate: number,
  cycles: EsppCycleWindow[],
  annualCap = 21250
): Map<string, number> {
  const result = new Map<string, number>(cycles.map((c) => [c.key, 0]));
  if (!cycles.length) return result;
  const realByEnd = realEsppByPeriodEnd(payroll);
  const [sy, sm] = cycles[0].start.split("-").map(Number);
  const [ey, em] = cycles[cycles.length - 1].end.split("-").map(Number);
  const periods = semiMonthlyPeriods(sy, sm, ey, em);

  // Seed the current plan year's cap consumption with real contributions already made earlier
  // in that plan year, before the simulation window starts (e.g. if it opens mid-cycle in March,
  // seed with the real Sep-Feb contributions from the same Sep 1-Aug 31 plan year).
  const planYearStart = mostRecentSep1OnOrBefore(cycles[0].start);
  let yearCumulative = 0;
  for (const [end, val] of realByEnd) {
    if (end >= planYearStart && end < cycles[0].start) yearCumulative += val;
  }

  for (const p of periods) {
    if (p.start.slice(5) === "09-01") yearCumulative = 0; // new plan year
    const real = realByEnd.get(p.end);
    // NVIDIA doesn't prorate the period that crosses the cap -- it takes that period's full
    // contribution (pushing the running total slightly OVER $21,250), then stops entirely
    // afterward, per the plan's "deductions automatically stop once you reach the limit"
    // behavior (a per-period check, not a within-period proration).
    const contribution = real !== undefined ? real : yearCumulative < annualCap ? perPeriodRate : 0;
    yearCumulative += contribution;
    const cycle = cycles.find((c) => p.start >= c.start && p.start <= c.end);
    if (cycle) result.set(cycle.key, (result.get(cycle.key) ?? 0) + contribution);
  }
  return result;
}

export type PendingEsppCycle = {
  key: string;
  sourceId: string;
  isReal: boolean;
  offeringDate: string;
  purchaseDate: string;
  offeringPrice: number;
  estimatedPurchasePrice: number;
  estimatedShares: number;
  projectedContribution: number;
  dueForConfirm: boolean;
};

// Single source of truth for "what does the estimated pending ESPP position look like" --
// EquityReport.tsx's own pending-cycle table and VaultApp.tsx's Dashboard equity card both call
// this instead of each re-deriving the same 4-cycle projection independently (two copies of this
// logic drifting apart is exactly how the Dashboard's Scheduled Value card went stale). Returns
// every projected cycle (4 per pending purchase, starting from its offering date) -- ALL of them
// count as "Pending", not just the currently-enrolled one.
export function computePendingEsppCycles(
  esppPurchases: EsppPurchase[],
  payroll: PayrollData | undefined,
  today: string,
  projectedCycles = 4,
  annualCap = 21250
): PendingEsppCycle[] {
  const esppPerPeriod = mostRecentEsppPerPeriod(payroll);
  return esppPurchases
    .filter((e) => e.pending)
    .flatMap((e) => {
      const windows = generateEsppCycleWindows(e.offeringDate, projectedCycles);
      const contributionByCycle = simulateEsppCycleContributions(payroll, esppPerPeriod, windows, annualCap);
      const estimatedPurchasePrice = e.offeringPrice * 0.85;
      return windows.map((w, i) => {
        const projectedContribution = contributionByCycle.get(w.key) ?? 0;
        const estimatedShares = estimatedPurchasePrice > 0 ? Math.floor(projectedContribution / estimatedPurchasePrice) : 0;
        return {
          key: `${e.id}-c${i}`,
          sourceId: e.id,
          isReal: i === 0,
          offeringDate: w.start,
          purchaseDate: w.purchaseDate,
          offeringPrice: e.offeringPrice,
          estimatedPurchasePrice,
          estimatedShares,
          projectedContribution,
          dueForConfirm: i === 0 && e.purchaseDate <= today,
        };
      });
    });
}
