import type { Ledger } from "./vault-types";
import { computeNetWorthTrend } from "./net-worth-trend";
import { buildIncomeExpenseColumns, type PeriodBoundary } from "./columnar-report";

export type FyTrendPoint = {
  fy: string; // e.g. "2025" -- Apr-start FY key, same convention used everywhere else this session
  label: string; // "FYxx-yy", from computeNetWorthTrend
  income: number;
  expense: number;
  surplus: number;
  savingsRate: number | null; // surplus / income * 100, null when income is ~0
  netWorth: number;
  // null for the earliest year available -- nothing to compare against
  incomeGrowthPct: number | null;
  expenseGrowthPct: number | null;
  netWorthGrowthPct: number | null;
  // For drilldown -- which accounts fed into this year's income/expense totals.
  incomeAccountIds: number[];
  expenseAccountIds: number[];
  start: string;
  end: string;
};

const TOL = 0.005;

function growthPct(curr: number, prev: number): number | null {
  if (Math.abs(prev) <= TOL) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

// One row per fiscal year the ledger has transaction history for, oldest first -- reuses
// computeNetWorthTrend as the FY backbone (it already derives "which FYs have data" and the
// assets/liabilities/net worth walk) and buildIncomeExpenseColumns for that year's income/expense
// totals, rather than re-deriving fiscal-year discovery or Income/Expense classification here.
export function computeMultiYearTrend(data: Ledger): FyTrendPoint[] {
  const nwPoints = computeNetWorthTrend(data.accounts, data.transactions, data.groups ?? []);

  const points: FyTrendPoint[] = nwPoints.map((p) => {
    const fy = String(Number(p.fyEndDate.slice(0, 4)) - 1);
    const period: PeriodBoundary = { key: fy, label: p.label, start: `${fy}-04-01`, end: p.fyEndDate };
    const { incomeRows, expenseRows } = buildIncomeExpenseColumns(data, [period]);
    const income = incomeRows.reduce((s, r) => s + (r.values[fy] || 0), 0);
    const expense = expenseRows.reduce((s, r) => s + (r.values[fy] || 0), 0);
    const surplus = income - expense;
    return {
      fy,
      label: p.label,
      income,
      expense,
      surplus,
      savingsRate: Math.abs(income) > TOL ? (surplus / income) * 100 : null,
      netWorth: p.netWorth,
      incomeGrowthPct: null,
      expenseGrowthPct: null,
      netWorthGrowthPct: null,
      incomeAccountIds: incomeRows.map((r) => r.id),
      expenseAccountIds: expenseRows.map((r) => r.id),
      start: period.start,
      end: period.end,
    };
  });

  for (let i = 1; i < points.length; i++) {
    points[i].incomeGrowthPct = growthPct(points[i].income, points[i - 1].income);
    points[i].expenseGrowthPct = growthPct(points[i].expense, points[i - 1].expense);
    points[i].netWorthGrowthPct = growthPct(points[i].netWorth, points[i - 1].netWorth);
  }

  return points;
}
