import type { GrLedger, GrAccount } from "./gr-consolidation";
import { FIXED_ASSETS_GROUP_NAME } from "./fixed-assets.ts";

// GR-consolidated counterpart to lib/fund-summary.ts's computeFundSummary -- same Incoming/
// Financing/Outgoing/Liquidity Balance shape, but sourced from GrLedger (already INR-consolidated
// across the US and India books) instead of a single book's Ledger. Genuinely different code, not
// a thin wrapper: GrAccount has no numeric id (accounts are matched by normalized name across the
// two source books), so there's no voucher drill-down here -- consistent with every other GR
// report, none of which have one either. No "Opening Capital" line either: that feature was tried
// several ways against a real single-book case in this same session and never reconciled against
// the real Bank+Cash cross-check for any variant, so it's deliberately left out here until a
// GR-specific need is proven the same rigorous way (see lib/fund-summary.ts's own comment on this).
export type GrFundLine = { label: string; amount: number; pctOfIncoming: number };
export type GrFundGroup = { label: string; lines: GrFundLine[]; total: number; pctOfIncoming: number };

export type GrFundSummaryResult = {
  periodStart: string;
  periodEnd: string;
  incoming: GrFundGroup;
  financing: GrFundGroup;
  outgoingExpenses: GrFundGroup;
  outgoingFixedAssets: GrFundGroup;
  outgoingInvestments: GrFundGroup;
  outgoingLoans: GrFundGroup;
  outgoingDeposits: GrFundGroup;
  totalOutgoing: number;
  totalOutgoingPct: number;
  liquidityBalance: number;
  liquidityBalancePct: number;
  // Cross-check: liquidityBalance SHOULD equal the real Bank+Cash balance change over the same
  // period -- a mismatch means some account isn't classified the way this report expects, same
  // spirit as lib/fund-summary.ts's own cross-check.
  bankCashChange: number;
};

function normKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Mirrors GrApp.tsx's own local `grNature`, but keeps "Investment" as its own nature instead of
// collapsing it into "Asset" -- GrApp's version intentionally collapses Investment into Asset for
// its own Balance Sheet/Net Worth purposes (both land on the asset side there), but this report
// needs a distinct Investments bucket the same way lib/fund-summary.ts's computeFundSummary does.
type GrNature = "Income" | "Expense" | "Bank" | "Cash" | "Capital" | "Liability" | "Investment" | "Asset";
function grFundNature(parent: string, groupNatures: Map<string, string>): GrNature {
  const p = parent.toLowerCase();
  if (p.includes("(asset)")) return "Asset";
  const configured = groupNatures.get(p);
  if (configured) return configured as GrNature;
  if (/bank accounts?$/i.test(p)) return "Bank";
  if (/cash.in.hand|petty cash/i.test(p)) return "Cash";
  if (/^(direct incomes?|indirect incomes?|sales accounts?)$/i.test(p)) return "Income";
  if (/^(direct expenses?|indirect expenses?|purchase accounts?)$/i.test(p)) return "Expense";
  if (/^(capital account|reserves? & surplus)$/i.test(p)) return "Capital";
  if (/liabilit|creditor|loan.*liab|duties.*tax|provision|bank od|secured loan|unsecured loan/i.test(p)) return "Liability";
  if (/investment/i.test(p)) return "Investment";
  return "Asset";
}

// Mirrors lib/fund-summary.ts's own CONSOLIDATED_FAMILIES/consolidateFamilies exactly -- "House
// Hold Exps - <Month> <Year>" gets a new account auto-created every calendar month, and "Salary
// Income - <Employer>" splits by employer, so a period spanning more than one month/employer
// would otherwise list dozens of near-duplicate lines instead of one combined total.
const CONSOLIDATED_FAMILIES: { pattern: RegExp; label: string }[] = [
  { pattern: /^house hold exps/i, label: "House Hold Exps" },
  { pattern: /^salary income/i, label: "Salary Income" },
];
function consolidateFamilies(lines: { label: string; amount: number }[]): { label: string; amount: number }[] {
  const merged = new Map<string, { label: string; amount: number }>();
  const rest: { label: string; amount: number }[] = [];
  for (const l of lines) {
    const family = CONSOLIDATED_FAMILIES.find((f) => f.pattern.test(l.label));
    if (!family) {
      rest.push(l);
      continue;
    }
    const existing = merged.get(family.label);
    if (existing) existing.amount += l.amount;
    else merged.set(family.label, { label: family.label, amount: l.amount });
  }
  return [...rest, ...merged.values()];
}

function toLines(entries: { label: string; amount: number }[], incomingTotal: number): GrFundLine[] {
  return entries
    .filter((e) => Math.abs(e.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)
    .map((e) => ({ ...e, pctOfIncoming: incomingTotal > 0.5 ? e.amount / incomingTotal : 0 }));
}

function groupOf(label: string, lines: GrFundLine[], incomingTotal: number): GrFundGroup {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { label, lines, total, pctOfIncoming: incomingTotal > 0.5 ? total / incomingTotal : 0 };
}

export function computeGrFundSummary(
  gr: GrLedger,
  periodStart: string,
  periodEnd: string,
  groupNatures: Map<string, string>
): GrFundSummaryResult {
  // Period-specific Dr/Cr per account, same mechanism GrApp.tsx's own periodCalc uses.
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const t of gr.transactions) {
    if (t.cancelled || t.date < periodStart || t.date > periodEnd) continue;
    for (const e of t.entries) {
      const k = normKey(e.accountName);
      if (e.amountInr < 0) dr.set(k, (dr.get(k) || 0) + -e.amountInr);
      else cr.set(k, (cr.get(k) || 0) + e.amountInr);
    }
  }
  const netDr = (name: string) => (dr.get(normKey(name)) || 0) - (cr.get(normKey(name)) || 0); // Dr(+)=increase
  const netCr = (name: string) => -netDr(name); // Cr(+)=increase

  const active = gr.accounts.filter(
    (a) => Math.abs(a.closingInr) > 0.005 || a.debitInr > 0.005 || a.creditInr > 0.005 || Math.abs(a.openingInr) > 0.005
  );
  const nature = (a: GrAccount) => grFundNature(a.parent || "", groupNatures);

  // ── Incoming Fund: Income only (no Opening Capital line -- see file-level comment) ───────────
  const incomeAccounts = active.filter((a) => nature(a) === "Income");
  const incomingRaw = incomeAccounts.map((a) => ({ label: a.name, amount: netCr(a.name) }));
  const incomingTotal = incomingRaw.reduce((s, l) => s + l.amount, 0);
  const incoming = groupOf("Incoming Fund", toLines(consolidateFamilies(incomingRaw), incomingTotal), incomingTotal);

  // ── Financing: net new borrowing this period, excluding CCU Home Loan (see Fixed Assets below
  // -- its effect is already fully netted into the Home line there, same reasoning as the US
  // book's own lib/fund-summary.ts) ─────────────────────────────────────────────────────────────
  const liabilityAccounts = active.filter((a) => nature(a) === "Liability" && normKey(a.name) !== "ccu home loan");
  const loanTaken = liabilityAccounts.reduce((s, a) => s + netCr(a.name), 0);
  const financing = groupOf(
    "Financing",
    toLines([{ label: "Loan Taken", amount: loanTaken }], incomingTotal),
    incomingTotal
  );

  // ── Outgoing: Expenses ─────────────────────────────────────────────────────────────────────
  const expenseAccounts = active.filter((a) => nature(a) === "Expense");
  const outgoingExpenses = groupOf(
    "Expenses",
    toLines(consolidateFamilies(expenseAccounts.map((a) => ({ label: a.name, amount: netDr(a.name) }))), incomingTotal),
    incomingTotal
  );

  // ── Outgoing: Fixed Assets -- flat list, not rolled up by asset class the way the single-book
  // report does (GrAccount carries no cross-book asset-class metadata to roll up by). "Home" /
  // "Home Mortgage" / "CCU Home Loan" still get combined into one real "Home" line the same way,
  // since those are the same real ledger names carried through from the US book's consolidation.
  const fixedAssetAccounts = active.filter((a) => (a.parent || "") === FIXED_ASSETS_GROUP_NAME);
  const homeAcc = fixedAssetAccounts.find((a) => normKey(a.name) === "home");
  const homeMortgageAcc = fixedAssetAccounts.find((a) => normKey(a.name) === "home mortgage");
  const ccuHomeLoanAcc = active.find((a) => normKey(a.name) === "ccu home loan");
  const fixedAssetLines = fixedAssetAccounts
    .filter((a) => a !== homeAcc && a !== homeMortgageAcc)
    .map((a) => ({ label: a.name, amount: netDr(a.name) }));
  if (homeAcc || homeMortgageAcc) {
    const homeNet = (homeAcc ? netDr(homeAcc.name) : 0) + (homeMortgageAcc ? netDr(homeMortgageAcc.name) : 0) + (ccuHomeLoanAcc ? netDr(ccuHomeLoanAcc.name) : 0);
    if (Math.abs(homeNet) > 0.005) fixedAssetLines.unshift({ label: "Home", amount: homeNet });
  }
  const outgoingFixedAssets = groupOf("Fixed Assets", toLines(fixedAssetLines, incomingTotal), incomingTotal);

  // ── Outgoing: Investments ──────────────────────────────────────────────────────────────────
  const investmentAccounts = active.filter((a) => nature(a) === "Investment");
  const outgoingInvestments = groupOf(
    "Investments",
    toLines(investmentAccounts.map((a) => ({ label: a.name, amount: netDr(a.name) })), incomingTotal),
    incomingTotal
  );

  // ── Outgoing: Loans (Asset) -- money lent out, distinct from Investments ──────────────────────
  const loansAccounts = active.filter((a) => /^loans & advances \(asset\)$/i.test(a.parent || ""));
  const outgoingLoans = groupOf(
    "Loans (Asset)",
    toLines(loansAccounts.map((a) => ({ label: a.name, amount: netDr(a.name) })), incomingTotal),
    incomingTotal
  );

  // ── Outgoing: Deposits (Asset) -- security deposits paid out (rent, utilities), same treatment
  // as Loans (Asset). Found live: without this bucket, "House Rent Deposit"/"PG & E Deposit"
  // fell into the generic uncategorized-Asset bucket, leaving a small but real Liquidity Balance
  // gap (-2,770.33 on the user's real consolidated book).
  const depositsAccounts = active.filter((a) => /^deposits \(asset\)$/i.test(a.parent || ""));
  const outgoingDeposits = groupOf(
    "Deposits (Asset)",
    toLines(depositsAccounts.map((a) => ({ label: a.name, amount: netDr(a.name) })), incomingTotal),
    incomingTotal
  );

  const totalOutgoing =
    outgoingExpenses.total + outgoingFixedAssets.total + outgoingInvestments.total + outgoingLoans.total + outgoingDeposits.total;
  const liquidityBalance = incomingTotal + financing.total - totalOutgoing;

  const bankCashAccounts = active.filter((a) => ["Bank", "Cash"].includes(nature(a)));
  const bankCashChange = bankCashAccounts.reduce((s, a) => s + netDr(a.name), 0);

  return {
    periodStart,
    periodEnd,
    incoming,
    financing,
    outgoingExpenses,
    outgoingFixedAssets,
    outgoingInvestments,
    outgoingLoans,
    outgoingDeposits,
    totalOutgoing,
    totalOutgoingPct: incomingTotal > 0.5 ? totalOutgoing / incomingTotal : 0,
    liquidityBalance,
    liquidityBalancePct: incomingTotal > 0.5 ? liquidityBalance / incomingTotal : 0,
    bankCashChange,
  };
}
