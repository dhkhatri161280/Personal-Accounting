import type { Ledger } from "./vault-types.ts";
import { accountNature } from "./vault-accounting.ts";

// Helper for FinCEN Form 114 (FBAR) -- a US person with a financial interest in (or signature
// authority over) foreign financial accounts whose combined value exceeded $10,000 at any point
// during the calendar year must file. This module only computes the NUMBERS a filer needs (each
// account's maximum value during the year, converted to USD); it does not file anything -- FBARs
// are filed electronically through FinCEN's own BSA E-Filing System (bsaefiling.fincen.gov), not
// through this app, and there's no API this app could submit to even if it wanted to.
//
// Two rules specific to FBAR (confirmed against FinCEN/Treasury guidance, NOT the IRS's own
// year-average rate used for income tax conversions, which is a different number for the exact
// same calendar year):
//   1. Per account, find the single HIGHEST balance it reached at any point during the calendar
//      year, in its native currency -- not the Dec 31 closing balance, and not an average.
//   2. Convert that one native-currency peak to USD using the Treasury's own "Reporting Rates of
//      Exchange" rate as of December 31 of the year being reported -- even if the real peak
//      happened on a different day with a different actual exchange rate.

// Treasury Reporting Rate of Exchange, INR per USD, as of December 31 of each year -- published
// quarterly by the Bureau of the Fiscal Service (api.fiscaldata.treasury.gov). Hardcoded rather
// than fetched live since this app has no outbound network access at runtime; pulled directly
// from the Fiscal Data API (filter=country:eq:India,record_calendar_month:eq:12,
// record_calendar_day:eq:31) covering every year that API has on file (back to 2001). Add the
// next year's rate here once Treasury publishes it (typically a few weeks into the following
// January).
const TREASURY_SOURCE = "US Treasury Bureau of the Fiscal Service, Reporting Rates of Exchange (api.fiscaldata.treasury.gov)";
function yearEndRate(year: number, rate: number): { rate: number; asOf: string; source: string } {
  const asOf = `${year}-12-31`;
  return { rate, asOf, source: `${TREASURY_SOURCE}, record_date ${asOf}` };
}
export const TREASURY_YEAR_END_RATE_INR: Record<number, { rate: number; asOf: string; source: string }> = {
  2025: yearEndRate(2025, 89.854),
  2024: yearEndRate(2024, 85.577),
  2023: yearEndRate(2023, 83.162),
  2022: yearEndRate(2022, 82.599),
  2021: yearEndRate(2021, 74.343),
  2020: yearEndRate(2020, 73.034),
  2019: yearEndRate(2019, 71.0),
  2018: yearEndRate(2018, 69.8),
  2017: yearEndRate(2017, 63.75),
  2016: yearEndRate(2016, 67.8),
  2015: yearEndRate(2015, 66.1),
  2014: yearEndRate(2014, 63.2),
  2013: yearEndRate(2013, 61.5),
  2012: yearEndRate(2012, 54.45),
  2011: yearEndRate(2011, 52.25),
  2010: yearEndRate(2010, 45.7),
  2009: yearEndRate(2009, 46.4),
  2008: yearEndRate(2008, 48.2),
  2007: yearEndRate(2007, 39.55),
  2006: yearEndRate(2006, 44.05),
  2005: yearEndRate(2005, 44.9),
  2004: yearEndRate(2004, 44.6),
  2003: yearEndRate(2003, 45.4),
  2002: yearEndRate(2002, 47.84),
  2001: yearEndRate(2001, 47.9),
};

// FBAR's own aggregation threshold -- combined value of every foreign account, not any one
// account alone.
export const FBAR_THRESHOLD_USD = 10_000;

export type FbarAccountRow = {
  accountId: number;
  name: string;
  parent: string;
  nature: string;
  treatment: "include" | "exclude" | "manual";
  // For treatment "include": this ledger's own computed peak. For "manual": the entered value for
  // this calendar year (0 if none entered yet -- see needsManualValue). For "exclude": 0, unused.
  maxBalanceNative: number;
  maxBalanceDate: string | null; // null when the peak is the opening balance itself (no transactions moved it within the year), or when manual/excluded
  maxBalanceUsd: number;
  // "manual" treatment with no fbarManualValuesInr entry for this specific calendar year yet --
  // the account IS a real reportable foreign financial account, but the number is still missing,
  // so it must not silently read as $0 and get lost in the total.
  needsManualValue: boolean;
};

// The highest balance `accountId` reached at any point within [startDate, endDate] (inclusive),
// in the account's own stored sign convention negated to a normal positive display balance (same
// convention as lib/vault-accounting.ts's own ledgerBalanceAsOf). Single pass over the whole
// transaction list, carrying the running balance forward from the window's own opening value --
// deliberately NOT N separate ledgerBalanceAsOf(..., eachDay) calls, which would be the same
// O(transactions) work repeated for every single day of the year for no reason.
export function maxBalanceInRange(
  data: Pick<Ledger, "accounts" | "transactions">,
  accountId: number,
  startDate: string,
  endDate: string
): { max: number; maxDate: string | null } {
  const account = data.accounts.find((a) => a.id === accountId);
  let raw = account?.openingBalance || 0;
  // Carry forward every entry dated BEFORE the window to get this account's true balance at the
  // instant the window starts.
  const sorted = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.entries.some((e) => e.accountId === accountId))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of sorted) {
    if (t.date >= startDate) break;
    for (const e of t.entries) if (e.accountId === accountId) raw += e.amount;
  }
  let max = -raw; // the window's own opening balance is always a candidate (e.g. no activity all year)
  let maxDate: string | null = null;
  for (const t of sorted) {
    if (t.date < startDate || t.date > endDate) continue;
    for (const e of t.entries) if (e.accountId === accountId) raw += e.amount;
    const bal = -raw;
    if (bal > max) {
      max = bal;
      maxDate = t.date;
    }
  }
  return { max, maxDate };
}

// Every account whose peak CY balance a US person needs to report -- scoped to accounts an
// Indian bank/financial institution actually holds (Bank or Investment nature; deliberately
// EXCLUDES Cash-in-hand, which is physical cash, not a foreign financial account at all, and
// anything already classified Expense/Income/Liability/Capital). The caller decides which rows
// are genuinely reportable foreign accounts -- this just surfaces every candidate with its
// computed peak so nothing has to be found by hand.
export function computeFbarSummary(
  data: Pick<Ledger, "accounts" | "transactions" | "groups">,
  calendarYear: number,
  // Used only as a fallback for a year not yet in TREASURY_YEAR_END_RATE_INR above -- see
  // app/api/fbar-rate/route.ts and FbarReport.tsx's own fetch-once effect. Stays a plain
  // parameter (not this function reaching out to fetch() itself) so this stays synchronous and
  // trivially unit-testable; the live fetch is the UI layer's job, not this pure computation's.
  liveRateOverride?: { rate: number; asOf: string; source: string } | null
): { rows: FbarAccountRow[]; totalUsd: number; thresholdExceeded: boolean; rate: { rate: number; asOf: string; source: string } | null } {
  const rateInfo = TREASURY_YEAR_END_RATE_INR[calendarYear] ?? liveRateOverride ?? null;
  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g as unknown as { nature: string }]));
  const startDate = `${calendarYear}-01-01`;
  const endDate = `${calendarYear}-12-31`;
  const yearKey = String(calendarYear);

  const rows: FbarAccountRow[] = [];
  for (const a of data.accounts) {
    if (a.active === false) continue;
    const nature = accountNature(a, masterGroups);
    if (nature !== "Bank" && nature !== "Investment") continue;
    const treatment = a.fbarTreatment ?? "include";

    if (treatment === "exclude") {
      rows.push({
        accountId: a.id, name: a.name, parent: a.parent || "", nature, treatment,
        maxBalanceNative: 0, maxBalanceDate: null, maxBalanceUsd: 0, needsManualValue: false,
      });
      continue;
    }
    if (treatment === "manual") {
      const manualValue = a.fbarManualValuesInr?.[yearKey];
      const needsManualValue = manualValue === undefined;
      rows.push({
        accountId: a.id, name: a.name, parent: a.parent || "", nature, treatment,
        maxBalanceNative: manualValue ?? 0,
        maxBalanceDate: null,
        maxBalanceUsd: rateInfo && manualValue !== undefined ? manualValue / rateInfo.rate : 0,
        needsManualValue,
      });
      continue;
    }
    const { max, maxDate } = maxBalanceInRange(data, a.id, startDate, endDate);
    rows.push({
      accountId: a.id,
      name: a.name,
      parent: a.parent || "",
      nature,
      treatment,
      maxBalanceNative: max,
      maxBalanceDate: maxDate,
      maxBalanceUsd: rateInfo ? max / rateInfo.rate : 0,
      needsManualValue: false,
    });
  }
  rows.sort((x, y) => y.maxBalanceUsd - x.maxBalanceUsd);
  // Excluded rows and not-yet-entered manual rows contribute nothing to the total -- excluded by
  // definition, and a missing manual value must never silently count as $0 of real value.
  const totalUsd = rows.reduce((s, r) => (r.treatment === "exclude" || r.needsManualValue ? s : s + r.maxBalanceUsd), 0);
  return { rows, totalUsd, thresholdExceeded: totalUsd > FBAR_THRESHOLD_USD, rate: rateInfo };
}
