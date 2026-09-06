import type { Budget, BudgetLine, Ledger } from "./vault-types";
import { buildIncomeExpenseColumns, isProfitLoss, natureFor, periodBoundariesForRange, type PeriodBoundary } from "./columnar-report";

// The 12 monthly (or 4 quarterly) periods for a given Apr-start fiscal year -- shared by budget
// generation and the actual-vs-budget comparison so both sides bucket by the exact same
// [start, end] windows as the rest of the columnar reporting.
export function periodsForFy(fy: string, granularity: "monthly" | "quarterly" = "monthly"): PeriodBoundary[] {
  return periodBoundariesForRange(`${fy}-04-01`, `${Number(fy) + 1}-03-31`, granularity);
}

// Rolls a template's 12 stored monthly values up into whatever `periods` are being displayed --
// 1:1 for monthly, summed in groups of 3 for quarterly. Safe because Budget vs Actual is always
// gated to a plain 4-digit FY (never a custom/partial range), so the monthly array's index order
// (Apr..Mar) always lines up with periodsForFy's quarterly grouping (Q1=Apr-Jun ... Q4=Jan-Mar).
function bucketMonthly(monthly: number[], periods: PeriodBoundary[]): number[] {
  if (periods.length === 12) return monthly;
  const perPeriod = Math.round(monthly.length / periods.length) || 1;
  return periods.map((_, i) => monthly.slice(i * perPeriod, i * perPeriod + perPeriod).reduce((s, v) => s + v, 0));
}

// Seeds a new budget's lines from a prior fiscal year's actuals -- one line per account that had
// Income/Expense activity that year, monthly[] taken directly from that account's 12 per-period
// actual values (in FY month order). Accounts with no activity in `fromFy` are simply absent;
// they can still be added to the budget once they appear in the target FY's own actuals.
export function generateBudgetFromActuals(data: Ledger, fromFy: string): BudgetLine[] {
  const periods = periodsForFy(fromFy, "monthly");
  const { incomeRows, expenseRows } = buildIncomeExpenseColumns(data, periods);
  const toLines = (rows: typeof incomeRows): BudgetLine[] =>
    rows.map((r) => ({
      id: `budget-${r.id}`,
      accountId: r.id,
      monthly: periods.map((p) => Math.max(0, r.values[p.key] || 0)),
    }));
  return [...toLines(incomeRows), ...toLines(expenseRows)];
}

export type BudgetRow = {
  id: number;
  name: string;
  parent: string;
  category: string;
  monthlyBudget: number[];
  monthlyActual: number[];
  totalBudget: number;
  totalActual: number;
  varianceAmt: number;
  variancePct: number | null; // null when totalBudget is 0 (percent is meaningless)
};

const TOL = 0.005;

// Joins the current FY's actuals (via the same columnar engine every other report uses) with the
// saved budget's lines by accountId. Unlike a plain left-join off the actuals, this also includes
// accounts that have a budget but NO activity yet this FY -- "under budget" only means something
// if the row is still visible when nothing's been spent.
export function budgetVsActualRows(
  data: Ledger,
  budget: Budget | undefined,
  fy: string,
  granularity: "monthly" | "quarterly" = "monthly"
): { incomeRows: BudgetRow[]; expenseRows: BudgetRow[]; periods: PeriodBoundary[] } {
  const periods = periodsForFy(fy, granularity);
  const { incomeRows: actualIncome, expenseRows: actualExpense } = buildIncomeExpenseColumns(data, periods);
  const actualById = new Map([...actualIncome, ...actualExpense].map((r) => [r.id, r]));
  const budgetByAccount = new Map((budget?.lines ?? []).map((l) => [l.accountId, bucketMonthly(l.monthly, periods)]));
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const relevantIds = new Set<number>([...actualById.keys(), ...budgetByAccount.keys()]);

  const incomeRows: BudgetRow[] = [];
  const expenseRows: BudgetRow[] = [];
  for (const id of relevantIds) {
    const account = accountById.get(id);
    if (!account || isProfitLoss(account.name)) continue;
    const nature = natureFor(account, data.groups);
    if (nature !== "Income" && nature !== "Expense") continue;

    const actual = actualById.get(id);
    const monthlyActual = periods.map((p) => actual?.values[p.key] || 0);
    const monthlyBudget = budgetByAccount.get(id) ?? periods.map(() => 0);
    const totalBudget = monthlyBudget.reduce((s, v) => s + v, 0);
    const totalActual = monthlyActual.reduce((s, v) => s + v, 0);
    if (Math.abs(totalBudget) <= TOL && Math.abs(totalActual) <= TOL) continue;

    const varianceAmt = totalActual - totalBudget;
    const row: BudgetRow = {
      id,
      name: account.name,
      parent: account.parent,
      category: account.category,
      monthlyBudget,
      monthlyActual,
      totalBudget,
      totalActual,
      varianceAmt,
      variancePct: Math.abs(totalBudget) > TOL ? (varianceAmt / totalBudget) * 100 : null,
    };
    (nature === "Income" ? incomeRows : expenseRows).push(row);
  }
  incomeRows.sort((a, b) => a.name.localeCompare(b.name));
  expenseRows.sort((a, b) => a.name.localeCompare(b.name));

  return { incomeRows, expenseRows, periods };
}
