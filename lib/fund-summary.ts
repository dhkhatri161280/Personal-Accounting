import type { Ledger } from "./vault-types";
import { accountNature, fiscalYearOf } from "./vault-accounting";
import { FIXED_ASSETS_GROUP_NAME, ASSET_CLASS_SUGGESTIONS, UNCLASSIFIED_LABEL } from "./fixed-assets";

// Composer, not self-contained -- imports runtime values from other lib/*.ts files
// (accountNature, fiscalYearOf, fixed-assets constants), which node --test can't resolve across
// lib/*.ts files, so this isn't directly unit-tested -- same accepted precedent as
// lib/multi-year-trend.ts / lib/financial-ratios.ts, verified live instead.

// A "Sources & Uses of Funds" summary for one fiscal year -- modeled directly on the user's own
// existing personal Excel tracker (a compact Summary panel -- Incoming Fund vs. Outgoing Fund,
// the latter split into Expenses / Fixed Assets / Investments subtotals -- followed by a detailed
// itemized breakdown of each subtotal), but populated from this book's own real accounts rather
// than the hand-typed category list in that sheet. Every line/group carries its contributing
// `accountIds` so the UI can drill down into the real vouchers behind any number, reusing this
// app's existing columnar-report drill-down (see vouchersForAccountsInRange in
// lib/columnar-report.ts).
export type FundLine = { label: string; amount: number; pctOfIncoming: number; accountIds: number[] };
export type FundGroup = { label: string; lines: FundLine[]; total: number; pctOfIncoming: number; accountIds: number[] };

export type FundSummaryResult = {
  periodStart: string;
  periodEnd: string; // capped at today for the current, still-open fiscal year
  incoming: FundGroup;
  outgoingExpenses: FundGroup;
  outgoingFixedAssets: FundGroup;
  outgoingInvestments: FundGroup;
  totalOutgoing: number;
  totalOutgoingPct: number;
  totalOutgoingAccountIds: number[];
  liquidityBalance: number;
  liquidityBalancePct: number;
  // Cross-check: liquidityBalance SHOULD equal the real Bank+Cash balance change over the same
  // period -- a mismatch means some account isn't classified the way this report expects
  // (e.g. a Bank-nature account also holding non-cash activity), same spirit as the Fixed Asset
  // Register's own "GL mismatch" warning elsewhere in this app.
  bankCashChange: number;
};

type RawLine = { label: string; amount: number; accountIds: number[] };

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

// Some account names represent a whole FAMILY of near-duplicate per-period or per-employer
// ledger accounts rather than one genuinely distinct account -- "House Hold Exps - <Month> <Year>"
// gets a new account auto-created every calendar month (see houseHoldMonthName in
// components/vault/PlaidImport.tsx, same /^house hold exps/i convention used there to recognize
// the family), and "Salary Income - <Employer>" splits by employer. A period spanning more than
// one month/employer -- especially "All periods" -- would otherwise list dozens of near-duplicate
// lines instead of one combined total, unlike every other account which genuinely is just one.
// Rolled into a single line per family here, summed across every matching account; the drill-down
// (which lists the real underlying vouchers, debit/credit ledger names included) still shows
// which specific month or employer each one belongs to.
const CONSOLIDATED_FAMILIES: { pattern: RegExp; label: string }[] = [
  { pattern: /^house hold exps/i, label: "House Hold Exps" },
  { pattern: /^salary income/i, label: "Salary Income" },
];
function consolidateFamilies(lines: RawLine[]): RawLine[] {
  const merged = new Map<string, RawLine>();
  const rest: RawLine[] = [];
  for (const l of lines) {
    const family = CONSOLIDATED_FAMILIES.find((f) => f.pattern.test(l.label));
    if (!family) {
      rest.push(l);
      continue;
    }
    const existing = merged.get(family.label);
    if (existing) {
      existing.amount += l.amount;
      existing.accountIds.push(...l.accountIds);
    } else {
      merged.set(family.label, { label: family.label, amount: l.amount, accountIds: [...l.accountIds] });
    }
  }
  return [...rest, ...merged.values()];
}

function toLines(entries: RawLine[], incomingTotal: number): FundLine[] {
  return entries
    .filter((e) => Math.abs(e.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)
    .map((e) => ({ ...e, pctOfIncoming: incomingTotal > 0.5 ? e.amount / incomingTotal : 0 }));
}

function groupOf(label: string, lines: FundLine[], incomingTotal: number): FundGroup {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const accountIds = lines.flatMap((l) => l.accountIds);
  return { label, lines, total, pctOfIncoming: incomingTotal > 0.5 ? total / incomingTotal : 0, accountIds };
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
  const incomeAccounts = active.filter((a) => accountNature(a, groupMap) === "Income");
  const incomeLines: RawLine[] = incomeAccounts.map((a) => ({
    label: a.name,
    amount: periodNetDebit(data, a.id, periodStart, periodEnd) * -1, // Cr(+)=income
    accountIds: [a.id],
  }));
  // Net new borrowing this period (credit/increase to Liability accounts); a net repayment shows
  // as a negative line here rather than a separate Outgoing category, since the original sheet
  // has no repayment line and this keeps Incoming - Outgoing = Liquidity Balance exact either way.
  const liabilityAccounts = active.filter((a) => accountNature(a, groupMap) === "Liability");
  const loanTaken = liabilityAccounts.reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd) * -1, 0);
  // Opening Capital: only meaningful in the book's own first tracked fiscal year -- the balance
  // this account already held before any transaction history began. Every later year it's 0,
  // matching the original sheet's own "Opening Capital: 0" line for an ongoing year.
  const capitalAccounts = active.filter((a) => accountNature(a, groupMap) === "Capital");
  const openingCapital = isFirstTrackedYear ? capitalAccounts.reduce((s, a) => s - a.openingBalance, 0) : 0;
  const incomingRaw: RawLine[] = [
    ...incomeLines,
    { label: "Loan Taken", amount: loanTaken, accountIds: liabilityAccounts.map((a) => a.id) },
    { label: "Opening Capital", amount: openingCapital, accountIds: capitalAccounts.map((a) => a.id) },
  ];
  const incomingTotal = incomingRaw.reduce((s, l) => s + l.amount, 0);
  const incoming = groupOf("Incoming Fund", toLines(consolidateFamilies(incomingRaw), incomingTotal), incomingTotal);

  // ── Outgoing Fund: Expenses ────────────────────────────────────────────────────────────────
  const expenseLines: RawLine[] = active
    .filter((a) => accountNature(a, groupMap) === "Expense")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd), accountIds: [a.id] }));
  const outgoingExpenses = groupOf("Expenses", toLines(consolidateFamilies(expenseLines), incomingTotal), incomingTotal);

  // ── Outgoing Fund: Fixed Assets (rolled up by class, matching the Fixed Asset Register) ─────
  const fixedAssetAccounts = active.filter((a) => a.parent === FIXED_ASSETS_GROUP_NAME);
  const classOrder = [...ASSET_CLASS_SUGGESTIONS, UNCLASSIFIED_LABEL];
  const fixedAssetByClass = new Map<string, { amount: number; accountIds: number[] }>();
  for (const acc of fixedAssetAccounts) {
    const net = periodNetDebit(data, acc.id, periodStart, periodEnd);
    if (Math.abs(net) < 0.005) continue;
    const asset = (data.fixedAssets ?? []).find((fa) => fa.accountId === acc.id);
    const cls = asset?.assetClass || UNCLASSIFIED_LABEL;
    const existing = fixedAssetByClass.get(cls);
    if (existing) {
      existing.amount += net;
      existing.accountIds.push(acc.id);
    } else {
      fixedAssetByClass.set(cls, { amount: net, accountIds: [acc.id] });
    }
  }
  const fixedAssetLines: RawLine[] = [...fixedAssetByClass.entries()]
    .map(([label, v]) => ({ label, amount: v.amount, accountIds: v.accountIds }))
    .sort((a, b) => {
      const ai = classOrder.indexOf(a.label), bi = classOrder.indexOf(b.label);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  const outgoingFixedAssets = groupOf("Fixed Assets", toLines(fixedAssetLines, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Investments ─────────────────────────────────────────────────────────────
  const investmentLines: RawLine[] = active
    .filter((a) => accountNature(a, groupMap) === "Investment")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd), accountIds: [a.id] }));
  const outgoingInvestments = groupOf("Investments", toLines(investmentLines, incomingTotal), incomingTotal);

  const totalOutgoing = outgoingExpenses.total + outgoingFixedAssets.total + outgoingInvestments.total;
  const liquidityBalance = incomingTotal - totalOutgoing;

  const bankCashAccounts = active.filter((a) => ["Bank", "Cash"].includes(accountNature(a, groupMap)));
  const bankCashChange = bankCashAccounts.reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd), 0);

  return {
    periodStart,
    periodEnd,
    incoming,
    outgoingExpenses,
    outgoingFixedAssets,
    outgoingInvestments,
    totalOutgoing,
    totalOutgoingPct: incomingTotal > 0.5 ? totalOutgoing / incomingTotal : 0,
    totalOutgoingAccountIds: [...outgoingExpenses.accountIds, ...outgoingFixedAssets.accountIds, ...outgoingInvestments.accountIds],
    liquidityBalance,
    liquidityBalancePct: incomingTotal > 0.5 ? liquidityBalance / incomingTotal : 0,
    bankCashChange,
  };
}
