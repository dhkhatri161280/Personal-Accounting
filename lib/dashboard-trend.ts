// Small, pure helpers for the Dashboard's hero-card "vs last month" trend indicator. Kept
// separate from VaultApp.tsx's own `calc` so the balance math can be unit tested directly
// against known transaction sequences, the same way the rest of this app's ledger math is
// tested -- a wrong number here would be actively misleading on a personal finance dashboard,
// not just a cosmetic bug.

import type { Ledger } from "./vault-types.ts";
import { isFiscalYearAlreadyClosed } from "./vault-accounting.ts";

export interface TrendTx {
  date: string;
  deleted?: boolean;
  cancelled?: boolean;
  entries: { accountId: number; amount: number }[];
}

export interface TrendAccount {
  id: number;
  openingBalance: number;
}

/** Cumulative ledger balance for a set of accounts as of (and including) cutoffDate --
 * openingBalance plus every non-deleted, non-cancelled entry dated on or before cutoffDate.
 * Mirrors VaultApp.tsx's own `calc`: its `closing = opening - debit + credit` reduces to
 * exactly `opening + sum(entry.amount)` once you substitute how debit/credit are split from a
 * signed amount, so this is the same balance calc's `closing` map converges to, just re-run at
 * an arbitrary earlier cutoff instead of the currently-selected period's end. */
export function closingBalanceAsOf(
  accounts: TrendAccount[],
  transactions: TrendTx[],
  accountIds: ReadonlySet<number>,
  cutoffDate: string
): number {
  const bal = new Map<number, number>();
  for (const a of accounts) if (accountIds.has(a.id)) bal.set(a.id, a.openingBalance);
  for (const t of transactions) {
    if (t.deleted || t.cancelled || t.date > cutoffDate) continue;
    for (const e of t.entries) {
      if (!bal.has(e.accountId)) continue;
      bal.set(e.accountId, (bal.get(e.accountId) ?? 0) + e.amount);
    }
  }
  let sum = 0;
  for (const v of bal.values()) sum += v;
  return sum;
}

/** Raw signed sum of entry.amount for a set of accounts, restricted to entries dated within
 * [startDate, endDate] inclusive -- the same window-restricted sum VaultApp.tsx's own
 * `capitalTransfer` uses for "this FY's not-yet-closed nominal (Income/Expense) activity." */
export function sumEntriesInRange(
  transactions: TrendTx[],
  accountIds: ReadonlySet<number>,
  startDate: string,
  endDate: string
): number {
  let sum = 0;
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < startDate || t.date > endDate) continue;
    for (const e of t.entries) if (accountIds.has(e.accountId)) sum += e.amount;
  }
  return sum;
}

/** The last day of the calendar month before `todayIso` (e.g. "2026-09-25" -> "2026-08-31") --
 * the comparison point for the Dashboard's "vs last month" trend. Deliberately calendar-month,
 * not tied to the currently-selected Financial period: it stays well-defined regardless of
 * whether the header's period selector is on a fiscal year, a single month, a custom range, or
 * "all", and matches the everyday meaning of a "vs last month" KPI-card trend. */
export function lastMonthEndCutoff(todayIso: string): string {
  const [y, m] = todayIso.split("-").map(Number);
  const firstOfThisMonth = new Date(Date.UTC(y, m - 1, 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
  return lastOfPrevMonth.toISOString().slice(0, 10);
}

export interface DashboardTrendInput {
  data: Ledger;
  /** VaultApp's "Financial period" selector state -- a plain 4-digit FY string ("2026"), a
   * "YYYY-MM" single month, "custom", or "all". */
  year: string;
  todayIso: string;
  cashIds: ReadonlySet<number>;
  capitalIds: ReadonlySet<number>;
  /** Income + Expense account ids -- VaultApp.tsx's own `nominalIds`. */
  nominalIds: ReadonlySet<number>;
  /** The Dashboard's own already-computed "Cash and bank closing" / "Capital closing" headline
   * values, so the trend is guaranteed to diff against exactly what's on screen. */
  cashBank: number;
  dashboardCapitalTotal: number;
}

export interface DashboardTrendResult {
  cashTrend?: number;
  capitalTrend?: number;
}

/** "vs last calendar month" delta for the Cash and Capital hero cards. Scoped to a plain FY
 * selection only (returns {} for "all"/"custom"/a single month) -- Capital's own headline value
 * branches on `year` between the not-yet-closed period's `capitalTransfer` (FY view) and
 * `periodSurplus` (month/custom/all view); correctly replicating that branch AND its
 * fiscal-year-close double-count guard (see isFiscalYearAlreadyClosed's own comment -- a real
 * bug already hit once for the live headline number itself) for an arbitrary earlier cutoff is
 * only done here for the FY case. Cash has no such branch and would be safe in any view, but is
 * gated the same way so there's one consistent rule for when a trend does or doesn't appear. */
export function computeDashboardTrend(input: DashboardTrendInput): DashboardTrendResult {
  const { data, year, todayIso, cashIds, capitalIds, nominalIds, cashBank, dashboardCapitalTotal } = input;
  const lastMonthEnd = lastMonthEndCutoff(todayIso);
  const trendFyStart = /^\d{4}$/.test(year) ? `${year}-04-01` : null;
  if (trendFyStart === null || lastMonthEnd < trendFyStart) return {};

  const cashBankPrior = -closingBalanceAsOf(data.accounts, data.transactions, cashIds, lastMonthEnd);
  const cashTrend = cashBank - cashBankPrior;

  const capitalClosingPrior = closingBalanceAsOf(data.accounts, data.transactions, capitalIds, lastMonthEnd);
  const fy = Number(year),
    fyEnd = `${fy + 1}-03-31`,
    alreadyClosedPrior = lastMonthEnd >= fyEnd && isFiscalYearAlreadyClosed(data, fy),
    transferPrior = alreadyClosedPrior ? 0 : sumEntriesInRange(data.transactions, nominalIds, trendFyStart, lastMonthEnd),
    capitalTotalPrior = capitalClosingPrior + transferPrior;
  const capitalTrend = dashboardCapitalTotal - capitalTotalPrior;

  return { cashTrend, capitalTrend };
}
