import type { Ledger, PayrollData } from "./vault-types";
import { accountNature, ledgerBalanceAsOf, fiscalYearOf } from "./vault-accounting";
import { currentLoanBalance } from "./loans-ledger";
import { computePaymentSplit } from "./loans";
import { parsePeriodRange } from "./payroll-match";
import { todayLocalIso } from "./format-date";
import { periodBoundariesForRange, buildIncomeExpenseColumns } from "./columnar-report";
import { DEPRECIATION_EXPENSE_ACCOUNT_NAME } from "./fixed-assets";
import { budgetVsActualRows } from "./budget";

// Composer, not self-contained -- like lib/multi-year-trend.ts/lib/financial-ratios.ts, this
// imports runtime values from other lib/*.ts files, which node --test can't resolve across
// lib/*.ts files, so this isn't directly unit-tested -- same accepted precedent, verified live
// instead.

export type ForecastPoint = {
  period: string; // "YYYY-MM"
  label: string;
  paycheckNet: number; // projected take-home pay this month, from your real pay pattern
  passiveIncome: number; // projected dividends + interest this month, from trailing history
  livingExpenses: number; // projected recurring living-expense outflow this month (see ExpenseCategory)
  recurringNet: number; // signed: positive = net inflow this month (active MONTHLY Recurring Transactions)
  yearlyNet: number; // signed: yearly Recurring Transactions placed into this specific month, from history (see placeYearlyTemplates)
  loanPayments: number; // total cash outflow across all active loans this month
  projectedCash: number; // running balance at the end of this month
};

export type UnplacedYearlyItem = { label: string; amount: number };

// One recurring living-expense category (e.g. "Household Expenses", "HOA", "Vehicle
// Maintenance") and its projected monthly run-rate, backing the `livingExpenses` total on every
// ForecastPoint -- broken out here so the report can show WHAT it's projecting, not just one
// lump numbers.
export type ExpenseCategory = { label: string; monthlyAverage: number };

// Ties this forecast to the Budget vs Actual report for the CURRENT fiscal year, when one exists
// -- "budgeted net" is what you planned for the whole FY (income minus expense budget lines);
// "YTD actual net" is what's really posted so far this FY; "projected remaining net" is this same
// forecast's own logic (paycheck, dividends/interest, living expenses, recurring, loans) run
// forward only through the rest of THIS fiscal year (not the report's Months Ahead selector,
// which may be shorter or longer than what's left of the FY). varianceVsBudget > 0 means you're
// on track to beat budget for the year; < 0 means you're on track to miss it.
export type BudgetTieIn = {
  fy: string;
  budgetedNet: number;
  ytdActualNet: number;
  projectedRemainingNet: number;
  projectedFYNet: number;
  varianceVsBudget: number;
};

function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}

function lastDayOfMonthDate(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const day = new Date(y, m, 0).getDate();
  return `${yearMonth}-${String(day).padStart(2, "0")}`;
}

// Net cash effect of one occurrence of a recurring template: the sum of -entry.amount for
// whichever of its entries touches a Bank/Cash-nature account (Entry convention: negative=Dr
// increases a Bank/Cash asset, i.e. an inflow) -- mirrors how a real posted voucher's cash leg
// works, just read off the template's entries instead of a posted Tx.
function templateCashEffect(
  entries: { accountId: number; amount: number }[],
  accountById: Map<number, Ledger["accounts"][number]>,
  groupMap: Map<string, { nature: string }>
): number {
  let effect = 0;
  for (const e of entries) {
    const acct = accountById.get(e.accountId);
    if (!acct) continue;
    if (["Bank", "Cash"].includes(accountNature(acct, groupMap))) effect += -e.amount;
  }
  return effect;
}

// Projects your real take-home pay forward: finds the most recently completed pay period in the
// latest imported/entered payroll year, reads its net pay (preferring ManualPayrollPeriod.net --
// a reliable typed field -- over hunting for a "Net Pay" row label, since imported Excel row
// labels are sheet-dependent, not a fixed schema), infers your pay cadence from the gap between
// the last two period start dates, then repeats that same net amount on that same cadence into
// the forecast window. Assumes your pay rate, withholding, and deduction elections (401k, ESPP,
// etc.) stay exactly as they were in that last period -- a raise, a changed election, or a new
// tax bracket won't be reflected until it actually happens and updates your payroll data.
function projectPaycheckFromPayroll(payroll: PayrollData | undefined, startMonth: string, months: number): Map<string, number> {
  const result = new Map<string, number>();
  if (!payroll || payroll.years.length === 0) return result;
  const year = payroll.years[payroll.years.length - 1];

  let lastIdx = -1;
  for (let i = year.periodLabels.length - 1; i >= 0; i--) {
    const hasManual = year.manualPeriods?.some((p) => p.periodIndex === i);
    const hasRowValue = year.rows.some((r) => (r.values[i] || 0) !== 0);
    if (hasManual || hasRowValue) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return result;

  const manual = year.manualPeriods?.find((p) => p.periodIndex === lastIdx);
  let net = manual?.net;
  if (!net) {
    const netRow = year.rows.find((r) => /^net(\s+pay)?$/i.test(r.label.trim()));
    net = netRow?.values[lastIdx];
  }
  if (!net) return result;

  const lastRange = parsePeriodRange(year.periodLabels[lastIdx], year.year);
  if (!lastRange) return result;
  const prevRange = lastIdx > 0 ? parsePeriodRange(year.periodLabels[lastIdx - 1], year.year) : null;
  const cadenceDays = prevRange ? daysBetween(prevRange.start, lastRange.start) : 14; // default: biweekly
  if (cadenceDays <= 0) return result;

  const horizonEndMonth = addMonths(startMonth, months);
  let payDate = lastRange.start;
  while (payDate.slice(0, 7) < horizonEndMonth) {
    payDate = addDays(payDate, cadenceDays);
    const month = payDate.slice(0, 7);
    if (month >= startMonth && month < horizonEndMonth) {
      result.set(month, round2((result.get(month) || 0) + net));
    }
  }
  return result;
}

const PAYCHECK_RE = /salary|payroll|paycheck/i;

function isPaycheckLikeTx(
  t: { narration: string; entries: { accountId: number }[] },
  accountById: Map<number, Ledger["accounts"][number]>,
  groupMap: Map<string, { nature: string }>
): boolean {
  if (PAYCHECK_RE.test(t.narration || "")) return true;
  return t.entries.some((e) => {
    const acct = accountById.get(e.accountId);
    return acct ? accountNature(acct, groupMap) === "Income" && PAYCHECK_RE.test(acct.name) : false;
  });
}

// Every Expense-nature account that shows up as a LEG of a paycheck-like voucher (tax
// withholding, 401(k), ESPP, and whatever else your employer splits out) -- "Projected Paycheck
// (Net)" is already net of all of these, so counting them again as a separate recurring living
// expense would double-subtract them.
function paycheckDeductionAccountIds(data: Ledger, groupMap: Map<string, { nature: string }>): Set<number> {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const ids = new Set<number>();
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (!isPaycheckLikeTx(t, accountById, groupMap)) continue;
    for (const e of t.entries) {
      const acct = accountById.get(e.accountId);
      if (acct && accountNature(acct, groupMap) === "Expense") ids.add(acct.id);
    }
  }
  return ids;
}

// Fallback for when there's no usable structured payroll import: finds vouchers that look like a
// paycheck (narration or the Income-nature leg's account name matching "salary"/"payroll"/
// "paycheck" -- the same naming this app already uses, e.g. Fund Summary's "Salary Income"
// family) and averages the ACTUAL CASH that hit a Bank/Cash account in those vouchers over the
// trailing 3 months into a flat monthly figure. Reading the bank leg rather than the income leg
// means a multi-line paycheck voucher (gross pay split across tax/401k/ESPP deduction lines) still
// nets out to the real take-home amount, not the gross. Less precise than the payroll-data path
// (no separate view of what each deduction was), but still grounded in real posted deposits.
function projectPaycheckFromHistory(data: Ledger, groupMap: Map<string, { nature: string }>, startMonth: string): number {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const windowStart = addMonths(startMonth, -3);
  let total = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    const month = t.date.slice(0, 7);
    if (month < windowStart || month >= startMonth) continue;
    if (!isPaycheckLikeTx(t, accountById, groupMap)) continue;
    for (const e of t.entries) {
      const acct = accountById.get(e.accountId);
      if (!acct || e.amount >= 0) continue; // negative = Dr = cash inflow to this Bank/Cash account
      if (!["Bank", "Cash"].includes(accountNature(acct, groupMap))) continue;
      total += -e.amount;
    }
  }
  return round2(total / 3);
}

// Projects dividends + interest by replaying each forecasted month's actual inflow from the SAME
// calendar month one year ago -- this captures a quarterly dividend's real paying months (and a
// steady small interest credit) without guessing a cadence, since it's just real history repeated
// a year later. Falls back to a flat trailing monthly average when less than 12 months of matched
// history exists. Detection matches EITHER the account name (the common GL convention -- e.g. a
// "Dividend Income"/"Interest Income" ledger) OR the voucher narration containing
// "dividend"/"interest", whichever hits, since either convention shows up in real vaults.
function projectPassiveIncome(data: Ledger, groupMap: Map<string, { nature: string }>, startMonth: string, months: number): Map<string, number> {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const byMonth = new Map<string, number>();
  const PASSIVE_RE = /dividend|interest/i;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    for (const e of t.entries) {
      const acct = accountById.get(e.accountId);
      if (!acct || e.amount >= 0) continue; // negative = Dr = cash/investment inflow
      if (!["Bank", "Cash", "Investment"].includes(accountNature(acct, groupMap))) continue;
      const otherLegMatches = t.entries.some((oe) => {
        if (oe === e) return false;
        const oa = accountById.get(oe.accountId);
        return oa ? PASSIVE_RE.test(oa.name) : false;
      });
      if (!PASSIVE_RE.test(t.narration || "") && !PASSIVE_RE.test(acct.name) && !otherLegMatches) continue;
      const month = t.date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) || 0) + -e.amount);
    }
  }

  const oneYearBack = addMonths(startMonth, -12);
  let trailingTotal = 0;
  let trailingMonths = 0;
  for (const [month, amount] of byMonth) {
    if (month >= oneYearBack && month < startMonth) {
      trailingTotal += amount;
      trailingMonths++;
    }
  }
  const fallbackAvg = trailingMonths > 0 ? trailingTotal / trailingMonths : 0;

  const result = new Map<string, number>();
  for (let i = 0; i < months; i++) {
    const cursor = i === 0 ? startMonth : addMonths(startMonth, i);
    const sameMonthLastYear = addMonths(cursor, -12);
    const historical = byMonth.get(sameMonthLastYear);
    result.set(cursor, round2(historical !== undefined ? historical : fallbackAvg));
  }
  return result;
}

const TRAILING_EXPENSE_WINDOW_MONTHS = 6;
// The "House Hold Exps" family posts to a fresh account each fiscal month (currentMonthSiblingAccount
// in vault-accounting.ts) -- rolled into one line here the same way lib/fund-summary.ts's
// CONSOLIDATED_FAMILIES does, or every sibling would show as its own near-zero-average row instead
// of one real recurring category.
const EXPENSE_FAMILIES: { pattern: RegExp; label: string }[] = [{ pattern: /^house hold exps/i, label: "Household Expenses" }];

// Accounts already counted precisely elsewhere in this forecast -- active Recurring Templates'
// target accounts (monthly and yearly alike), and active loans' own interest-expense accounts.
// Shared by projectLivingExpenses (so it doesn't average them a second time) and
// detectPeriodicExpenseAccounts (so it doesn't also try to detect a periodic pattern in them).
function baseExcludedExpenseAccountIds(data: Ledger, groupMap: Map<string, { nature: string }>): Set<number> {
  const excluded = paycheckDeductionAccountIds(data, groupMap);
  for (const t of (data.recurringTemplates ?? []).filter((t) => t.active)) {
    for (const e of t.entries) excluded.add(e.accountId);
  }
  for (const l of (data.loans ?? []).filter((l) => !l.closed)) {
    if (l.interestExpenseAccountId) excluded.add(l.interestExpenseAccountId);
  }
  return excluded;
}

// Projects your recurring LIVING expenses (household, HOA, vehicle maintenance, utilities,
// subscriptions, everything else posted as a real Expense-nature account) as a trailing 6-month
// monthly average per category, broken out so you can see what's driving the number. Excludes:
// (1) accounts already counted precisely elsewhere -- active Recurring Templates' target
// accounts, monthly AND yearly alike (Recurring Net / Projected Annual Payments already cover
// them), active loans' own interest-expense accounts (Loan Payments already covers them),
// paycheck deduction accounts (tax, 401k, ESPP, etc. -- "Projected Paycheck (Net)" is already net
// of these), and `extraExcludedAccountIds` -- accounts detectPeriodicExpenseAccounts below already
// identified as an infrequent/annual payment (e.g. Property Tax with no Recurring Template set
// up) and placed into its own real month(s) instead, which a flat 6-month average would otherwise
// badly misrepresent; (2) non-cash accruals that would double-count or fabricate a cash outflow
// that never happened -- the shared Depreciation Expense account and each Prepaid Expense's own
// target expense account; (3) any category the user has explicitly dismissed
// (data.cashFlowForecastExclusions) -- e.g. a one-time fee that's now finished, which trailing
// history alone can't tell apart from "still recurring".
function projectLivingExpenses(
  data: Ledger,
  groupMap: Map<string, { nature: string }>,
  startMonth: string,
  extraExcludedAccountIds: Set<number>
): { monthlyTotal: number; categories: ExpenseCategory[] } {
  const windowStart = `${addMonths(startMonth, -TRAILING_EXPENSE_WINDOW_MONTHS)}-01`;
  const windowEnd = lastDayOfMonthDate(addMonths(startMonth, -1));
  if (windowStart > windowEnd) return { monthlyTotal: 0, categories: [] };
  const periods = periodBoundariesForRange(windowStart, windowEnd, "monthly");
  if (periods.length === 0) return { monthlyTotal: 0, categories: [] };
  const { expenseRows } = buildIncomeExpenseColumns(data, periods);

  const excludedAccountIds = baseExcludedExpenseAccountIds(data, groupMap);
  for (const id of extraExcludedAccountIds) excludedAccountIds.add(id);
  for (const pe of data.prepaidExpenses ?? []) excludedAccountIds.add(pe.expenseAccountId);
  const dismissedLabels = new Set((data.cashFlowForecastExclusions ?? []).map((l) => l.toLowerCase()));

  const byLabel = new Map<string, number>();
  for (const row of expenseRows) {
    if (excludedAccountIds.has(row.id)) continue;
    if (row.name === DEPRECIATION_EXPENSE_ACCOUNT_NAME) continue;
    const family = EXPENSE_FAMILIES.find((f) => f.pattern.test(row.name));
    const label = family ? family.label : row.name;
    byLabel.set(label, (byLabel.get(label) || 0) + row.total);
  }

  const categories: ExpenseCategory[] = [...byLabel.entries()]
    .map(([label, total]) => ({ label, monthlyAverage: round2(total / periods.length) }))
    .filter((c) => c.monthlyAverage > 1 && !dismissedLabels.has(c.label.toLowerCase()))
    .sort((a, b) => b.monthlyAverage - a.monthlyAverage);

  const monthlyTotal = round2(categories.reduce((s, c) => s + c.monthlyAverage, 0));
  return { monthlyTotal, categories };
}

const YEARLY_HISTORY_LOOKBACK_YEARS = 5;
// An account averaging this many or fewer POSTINGS PER YEAR (not distinct calendar months -- a
// semi-annual payment whose due date drifts a bit year to year can easily touch 4+ different
// calendar months across a 5-year history while still only ever posting twice a year) is
// infrequent, not a real month-to-month recurring cost. 4 comfortably covers annual/semi-annual/
// quarterly while staying well below anything genuinely monthly (8-12/yr even with some gaps).
const PERIODIC_MAX_AVG_PER_YEAR = 4;

export type AnnualItem = { label: string; months: number[]; totalPerYear: number; monthAmounts: Record<number, number> };

// Finds Expense-nature accounts that are paid once or twice a year -- Property Tax, an annual
// membership, semi-annual insurance -- purely from your real posting history, with NO Recurring
// Template required. This is what `placeYearlyTemplates` below can't catch: a payment you've
// simply been posting by hand every year, never set up as a template for. For each account not
// already excluded (paycheck deductions, monthly/yearly template targets, loan interest,
// depreciation, dismissed categories), buckets its debits by calendar month across the last
// `YEARLY_HISTORY_LOOKBACK_YEARS` years; if its average POSTINGS PER YEAR is
// `PERIODIC_MAX_AVG_PER_YEAR` or fewer, it's periodic -- placed into every matching month in the
// forecast window using that month's own historical average (so a semi-annual payment posted in
// different amounts each half keeps its own two real averages, not one blended number). A
// genuinely monthly expense (HOA, utilities, subscriptions) posts far more often per year and is
// left alone for projectLivingExpenses's trailing average to handle instead.
function detectPeriodicExpenseAccounts(
  data: Ledger,
  groupMap: Map<string, { nature: string }>,
  excludedAccountIds: Set<number>,
  dismissedLabels: Set<string>,
  startMonth: string,
  months: number
): { placedByMonth: Map<string, number>; items: AnnualItem[]; accountIds: Set<number> } {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const cutoff = addMonths(startMonth, -12 * YEARLY_HISTORY_LOOKBACK_YEARS);
  const perAccountMonth = new Map<number, Map<number, { total: number; count: number }>>();
  const perAccountYearMonth = new Map<number, Set<string>>(); // "YYYY-MM" occurrences, for avg-per-year

  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date.slice(0, 7) < cutoff) continue;
    for (const e of t.entries) {
      const acct = accountById.get(e.accountId);
      if (!acct || excludedAccountIds.has(acct.id) || e.amount >= 0) continue; // negative = Dr = expense recognized
      if (accountNature(acct, groupMap) !== "Expense") continue;
      if (acct.name === DEPRECIATION_EXPENSE_ACCOUNT_NAME) continue;
      const mm = Number(t.date.slice(5, 7));
      const perMonth = perAccountMonth.get(acct.id) ?? new Map<number, { total: number; count: number }>();
      const cell = perMonth.get(mm) ?? { total: 0, count: 0 };
      cell.total += -e.amount;
      cell.count += 1;
      perMonth.set(mm, cell);
      perAccountMonth.set(acct.id, perMonth);
      const ymSet = perAccountYearMonth.get(acct.id) ?? new Set<string>();
      ymSet.add(t.date.slice(0, 7));
      perAccountYearMonth.set(acct.id, ymSet);
    }
  }

  const placedByMonth = new Map<string, number>();
  const items: AnnualItem[] = [];
  const accountIds = new Set<number>();

  for (const [acctId, perMonth] of perAccountMonth) {
    if (perMonth.size === 0) continue;
    const yearMonthKeys = perAccountYearMonth.get(acctId)!;
    const years = new Set([...yearMonthKeys].map((k) => k.slice(0, 4)));
    const avgPerYear = yearMonthKeys.size / years.size;
    if (avgPerYear > PERIODIC_MAX_AVG_PER_YEAR) continue;
    accountIds.add(acctId);
    const acct = accountById.get(acctId)!;
    const family = EXPENSE_FAMILIES.find((f) => f.pattern.test(acct.name));
    const label = family ? family.label : acct.name;
    if (dismissedLabels.has(label.toLowerCase())) continue;

    const monthAverages = new Map<number, number>();
    let totalPerYear = 0;
    for (const [mm, cell] of perMonth) {
      const avg = round2(cell.total / cell.count);
      monthAverages.set(mm, avg);
      totalPerYear += avg;
    }
    items.push({
      label,
      months: [...monthAverages.keys()].sort((a, b) => a - b),
      totalPerYear: round2(totalPerYear),
      monthAmounts: Object.fromEntries(monthAverages),
    });

    for (let i = 0; i < months; i++) {
      const cursor = i === 0 ? startMonth : addMonths(startMonth, i);
      const avg = monthAverages.get(Number(cursor.slice(5, 7)));
      if (avg !== undefined) placedByMonth.set(cursor, round2((placedByMonth.get(cursor) || 0) - avg));
    }
  }

  return { placedByMonth, items, accountIds };
}

// Figures out WHICH calendar month a yearly-recurring payment actually falls in, using your real
// posting history, instead of leaving every yearly item unplaced just because
// RecurringTemplate.dayOfMonth is informational-only. Two ways to find the month, in priority
// order: (1) the template's own `postings` log (its txGuid resolved back to that voucher's real
// date) -- the most reliable source, since it's definitionally the same recurring payment; (2)
// if the template has never actually been posted through yet, any historical transaction that
// touches the SAME Expense-nature target account the template debits -- e.g. a "Property Tax" or
// "HOA - Annual" account that already has a few years of real postings from before the template
// existed. Whichever source has data, takes the most common month across up to the last 5 years
// (a mode, not just the latest, so one late/early outlier payment doesn't mislabel the pattern).
// A template with no matching history at all (brand new, never posted, no prior ledger activity)
// genuinely can't be placed -- stays in `unplacedYearly` rather than guessing.
function yearlyTemplateMonth(
  template: { entries: { accountId: number; amount: number }[]; postings: { txGuid: string }[] },
  data: Ledger,
  accountById: Map<number, Ledger["accounts"][number]>,
  groupMap: Map<string, { nature: string }>,
  txByGuid: Map<string, Ledger["transactions"][number]>,
  startMonth: string
): number | null {
  const monthCounts = new Map<number, number>();
  const bump = (dateStr: string) => {
    const mm = Number(dateStr.slice(5, 7));
    monthCounts.set(mm, (monthCounts.get(mm) || 0) + 1);
  };

  for (const posting of template.postings) {
    const tx = txByGuid.get(posting.txGuid);
    if (tx && !tx.deleted && !tx.cancelled) bump(tx.date);
  }

  if (monthCounts.size === 0) {
    const targetAccountIds = new Set(
      template.entries
        .filter((e) => {
          const acct = accountById.get(e.accountId);
          return acct && accountNature(acct, groupMap) === "Expense";
        })
        .map((e) => e.accountId)
    );
    if (targetAccountIds.size > 0) {
      const cutoff = addMonths(startMonth, -12 * YEARLY_HISTORY_LOOKBACK_YEARS);
      for (const t of data.transactions) {
        if (t.deleted || t.cancelled) continue;
        if (t.date.slice(0, 7) < cutoff) continue;
        if (t.entries.some((e) => targetAccountIds.has(e.accountId))) bump(t.date);
      }
    }
  }

  if (monthCounts.size === 0) return null;
  let bestMonth = 1;
  let bestCount = 0;
  for (const [mm, count] of monthCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestMonth = mm;
    }
  }
  return bestMonth;
}

// Places each active yearly Recurring Template into every forecasted month that matches its
// detected recurrence month (see yearlyTemplateMonth) -- a 6-month forecast crossing one such
// month gets it once; a 13-month forecast crossing it twice gets it twice, same as it would
// really happen. Templates with no detectable month stay in `unplacedYearly`, listed separately
// so nothing silently disappears from the report.
function placeYearlyTemplates(
  data: Ledger,
  groupMap: Map<string, { nature: string }>,
  startMonth: string,
  months: number
): { placedByMonth: Map<string, number>; items: AnnualItem[]; unplacedYearly: UnplacedYearlyItem[] } {
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const txByGuid = new Map(data.transactions.map((t) => [t.guid, t]));
  const placedByMonth = new Map<string, number>();
  const items: AnnualItem[] = [];
  const unplacedYearly: UnplacedYearlyItem[] = [];

  for (const t of (data.recurringTemplates ?? []).filter((t) => t.active && t.frequency === "yearly")) {
    const amount = round2(templateCashEffect(t.entries, accountById, groupMap));
    const mm = yearlyTemplateMonth(t, data, accountById, groupMap, txByGuid, startMonth);
    if (mm === null) {
      unplacedYearly.push({ label: t.label, amount });
      continue;
    }
    items.push({ label: t.label, months: [mm], totalPerYear: amount, monthAmounts: { [mm]: amount } });
    for (let i = 0; i < months; i++) {
      const cursor = i === 0 ? startMonth : addMonths(startMonth, i);
      if (Number(cursor.slice(5, 7)) === mm) {
        placedByMonth.set(cursor, round2((placedByMonth.get(cursor) || 0) + amount));
      }
    }
  }

  return { placedByMonth, items, unplacedYearly };
}

// Runs this forecast's own projection logic (paycheck, dividends/interest, living expenses,
// recurring templates, loans) over its OWN horizon -- from today through the end of the current
// fiscal year -- independent of the report's Months Ahead selector, so the tie-in is always
// accurate for "how does the rest of THIS fiscal year look" regardless of what the on-screen
// table happens to be showing.
function computeBudgetTieIn(
  data: Ledger,
  groupMap: Map<string, { nature: string }>,
  startMonth: string,
  todayStr: string
): BudgetTieIn | null {
  const fy = fiscalYearOf(todayStr);
  const budget = (data.budgets ?? []).find((b) => b.fy === String(fy));
  if (!budget) return null;

  const { incomeRows, expenseRows } = budgetVsActualRows(data, budget, String(fy), "monthly");
  const budgetedNet = round2(
    incomeRows.reduce((s, r) => s + r.totalBudget, 0) - expenseRows.reduce((s, r) => s + r.totalBudget, 0)
  );
  const ytdActualNet = round2(
    incomeRows.reduce((s, r) => s + r.totalActual, 0) - expenseRows.reduce((s, r) => s + r.totalActual, 0)
  );

  const fyEndMonth = `${fy + 1}-03`;
  let remainingMonths = 0;
  for (let cursor = startMonth; cursor <= fyEndMonth; cursor = addMonths(cursor, 1)) remainingMonths++;

  if (remainingMonths <= 0) {
    return { fy: String(fy), budgetedNet, ytdActualNet, projectedRemainingNet: 0, projectedFYNet: ytdActualNet, varianceVsBudget: round2(ytdActualNet - budgetedNet) };
  }

  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const monthlyTemplates = (data.recurringTemplates ?? []).filter((t) => t.active && t.frequency === "monthly");
  const monthlyCashNet = round2(monthlyTemplates.reduce((s, t) => s + templateCashEffect(t.entries, accountById, groupMap), 0));
  const dismissedLabels = new Set((data.cashFlowForecastExclusions ?? []).map((l) => l.toLowerCase()));
  const baseExcluded = baseExcludedExpenseAccountIds(data, groupMap);
  for (const pe of data.prepaidExpenses ?? []) baseExcluded.add(pe.expenseAccountId);
  const periodic = detectPeriodicExpenseAccounts(data, groupMap, baseExcluded, dismissedLabels, startMonth, remainingMonths);
  const { placedByMonth: templateYearlyByMonth } = placeYearlyTemplates(data, groupMap, startMonth, remainingMonths);
  const yearlyByMonth = new Map(templateYearlyByMonth);
  for (const [k, v] of periodic.placedByMonth) yearlyByMonth.set(k, round2((yearlyByMonth.get(k) || 0) + v));
  const paycheckByMonth = projectPaycheckFromPayroll(data.payroll, startMonth, remainingMonths);
  const hasPayrollPaycheck = [...paycheckByMonth.values()].some((v) => v > 0);
  const fallbackPaycheck = hasPayrollPaycheck ? 0 : projectPaycheckFromHistory(data, groupMap, startMonth);
  const passiveByMonth = projectPassiveIncome(data, groupMap, startMonth, remainingMonths);
  const { monthlyTotal: livingExpenseMonthly } = projectLivingExpenses(data, groupMap, startMonth, periodic.accountIds);

  const activeLoans = (data.loans ?? []).filter((l) => !l.closed);
  const loanBalances = new Map(activeLoans.map((l) => [l.id, currentLoanBalance(data, l, todayStr)]));

  let projectedRemainingNet = 0;
  for (let i = 0; i < remainingMonths; i++) {
    const cursor = i === 0 ? startMonth : addMonths(startMonth, i);
    let loanOutflow = 0;
    for (const loan of activeLoans) {
      const balance = loanBalances.get(loan.id) ?? 0;
      if (balance <= 0.5) continue;
      const { principal, interest } = computePaymentSplit(balance, loan.annualRate, loan.standardPayment);
      const payment = Math.min(loan.standardPayment, balance + interest);
      loanOutflow += payment;
      loanBalances.set(loan.id, round2(balance - principal));
    }
    const paycheckNet = (paycheckByMonth.get(cursor) || 0) + fallbackPaycheck;
    const passiveIncome = passiveByMonth.get(cursor) || 0;
    const yearlyNet = yearlyByMonth.get(cursor) || 0;
    projectedRemainingNet += paycheckNet + passiveIncome + monthlyCashNet + yearlyNet - loanOutflow - livingExpenseMonthly;
  }
  projectedRemainingNet = round2(projectedRemainingNet);
  const projectedFYNet = round2(ytdActualNet + projectedRemainingNet);
  return { fy: String(fy), budgetedNet, ytdActualNet, projectedRemainingNet, projectedFYNet, varianceVsBudget: round2(projectedFYNet - budgetedNet) };
}

export function computeCashFlowForecast(
  data: Ledger,
  months: number
): {
  points: ForecastPoint[];
  unplacedYearly: UnplacedYearlyItem[];
  expenseCategories: ExpenseCategory[];
  annualItems: AnnualItem[];
  budgetTieIn: BudgetTieIn | null;
} {
  const groupMap = new Map((data.groups ?? []).map((g) => [g.name.toLowerCase(), { nature: g.nature }]));
  const todayStr = todayLocalIso();
  const startMonth = todayStr.slice(0, 7);

  let startingCash = 0;
  for (const a of data.accounts) {
    if (a.active === false) continue;
    if (!["Bank", "Cash"].includes(accountNature(a, groupMap))) continue;
    startingCash += ledgerBalanceAsOf(data, a.id, todayStr);
  }

  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const monthlyTemplates = (data.recurringTemplates ?? []).filter((t) => t.active && t.frequency === "monthly");
  const monthlyCashNet = round2(monthlyTemplates.reduce((s, t) => s + templateCashEffect(t.entries, accountById, groupMap), 0));

  const dismissedLabels = new Set((data.cashFlowForecastExclusions ?? []).map((l) => l.toLowerCase()));
  const baseExcluded = baseExcludedExpenseAccountIds(data, groupMap);
  for (const pe of data.prepaidExpenses ?? []) baseExcluded.add(pe.expenseAccountId);
  const periodic = detectPeriodicExpenseAccounts(data, groupMap, baseExcluded, dismissedLabels, startMonth, months);
  const { placedByMonth: templateYearlyByMonth, items: templateAnnualItems, unplacedYearly } = placeYearlyTemplates(
    data,
    groupMap,
    startMonth,
    months
  );
  const yearlyByMonth = new Map(templateYearlyByMonth);
  for (const [k, v] of periodic.placedByMonth) yearlyByMonth.set(k, round2((yearlyByMonth.get(k) || 0) + v));
  const annualItems: AnnualItem[] = [...templateAnnualItems, ...periodic.items].sort((a, b) => b.totalPerYear - a.totalPerYear);

  const activeLoans = (data.loans ?? []).filter((l) => !l.closed);
  const loanBalances = new Map(activeLoans.map((l) => [l.id, currentLoanBalance(data, l, todayStr)]));

  const paycheckByMonth = projectPaycheckFromPayroll(data.payroll, startMonth, months);
  const hasPayrollPaycheck = [...paycheckByMonth.values()].some((v) => v > 0);
  const fallbackPaycheck = hasPayrollPaycheck ? 0 : projectPaycheckFromHistory(data, groupMap, startMonth);

  const passiveByMonth = projectPassiveIncome(data, groupMap, startMonth, months);
  const { monthlyTotal: livingExpenseMonthly, categories: expenseCategories } = projectLivingExpenses(
    data,
    groupMap,
    startMonth,
    periodic.accountIds
  );

  const points: ForecastPoint[] = [];
  let runningCash = startingCash;
  let cursor = startMonth;
  for (let i = 0; i < months; i++) {
    cursor = i === 0 ? startMonth : addMonths(startMonth, i);

    let loanOutflow = 0;
    for (const loan of activeLoans) {
      const balance = loanBalances.get(loan.id) ?? 0;
      if (balance <= 0.5) continue;
      const { principal, interest } = computePaymentSplit(balance, loan.annualRate, loan.standardPayment);
      const payment = Math.min(loan.standardPayment, balance + interest);
      loanOutflow += payment;
      loanBalances.set(loan.id, round2(balance - principal));
    }

    const paycheckNet = (paycheckByMonth.get(cursor) || 0) + fallbackPaycheck;
    const passiveIncome = passiveByMonth.get(cursor) || 0;
    const yearlyNet = yearlyByMonth.get(cursor) || 0;
    runningCash = round2(runningCash + paycheckNet + passiveIncome + monthlyCashNet + yearlyNet - loanOutflow - livingExpenseMonthly);
    points.push({
      period: cursor,
      label: monthLabel(cursor),
      paycheckNet: round2(paycheckNet),
      passiveIncome: round2(passiveIncome),
      livingExpenses: livingExpenseMonthly,
      recurringNet: monthlyCashNet,
      yearlyNet: round2(yearlyNet),
      loanPayments: round2(loanOutflow),
      projectedCash: runningCash,
    });
  }

  const budgetTieIn = computeBudgetTieIn(data, groupMap, startMonth, todayStr);

  return { points, unplacedYearly, expenseCategories, annualItems, budgetTieIn };
}
