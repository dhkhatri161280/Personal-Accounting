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
  // Net new borrowing -- deliberately NOT part of `incoming` (a loan isn't income), shown as its
  // own section between Incoming and Outgoing instead. Still folded into `liquidityBalance` below
  // so the report's own Bank+Cash cross-check keeps balancing even in a year you actually borrow.
  financing: FundGroup;
  outgoingExpenses: FundGroup;
  outgoingFixedAssets: FundGroup;
  outgoingInvestments: FundGroup;
  outgoingLoans: FundGroup;
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
  // Uses the raw period bounds as-is -- same as every other report (Income & Expenditure,
  // Balance Sheet, Cash Flow) -- rather than capping at today's date. An earlier version capped
  // periodEnd at today to avoid "projecting into the future," but that silently excluded any
  // transaction dated later in an in-progress fiscal year (e.g. a pre-dated/planned transfer)
  // from THIS report only, producing a real mismatch against every other report showing the
  // same selected period.
  const periodStart = rawStart;
  const periodEnd = rawEnd;
  const active = data.accounts.filter((a) => a.active !== false);
  const earliest = earliestFiscalYear(data);
  const isFirstTrackedYear = earliest !== null && fiscalYearOf(periodStart) <= earliest;
  const bankCashAccounts = active.filter((a) => ["Bank", "Cash"].includes(accountNature(a, groupMap)));

  // ── Incoming Fund ──────────────────────────────────────────────────────────────────────────
  const incomeAccounts = active.filter((a) => accountNature(a, groupMap) === "Income");
  const incomeLines: RawLine[] = incomeAccounts.map((a) => ({
    label: a.name,
    amount: periodNetDebit(data, a.id, periodStart, periodEnd) * -1, // Cr(+)=income
    accountIds: [a.id],
  }));
  // Opening Capital: only meaningful in the book's own first tracked fiscal year -- the balance
  // Bank/Cash accounts already held before any transaction history began (every later year it's
  // 0, matching the original sheet's own "Opening Capital: 0" line for an ongoing year).
  //
  // Deliberately reads the Bank/Cash accounts' OWN Account.openingBalance sum here, not the
  // Capital account's -- `bankCashChange` below (the real Bank+Cash cross-check this whole report
  // validates against) is built purely from `periodNetDebit`, which only sums TRANSACTIONS and
  // never includes any account's static opening-balance field. So whatever pre-tracking cash
  // actually funded Bank/Cash's own starting balance is exactly the blind spot that needs to
  // appear here to make Liquidity Balance tie out -- using the Capital account's own field
  // instead assumes it's a mirror of that, which isn't reliable (confirmed live: one book's
  // Capital account carried a stale, unrelated ~78k opening figure with Bank/Cash still at a
  // real $0 start, and using it created an exact ~78k mismatch in EITHER sign direction; only
  // reading the Bank/Cash side itself, as done here, reproduced the real cross-check exactly).
  // Dr(-)=increase, same convention as every other asset-side balance in this app (see
  // components/MastersPanel.tsx:619's `openingBalance: side === "Dr" ? -amount : amount`) -- a
  // Dr opening balance on a Bank/Cash account is real cash that exists, so it needs the sign
  // flip to read as a positive contribution to Incoming Fund.
  const openingCapital = isFirstTrackedYear ? bankCashAccounts.reduce((s, a) => s - a.openingBalance, 0) : 0;
  const incomingRaw: RawLine[] = [
    ...incomeLines,
    { label: "Opening Capital", amount: openingCapital, accountIds: bankCashAccounts.map((a) => a.id) },
  ];
  const incomingTotal = incomingRaw.reduce((s, l) => s + l.amount, 0);
  const incoming = groupOf("Incoming Fund", toLines(consolidateFamilies(incomingRaw), incomingTotal), incomingTotal);

  // ── Financing: net new borrowing this period ──────────────────────────────────────────────
  // A loan is a source of cash but not income, so it's its own section rather than folded into
  // Incoming Fund. A net repayment shows as a negative line here (no separate Outgoing line for
  // it), same as before this was split out.
  //
  // "CCU Home Loan" is excluded here -- it's a non-cash mortgage draw that funded a home purchase
  // directly (the lender paid the seller; the money never touched Bank/Cash), already fully
  // absorbed into the Home/Home Mortgage/CCU Home Loan netting below (see that comment). Counting
  // it here too would double-count it as a cash source with nothing offsetting it on the Outgoing
  // side, inflating Liquidity Balance by exactly that amount above the real Bank+Cash change.
  const ccuHomeLoanAcc = active.find((a) => a.name.toLowerCase() === "ccu home loan");
  const liabilityAccounts = active
    .filter((a) => accountNature(a, groupMap) === "Liability")
    .filter((a) => a.id !== ccuHomeLoanAcc?.id);
  const loanTaken = liabilityAccounts.reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd) * -1, 0);
  const financingRaw: RawLine[] = [{ label: "Loan Taken", amount: loanTaken, accountIds: liabilityAccounts.map((a) => a.id) }];
  const financing = groupOf("Financing", toLines(financingRaw, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Expenses ────────────────────────────────────────────────────────────────
  const expenseLines: RawLine[] = active
    .filter((a) => accountNature(a, groupMap) === "Expense")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd), accountIds: [a.id] }));
  const outgoingExpenses = groupOf("Expenses", toLines(consolidateFamilies(expenseLines), incomingTotal), incomingTotal);

  // ── Outgoing Fund: Fixed Assets (rolled up by class, matching the Fixed Asset Register) ─────
  const fixedAssetAccounts = active.filter((a) => a.parent === FIXED_ASSETS_GROUP_NAME);
  // "Home" and "Home Mortgage" (US Books only -- both no-op via `.find` returning undefined
  // elsewhere) get combined into one "Home" line, netted against the real "CCU Home Loan"
  // liability it offsets, instead of falling into the generic per-class "Unclassified" bucket.
  // ensureMortgagePrincipalVouchers in components/VaultApp.tsx posts Dr CCU Home Loan / Cr Home
  // Mortgage each month for the mortgage payment's principal -- Home Mortgage's balance is a pure
  // mirror of what's still owed on CCU Home Loan, not a real distinct asset, so summing all three
  // accounts' own periodNetDebit together (no extra sign flip needed -- the liability's naturally
  // opposite-signed movement cancels the mirrored asset entry out on its own) leaves exactly the
  // home's true standalone value instead of an inflated, unexplained "Unclassified" figure.
  const homeAcc = fixedAssetAccounts.find((a) => a.name.toLowerCase() === "home");
  const homeMortgageAcc = fixedAssetAccounts.find((a) => a.name.toLowerCase() === "home mortgage");
  const classOrder = [...ASSET_CLASS_SUGGESTIONS, UNCLASSIFIED_LABEL];
  const fixedAssetByClass = new Map<string, { amount: number; accountIds: number[] }>();
  for (const acc of fixedAssetAccounts) {
    if (acc.id === homeAcc?.id || acc.id === homeMortgageAcc?.id) continue; // handled below instead
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
  if (homeAcc || homeMortgageAcc) {
    const homeNet =
      (homeAcc ? periodNetDebit(data, homeAcc.id, periodStart, periodEnd) : 0) +
      (homeMortgageAcc ? periodNetDebit(data, homeMortgageAcc.id, periodStart, periodEnd) : 0) +
      (ccuHomeLoanAcc ? periodNetDebit(data, ccuHomeLoanAcc.id, periodStart, periodEnd) : 0);
    if (Math.abs(homeNet) > 0.005) {
      fixedAssetLines.unshift({
        label: "Home",
        amount: homeNet,
        accountIds: [homeAcc?.id, homeMortgageAcc?.id, ccuHomeLoanAcc?.id].filter((id): id is number => id !== undefined),
      });
    }
  }
  const outgoingFixedAssets = groupOf("Fixed Assets", toLines(fixedAssetLines, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Investments ─────────────────────────────────────────────────────────────
  const investmentLines: RawLine[] = active
    .filter((a) => accountNature(a, groupMap) === "Investment")
    .map((a) => ({ label: a.name, amount: periodNetDebit(data, a.id, periodStart, periodEnd), accountIds: [a.id] }));
  const outgoingInvestments = groupOf("Investments", toLines(investmentLines, incomingTotal), incomingTotal);

  // ── Outgoing Fund: Loans (Asset) -- money lent out (advances, personal loans given), a real
  // use of funds distinct from Investments even though both grow an Asset-nature account ──────
  const loansAccounts = active.filter((a) => /^loans & advances \(asset\)$/i.test(a.parent || ""));
  const loansLines: RawLine[] = loansAccounts.map((a) => ({
    label: a.name,
    amount: periodNetDebit(data, a.id, periodStart, periodEnd),
    accountIds: [a.id],
  }));
  const outgoingLoans = groupOf("Loans (Asset)", toLines(loansLines, incomingTotal), incomingTotal);

  const totalOutgoing = outgoingExpenses.total + outgoingFixedAssets.total + outgoingInvestments.total + outgoingLoans.total;
  const liquidityBalance = incomingTotal + financing.total - totalOutgoing;

  const bankCashChange = bankCashAccounts.reduce((s, a) => s + periodNetDebit(data, a.id, periodStart, periodEnd), 0);

  return {
    periodStart,
    periodEnd,
    incoming,
    financing,
    outgoingExpenses,
    outgoingFixedAssets,
    outgoingInvestments,
    outgoingLoans,
    totalOutgoing,
    totalOutgoingPct: incomingTotal > 0.5 ? totalOutgoing / incomingTotal : 0,
    totalOutgoingAccountIds: [
      ...outgoingExpenses.accountIds,
      ...outgoingFixedAssets.accountIds,
      ...outgoingInvestments.accountIds,
      ...outgoingLoans.accountIds,
    ],
    liquidityBalance,
    liquidityBalancePct: incomingTotal > 0.5 ? liquidityBalance / incomingTotal : 0,
    bankCashChange,
  };
}
