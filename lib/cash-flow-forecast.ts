import type { Ledger } from "./vault-types";
import { accountNature, ledgerBalanceAsOf } from "./vault-accounting";
import { currentLoanBalance } from "./loans-ledger";
import { computePaymentSplit } from "./loans";

// Composer, not self-contained -- like lib/multi-year-trend.ts/lib/financial-ratios.ts, this
// imports runtime values from other lib/*.ts files (accountNature, ledgerBalanceAsOf,
// currentLoanBalance, computePaymentSplit), which node --test can't resolve across lib/*.ts
// files, so this isn't directly unit-tested -- same accepted precedent, verified live instead.

export type ForecastPoint = {
  period: string; // "YYYY-MM"
  label: string;
  recurringNet: number; // signed: positive = net inflow this month
  loanPayments: number; // total cash outflow across all active loans this month
  projectedCash: number; // running balance at the end of this month
};

export type UnplacedYearlyItem = { label: string; amount: number };

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

export function computeCashFlowForecast(data: Ledger, months: number): { points: ForecastPoint[]; unplacedYearly: UnplacedYearlyItem[] } {
  const groupMap = new Map((data.groups ?? []).map((g) => [g.name.toLowerCase(), { nature: g.nature }]));
  const todayStr = new Date().toISOString().slice(0, 10);
  const startMonth = todayStr.slice(0, 7);

  let startingCash = 0;
  for (const a of data.accounts) {
    if (a.active === false) continue;
    if (!["Bank", "Cash"].includes(accountNature(a, groupMap))) continue;
    startingCash += ledgerBalanceAsOf(data, a.id, todayStr);
  }

  // Net cash effect of one occurrence of a recurring template: the sum of -entry.amount for
  // whichever of its entries touches a Bank/Cash-nature account (Entry convention: negative=Dr
  // increases a Bank/Cash asset, i.e. an inflow) -- mirrors how a real posted voucher's cash leg
  // works, just read off the template's entries instead of a posted Tx.
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  function templateCashEffect(entries: { accountId: number; amount: number }[]): number {
    let effect = 0;
    for (const e of entries) {
      const acct = accountById.get(e.accountId);
      if (!acct) continue;
      if (["Bank", "Cash"].includes(accountNature(acct, groupMap))) effect += -e.amount;
    }
    return effect;
  }

  const monthlyTemplates = (data.recurringTemplates ?? []).filter((t) => t.active && t.frequency === "monthly");
  const monthlyCashNet = round2(monthlyTemplates.reduce((s, t) => s + templateCashEffect(t.entries), 0));

  // Yearly templates aren't placed into a specific forecast month -- there's no reliable anchor
  // (RecurringTemplate.dayOfMonth is day-only, informational per its own type comment) telling us
  // WHICH calendar month a yearly template recurs in, so guessing would fabricate precision the
  // data doesn't support. Listed separately instead.
  const unplacedYearly: UnplacedYearlyItem[] = (data.recurringTemplates ?? [])
    .filter((t) => t.active && t.frequency === "yearly")
    .map((t) => ({ label: t.label, amount: round2(templateCashEffect(t.entries)) }));

  const activeLoans = (data.loans ?? []).filter((l) => !l.closed);
  const loanBalances = new Map(activeLoans.map((l) => [l.id, currentLoanBalance(data, l, todayStr)]));

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

    runningCash = round2(runningCash + monthlyCashNet - loanOutflow);
    points.push({
      period: cursor,
      label: monthLabel(cursor),
      recurringNet: monthlyCashNet,
      loanPayments: round2(loanOutflow),
      projectedCash: runningCash,
    });
  }

  return { points, unplacedYearly };
}
