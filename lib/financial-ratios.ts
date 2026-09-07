import type { Ledger } from "./vault-types";
import { computeMultiYearTrend, type FyTrendPoint } from "./multi-year-trend";
import { accountNature, ledgerBalanceAsOf } from "./vault-accounting";
import { currentMortgageBalance, MORTGAGE_HOME_ACCOUNT_NAMES } from "./mortgage-amortization";

// Composer, not self-contained -- like lib/multi-year-trend.ts itself, this imports runtime
// values from other lib/*.ts files (computeMultiYearTrend, ledgerBalanceAsOf, accountNature),
// which node --test can't resolve across lib/*.ts files, so this isn't directly unit-tested --
// same accepted precedent as multi-year-trend.ts, verified live instead.

export type RatioPoint = {
  fy: string;
  label: string;
  income: number;
  expense: number;
  savingsRate: number | null;
  liquidAssets: number;
  totalDebt: number;
  emergencyFundMonths: number | null; // null when monthly expense is ~0
  debtToIncome: number | null; // null when income is ~0
  netWorthGrowthPct: number | null;
};

// Sum of ledgerBalanceAsOf over every account matching `natures`, as of `asOfDate`. Asset-nature
// accounts (Bank/Cash) already display as a positive magnitude directly from ledgerBalanceAsOf.
// Liability balances are negative under this app's own sign convention (same as every
// credit-card/loan account already does), so ONLY those need negating to get a positive "how much
// is owed" magnitude -- pass negate=true for Liability, false for Bank/Cash. Confirmed live: an
// earlier version negated both and produced a negative "Liquid Assets" figure for a real bank
// balance.
function sumByNature(data: Ledger, groupMap: Map<string, { nature: string }>, natures: string[], asOfDate: string, negate: boolean): number {
  let total = 0;
  for (const a of data.accounts) {
    if (a.active === false) continue;
    if (!natures.includes(accountNature(a, groupMap))) continue;
    const balance = ledgerBalanceAsOf(data, a.id, asOfDate);
    total += negate ? -balance : balance;
  }
  return total;
}

export function computeFinancialRatios(data: Ledger): RatioPoint[] {
  const trend = computeMultiYearTrend(data);
  const groupMap = new Map((data.groups ?? []).map((g) => [g.name.toLowerCase(), { nature: g.nature }]));
  // Only add the mortgage's outstanding balance if a "Home" account actually exists in this
  // ledger -- currentMortgageBalance() falls back to its hardcoded US anchor when it can't find
  // one, which would silently pollute an India-book (or any Home-less) computation.
  const hasMortgage = data.accounts.some((a) => MORTGAGE_HOME_ACCOUNT_NAMES.some((n) => a.name.toLowerCase() === n.toLowerCase()));

  return trend.map((p: FyTrendPoint) => {
    const liquidAssets = sumByNature(data, groupMap, ["Bank", "Cash"], p.end, false);
    const totalDebt = sumByNature(data, groupMap, ["Liability"], p.end, true) + (hasMortgage ? currentMortgageBalance(data, p.end) : 0);
    const monthlyExpense = p.expense / 12;
    return {
      fy: p.fy,
      label: p.label,
      income: p.income,
      expense: p.expense,
      savingsRate: p.savingsRate,
      liquidAssets,
      totalDebt,
      emergencyFundMonths: monthlyExpense > 0.5 ? liquidAssets / monthlyExpense : null,
      debtToIncome: p.income > 0.5 ? totalDebt / p.income : null,
      netWorthGrowthPct: p.netWorthGrowthPct,
    };
  });
}
