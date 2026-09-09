import type { Ledger } from "./vault-types";
import { accountNature, fiscalYearOf } from "./vault-accounting";
import { FIXED_ASSETS_GROUP_NAME, ASSET_CLASS_SUGGESTIONS, UNCLASSIFIED_LABEL } from "./fixed-assets";

// Composer, not self-contained -- imports runtime values from other lib/*.ts files
// (accountNature, fiscalYearOf, fixed-assets constants), which node --test can't resolve across
// lib/*.ts files, so this isn't directly unit-tested -- same accepted precedent as
// lib/multi-year-trend.ts / lib/financial-ratios.ts, verified live instead.

// A "Sources & Uses of Funds" summary for one fiscal year -- modeled directly on the user's own
// existing personal Excel tracker (Incoming Fund vs. Outgoing Fund, the latter split into
// Expenses / Fixed Assets / Investments, each line also carrying its % of total Incoming Fund),
// but populated from this book's own real accounts rather than the hand-typed category list in
// that sheet.
export type FundLine = { label: string; amount: number; pctOfIncoming: number };
export type FundGroup = { label: string; lines: FundLine[]; total: number; pctOfIncoming: number };

export type FundSummaryResult = {
  periodStart: string;
  periodEnd: string; // capped at today for the current, still-open fiscal year
  incoming: FundGroup;
  outgoingExpenses: FundGroup;
  outgoingFixedAssets: FundGroup;
  outgoingInvestments: FundGroup;
  totalOutgoing: number;
  totalOutgoingPct: number;
  liquidityBalance: number;
  liquidityBalancePct: number;
  // Cross-check: liquidityBalance SHOULD equal the real Bank+Cash balance change over the same
  // period -- a mismatch means some account isn't classified the way this report expects
  // (e.g. a Bank-nature account also holding non-cash activity), same spirit as the Fixed Asset
  // Register's own "GL mismatch" warning elsewhere in this app.
  bankCashChange: number;
};

// Net Dr (debit) movement into `accountId` between start and end inclusive -- positive means the
// account's balance grew over the period (a real addition/contribution), negative means it
// shrank (a disposal/withdrawal netted against the period's additions).
function periodNetDebit(data: Ledger, accountId: number, start: string, end: string): number {
  let net = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled || t.date < start || t.date > end) continue;
    for (const e of t.entries) if (e.accountId === accountId) net -= e.amount; // Dr(-)=increase
  }
  return net;
}

function toLines(entries: { label: string; amount: number }[], incomingTotal: number): FundLine[] {
  return entries
    .filter((e) => Math.abs(e.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)
    .map((e) => ({ ...e, pctOfIncoming: incomingTotal > 0.5 ? e.amount / incomingTotal : 0 }));
}

function groupOf(label: string, lines: FundLine[], incomingTotal: number): FundGroup {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { label, lines, total, pctOfIncoming: incomingTotal > 0.5 ? total / incomingTotal : 0 };
}

function earliestFiscalYear(data: Ledger): number | null {
  let earliest: number | null = null;
  for (const t of data.transactions) {
    if (t.deleted || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) continue;
    const fy = fiscalYearOf(t.date);
    if (earliest === null || fy < earliest) earliest = fy;
  }
  return earliest;
}

// `rawStart`/`rawEnd` are whatever the app's own global "Financial period" selector already
// resolved to (see the `start`/`end` computation in VaultApp.tsx's `calc`) -- this report follows
// that same selection instead of keeping its own separate period picker, so switching periods
// once at the top of the page carries through to every report, this one included.
export function computeFundSummary(data: Ledger, rawStart: string, rawEnd: string): FundSummaryResult {
  const groupMap = new Map((data.groups ?? []).map((g) => [g.name.toLowerCase(), { nature: g.nature }]));
  const today = new Date().toISOString().slice(0, 10);
  const periodStart = rawStart;
  const periodEnd = rawEnd < today ? rawEnd : today; // never project into the future
  const active = data.accounts.filter((a) => a.active !== false);
  const earliest = earliestFiscalYear(data);
  const isFirstTrackedYear = earliest !== null && fiscalYearOf(periodStart) <= earliest;

  // ── Incoming Fund ──────────────────────────────────────────────────────────────────────────
  const incomeLines = active
    .filter((a) => accountNature(a, groupMap) === "Income")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd) * -1 })); // Cr(+)=income
  // Net new borrowing this period (credit/increase to Liability accounts); a net repayment shows
  // as a negative line here rather than a separate Outgoing category, since the original sheet
  // has no repayment line and this keeps Incoming - Outgoing = Liquidity Balance exact either way.
  const loanTaken = active
    .filter((a) => accountNature(a, groupMap) === "Liability")
    .reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd) * -1, 0);
  // Opening Capital: only meaningful in the book's own first tracked fiscal year -- the balance
  // this account already held before any transaction history began. Every later year it's 0,
  // matching the original sheet's own "Opening Capital: 0" line for an ongoing year.
  const openingCapital = isFirstTrackedYear
    ? active.filter((a) => accountNature(a, groupMap) === "Capital").reduce((s, a) => s - a.openingBalance, 0)
    : 0;
  const incomingRaw = [
    ...incomeLines,
    { label: "Loan Taken", amount: loanTaken },
    { label: "Opening Capital", amount: openingCapital },
  ];
  const incomingTotal = incomingRaw.reduce((s, l) => s + l.amount, 0);
  const incoming = groupOf("Incoming Fund", toLines(incomingRaw, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Expenses ────────────────────────────────────────────────────────────────
  const expenseLines = active
    .filter((a) => accountNature(a, groupMap) === "Expense")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd) }));
  const outgoingExpenses = groupOf("Expenses", toLines(expenseLines, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Fixed Assets (rolled up by class, matching the Fixed Asset Register) ─────
  const fixedAssetAccounts = active.filter((a) => a.parent === FIXED_ASSETS_GROUP_NAME);
  const classOrder = [...ASSET_CLASS_SUGGESTIONS, UNCLASSIFIED_LABEL];
  const fixedAssetByClass = new Map<string, number>();
  for (const acc of fixedAssetAccounts) {
    const net = periodNetDebit(data, acc.id, periodStart, periodEnd);
    if (Math.abs(net) < 0.005) continue;
    const asset = (data.fixedAssets ?? []).find((fa) => fa.accountId === acc.id);
    const cls = asset?.assetClass || UNCLASSIFIED_LABEL;
    fixedAssetByClass.set(cls, (fixedAssetByClass.get(cls) ?? 0) + net);
  }
  const fixedAssetLines = [...fixedAssetByClass.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => {
      const ai = classOrder.indexOf(a.label), bi = classOrder.indexOf(b.label);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  const outgoingFixedAssets = groupOf("Fixed Assets", toLines(fixedAssetLines, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Investments ─────────────────────────────────────────────────────────────
  const investmentLines = active
    .filter((a) => accountNature(a, groupMap) === "Investment")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd) }));
  const outgoingInvestments = groupOf("Investments", toLines(investmentLines, incomingTotal), incomingTotal);

  const totalOutgoing = outgoingExpenses.total + outgoingFixedAssets.total + outgoingInvestments.total;
  const liquidityBalance = incomingTotal - totalOutgoing;

  const bankCashChange = active
    .filter((a) => ["Bank", "Cash"].includes(accountNature(a, groupMap)))
    .reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd), 0);

  return {
    periodStart,
    periodEnd,
    incoming,
    outgoingExpenses,
    outgoingFixedAssets,
    outgoingInvestments,
    totalOutgoing,
    totalOutgoingPct: incomingTotal > 0.5 ? totalOutgoing / incomingTotal : 0,
    liquidityBalance,
    liquidityBalancePct: incomingTotal > 0.5 ? liquidityBalance / incomingTotal : 0,
    bankCashChange,
  };
}
