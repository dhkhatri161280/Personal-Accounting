import type { Ledger, Tx } from "./vault-types.ts";
import { ledgerBalanceAsOf, accountNature, fiscalYearOf } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { fmtDate } from "./format-date.ts";
import { isSalaryVoucher, buildShadowPeriod } from "./payroll-match.ts";
import { computePendingEsppCycles, compute401kLifetimeTotals, compute401kByYear } from "./payroll-401k.ts";
import { computeHeldEquityValue } from "./equity-holdings.ts";
import { computeNetWorthTrend } from "./net-worth-trend.ts";
import { classifyRsuSales, classifyEsppSales, classifyTradingSales, summarizeCapitalGains } from "./tax-classify.ts";
import { computeFinancialRatios } from "./financial-ratios.ts";
import { computeCashFlowForecast } from "./cash-flow-forecast.ts";
import { budgetVsActualRows } from "./budget.ts";
import { computeMultiYearTrend } from "./multi-year-trend.ts";
import { bookValue } from "./fixed-assets.ts";
import { remainingBalance } from "./prepaid-expense.ts";
import { currentLoanBalance } from "./loans-ledger.ts";
import { computeYearTaxEstimate } from "./us-tax-estimate.ts";
import type { UsFilingStatus } from "./tax-usa-rules.ts";
import { estimateIndiaTaxForFy, fyOf } from "./india-tax-estimate.ts";

// Phase 2 of the free chat assistant (see app/api/assistant and components/ChatAssistant.tsx).
// Phase 1 (context-stuffing: build one big text snapshot, hand it to the model, ask it to read,
// filter, and do arithmetic over that text) kept failing the same way under different names:
// wrong refund signs, dropped vouchers while summing a list, "this fiscal year" silently answered
// from one month's data, calendar-year and fiscal-year totals treated as interchangeable. Every
// one of those was the model doing work a free, small LLM is bad at (exhaustive scanning, mental
// arithmetic) instead of work it's actually good at (deciding what to ask for).
//
// This module is the replacement: a small set of TOOLS with real, deterministic implementations.
// The model's only job is to pick a tool and fill in its arguments (including which PeriodName --
// resolvePeriod below does the Apr-Mar vs Jan-Dec date math in code, not in the model's head, which
// is exactly where the fiscal-year/calendar-year confusion came from). Every tool computes its own
// totals and returns them as plain, already-correct text -- there is no longer a giant blob for the
// model to summarize or sum itself.

const PERIOD_NAMES = ["current_month", "current_fiscal_year", "last_fiscal_year", "current_calendar_year", "last_calendar_year", "all_time"] as const;
export type PeriodName = (typeof PERIOD_NAMES)[number];

export function isPeriodName(v: unknown): v is PeriodName {
  return typeof v === "string" && (PERIOD_NAMES as readonly string[]).includes(v);
}

// Resolves a named period to a concrete [from, to] date range AND a human label, entirely in code
// -- the model never computes a date range itself, which is what caused "this fiscal year" to get
// silently answered with calendar-year data (and once, with the vault's entire 2016-2026 history)
// earlier in this feature's life. FY `fy` runs Apr `fy` - Mar `fy+1`, matching fiscalYearOf (same
// boundary the rest of this app's books use).
export function resolvePeriod(period: PeriodName, todayIso: string): { from: string; to: string; label: string } {
  const fy = fiscalYearOf(todayIso);
  const calYear = Number(todayIso.slice(0, 4));
  switch (period) {
    case "current_month": {
      const monthKey = todayIso.slice(0, 7);
      const [y, m] = monthKey.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${monthKey}-01`, to: `${monthKey}-${String(lastDay).padStart(2, "0")}`, label: `this calendar month (${monthKey})` };
    }
    case "current_fiscal_year":
      return { from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `FY${fy} (Apr ${fy} - Mar ${fy + 1})` };
    case "last_fiscal_year":
      return { from: `${fy - 1}-04-01`, to: `${fy}-03-31`, label: `FY${fy - 1} (Apr ${fy - 1} - Mar ${fy})` };
    case "current_calendar_year":
      return { from: `${calYear}-01-01`, to: `${calYear}-12-31`, label: `CY${calYear} (Jan-Dec ${calYear})` };
    case "last_calendar_year":
      return { from: `${calYear - 1}-01-01`, to: `${calYear - 1}-12-31`, label: `CY${calYear - 1} (Jan-Dec ${calYear - 1})` };
    case "all_time":
      return { from: "0000-01-01", to: "9999-12-31", label: "all time (every date on file)" };
  }
}

// Reads a tool's "period" argument defensively: falls back to current_fiscal_year (the most
// common real question) when it's missing or not one of the known names, same as before -- but
// now also surfaces a visible note in that fallback case, so a genuinely invalid value the model
// sent (as opposed to simply omitting the argument, which is normal) shows up in the conversation
// transcript instead of silently and invisibly becoming a different period than what was asked.
function readPeriodArg(args: Record<string, unknown>): { period: PeriodName; note: string } {
  const raw = args.period;
  if (isPeriodName(raw)) return { period: raw, note: "" };
  const note = raw === undefined ? "" : ` [note: received unrecognized period "${String(raw)}", defaulted to current_fiscal_year]`;
  return { period: "current_fiscal_year", note };
}

// Classifies one voucher's signed amount, nature, refund status, and the real account name(s) it
// posted to. Confirmed live (user's own Day Book data) that deriving spend-vs-refund from each
// entry's raw signed amount against its account's nature got it backwards -- the voucher's own
// `type` field is the correct, simple signal, exactly the convention lib/costco-reward.ts already
// uses and has proven correct: a "Payment" voucher is money going out (a purchase), a "Receipt"
// voucher against an expense account is money coming back (a refund/return). An Income entry
// anywhere in the voucher rules out the refund interpretation entirely (confirmed live a semi-
// monthly paystub -- gross pay plus withheld-tax/benefit deduction lines in the SAME voucher -- got
// mislabeled "REFUND/return" otherwise, just because it also touched an Expense account).
export function classifyVoucher(
  data: Ledger,
  masterGroups: Map<string, { nature: string }>,
  t: { type: string; entries: { accountId: number; amount: number }[] }
): { amt: number; nature: "Expense" | "Income" | null; isRefund: boolean; acctNames: string } {
  const magnitude = t.entries.reduce((s, e) => s + Math.abs(e.amount), 0) / 2;
  let nature: "Expense" | "Income" | null = null;
  const names = new Set<string>();
  for (const e of t.entries) {
    const acct = data.accounts.find((a) => a.id === e.accountId);
    if (!acct) continue;
    names.add(acct.name);
    const n = accountNature(acct, masterGroups);
    if (n === "Income") nature = "Income";
    else if (n === "Expense" && nature !== "Income") nature = "Expense";
  }
  const isReceipt = t.type.toLowerCase() === "receipt";
  const isRefund = nature === "Expense" && isReceipt;
  const amt = nature === "Expense" ? (isReceipt ? -magnitude : magnitude) : magnitude;
  return { amt, nature, isRefund, acctNames: [...names].join(" / ") };
}

// "Take-home" reads the voucher's own Bank/Cash-nature entry directly rather than deriving it by
// subtracting only the deduction buckets buildShadowPeriod recognizes (base/telephone/medical/
// 401k/tax) -- confirmed live that derived figure silently drifts from the real deposit the moment
// a voucher has any deduction line the parser doesn't recognize.
function salaryBreakdown(data: Ledger, masterGroups: Map<string, { nature: string }>, t: Tx) {
  const sp = buildShadowPeriod(t);
  const bankAmt = t.entries.reduce((s, e) => {
    const acct = data.accounts.find((a) => a.id === e.accountId);
    if (!acct) return s;
    const n = accountNature(acct, masterGroups);
    return n === "Bank" || n === "Cash" ? s + Math.abs(e.amount) : s;
  }, 0);
  return { gross: sp.base, tax: sp.tax, k401: sp.k401, medical: sp.medical, telephone: sp.telephone, net: bankAmt > 0 ? bankAmt : sp.net };
}

function masterGroupsOf(data: Ledger): Map<string, { nature: string }> {
  return new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g as unknown as { nature: string }]));
}

const MAX_RESULTS = 100;

// ---- tool: search_vouchers ------------------------------------------------------------------

function searchVouchers(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const terms = Array.isArray(args.terms) ? args.terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.toLowerCase().trim()) : [];
  if (!terms.length) return "search_vouchers error: no search terms given.";
  const { period, note } = readPeriodArg(args);
  const { from, to, label } = resolvePeriod(period, todayIso);
  const masterGroups = masterGroupsOf(data);
  const quoted = terms.map((t) => `"${t}"`).join(", ");

  const matches = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.date >= from && t.date <= to)
    .filter((t) => {
      const narration = t.narration.toLowerCase();
      if (terms.some((term) => narration.includes(term))) return true;
      return t.entries.some((e) => {
        const acct = data.accounts.find((a) => a.id === e.accountId);
        return acct && terms.some((term) => acct.name.toLowerCase().includes(term));
      });
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (!matches.length) return `search_vouchers(${quoted}, ${label}): 0 matching vouchers found.${note}`;

  // The total is computed here, once, over EVERY real match -- including any not shown below if
  // the list is truncated -- and stated as its own line the model is instructed (see the system
  // prompt) to quote verbatim. Confirmed live: even handed the correct voucher set, the model
  // still re-derived its own total by reading a subset of the listed lines and silently dropped
  // real matches doing it (understated a real $365.05 total as $171.02).
  let total = 0;
  for (const t of matches) total += classifyVoucher(data, masterGroups, t).amt;

  const truncated = matches.length > MAX_RESULTS;
  const shown = truncated ? matches.slice(0, MAX_RESULTS) : matches;
  const lines = [
    `search_vouchers(${quoted}, ${label}): ${matches.length} matching voucher(s).${note}`,
    `PRECOMPUTED TOTAL (authoritative, refunds already subtracted -- quote this exact number, do NOT add up the voucher lines yourself): ${total.toFixed(2)} ${data.currency}`,
    "",
    truncated ? `Voucher list (showing the first ${MAX_RESULTS} of ${matches.length} -- the total above already covers all ${matches.length}):` : "Voucher list (every match, for citing examples only -- the total above is already correct):",
  ];
  for (const t of shown) {
    const { amt, isRefund, acctNames } = classifyVoucher(data, masterGroups, t);
    const refundNote = isRefund ? " -- REFUND/return" : "";
    lines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} [accounts: ${acctNames}] (${amt.toFixed(2)} ${data.currency}${refundNote})`);
  }
  return lines.join("\n");
}

// ---- tool: get_account_ledger ----------------------------------------------------------------

// Confirmed live: asked to "check the Vehicle Maintenance account" for a Costco match,
// search_vouchers-style OR matching (any term anywhere) pulled in every voucher the account ever
// had (ChargePoint, Tesla, ...), drowning the free model in noise until it dropped real matches.
// This tool is the AND version: every voucher touching one SPECIFIC named account, regardless of
// narration -- the right tool whenever the user names a GL account directly.
function getAccountLedger(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const nameQuery = typeof args.accountName === "string" ? args.accountName.toLowerCase().trim() : "";
  if (!nameQuery) return "get_account_ledger error: no accountName given.";
  const { period, note } = readPeriodArg(args);
  const { from, to, label } = resolvePeriod(period, todayIso);

  // Confirmed live: asked "how much is the ESPP this FY", this tool's plain substring match found
  // MULTIPLE distinct real accounts whose name happens to contain "espp" (e.g. an ESPP payroll
  // deduction account AND a separate ESPP share-value/count account) and silently SUMMED vouchers
  // from both into one total that matched neither account's own real report -- exactly the
  // "blend unrelated accounts into one opaque number" failure this tool exists to avoid, just one
  // layer deeper than narration noise. An exact (case-insensitive) name match always wins outright
  // over a partial one; only when there's no exact match do multiple partial matches surface, and
  // even then they're reported as DISTINCT candidates (never silently blended) so the model has to
  // pick one or ask, instead of guessing by adding unrelated accounts together.
  const exact = data.accounts.filter((a) => a.name.toLowerCase() === nameQuery);
  const candidates = exact.length ? exact : data.accounts.filter((a) => a.name.toLowerCase().includes(nameQuery));
  if (!candidates.length) return `get_account_ledger("${args.accountName}"): no account found with that name.`;
  if (candidates.length > 1) {
    const names = candidates.map((a) => `"${a.name}"`).join(", ");
    return `get_account_ledger("${args.accountName}"): ${candidates.length} DIFFERENT accounts match that name (${names}) and none is an exact match -- these are DISTINCT real accounts with their own separate balances. Do NOT add their numbers together or guess which one is meant. Call this tool again once per account using its EXACT full name (one call per account) and report them separately, or ask the user which one they meant.`;
  }

  const theAccountId = candidates[0].id;

  const matches = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.date >= from && t.date <= to)
    .filter((t) => t.entries.some((e) => e.accountId === theAccountId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (!matches.length) return `get_account_ledger("${args.accountName}", ${label}): 0 vouchers found.${note}`;

  // Confirmed live: reusing classifyVoucher's Expense/refund-specific sign logic here produced a
  // badly wrong total ($41559.46 vs the real ledger report's $3802.22) for an Investment-nature
  // account (ESPP Deduction) -- that logic is a bespoke "is this a refund of an expense" scheme
  // built for search_vouchers' Costco-purchase-vs-return questions, and it only special-cases
  // Expense-nature accounts; every other nature (Investment, Bank, Cash, Asset, ...) just falls
  // through to an always-positive magnitude, discarding the real debit/credit direction entirely.
  // This instead mirrors the real Ledger report's own math EXACTLY (see ledgerSignedAmount in
  // components/TransactionTable.tsx, the function that actually produces the "Displayed total" the
  // user is comparing against): sum THIS account's own entry amount(s) in the voucher, then flip
  // the sign -- a debit to the account displays positive, a credit displays negative, independent
  // of account nature, matching the real ledger UI for any account.
  let total = 0;
  const allLines: string[] = [];
  for (const t of matches) {
    const rawForThisAccount = t.entries.filter((e) => e.accountId === theAccountId).reduce((s, e) => s + e.amount, 0);
    const displayAmt = -rawForThisAccount;
    total += displayAmt;
    const otherAccounts = [...new Set(t.entries.filter((e) => e.accountId !== theAccountId).map((e) => data.accounts.find((a) => a.id === e.accountId)?.name).filter((n): n is string => !!n))].join(" / ");
    allLines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} [other side: ${otherAccounts || "n/a"}] (${displayAmt.toFixed(2)} ${data.currency})`);
  }

  const truncated = matches.length > MAX_RESULTS;
  const shownLines = truncated ? allLines.slice(0, MAX_RESULTS) : allLines;
  const lines = [
    `get_account_ledger("${args.accountName}", ${label}): ${matches.length} voucher(s).${note}`,
    `PRECOMPUTED TOTAL (authoritative -- quote this exact number, do NOT add up the voucher lines yourself): ${total.toFixed(2)} ${data.currency}`,
    "",
    truncated ? `Voucher list (showing the first ${MAX_RESULTS} of ${matches.length} -- the total above already covers all ${matches.length}):` : "Voucher list (every voucher in this account for the period, for citing examples only):",
    ...shownLines,
  ];
  return lines.join("\n");
}

// ---- tool: search_accounts -------------------------------------------------------------------

// User's own original ask: "why is it when I say Gas or Gasoline, it should automatically check
// all narration with GL account which are related to Gas - may be Travelling or Vehicle
// Maintenance or House Hold?" -- a conceptual category can legitimately span SEVERAL distinct real
// accounts, which neither existing tool handles well: search_vouchers is narration/account-name
// substring matching across EVERY account (too broad, drowns in noise, confirmed live).
// get_account_ledger is exactly ONE named account (too narrow for a category). This is the
// multi-account version of get_account_ledger: the caller supplies the SPECIFIC real account
// names that make up the category (the model is expected to know/discover them, e.g. via a prior
// get_account_balances call), and each name is resolved to exactly one real account using the
// SAME exact-match-wins / refuse-to-blend-on-ambiguity rule get_account_ledger already uses --
// this is deliberately NOT fuzzy category guessing in code (that was the ESPP-blending bug class),
// it's an explicit, named list of real accounts, each contributing its own clearly-labeled total.
function searchAccounts(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const namesArg = Array.isArray(args.accountNames)
    ? args.accountNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    : [];
  if (!namesArg.length) return "search_accounts error: no accountNames given.";
  const { period, note } = readPeriodArg(args);
  const { from, to, label } = resolvePeriod(period, todayIso);
  const terms = Array.isArray(args.terms)
    ? args.terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.toLowerCase().trim())
    : [];

  const resolved: { query: string; account: { id: number; name: string } }[] = [];
  const problems: string[] = [];
  for (const nameQuery of namesArg) {
    const q = nameQuery.toLowerCase().trim();
    const exact = data.accounts.filter((a) => a.name.toLowerCase() === q);
    const candidates = exact.length ? exact : data.accounts.filter((a) => a.name.toLowerCase().includes(q));
    if (!candidates.length) {
      problems.push(`"${nameQuery}": no account found with that name`);
      continue;
    }
    if (candidates.length > 1) {
      problems.push(`"${nameQuery}": ambiguous -- matches ${candidates.map((a) => `"${a.name}"`).join(", ")}, none exact -- skipped rather than guessed`);
      continue;
    }
    resolved.push({ query: nameQuery, account: candidates[0] });
  }
  if (!resolved.length) return `search_accounts: could not resolve any of the given account names to a real account. ${problems.join("; ")}.`;

  const accountNameById = new Map(resolved.map((r) => [r.account.id, r.account.name]));
  const matches = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.date >= from && t.date <= to)
    .filter((t) => t.entries.some((e) => accountNameById.has(e.accountId)))
    .filter((t) => !terms.length || terms.some((term) => t.narration.toLowerCase().includes(term)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const resolvedNames = resolved.map((r) => r.account.name).join(", ");
  const problemNote = problems.length ? ` [note: could not resolve ${problems.join("; ")}]` : "";
  const header = `search_accounts(${resolvedNames}${terms.length ? `, narration matches [${terms.join(", ")}]` : ""}, ${label})`;
  if (!matches.length) return `${header}: 0 vouchers found.${note}${problemNote}`;

  // Same display formula as get_account_ledger (mirrors the real Ledger report's own math): sum
  // this voucher's entries against each REQUESTED account, flip the sign. A voucher that happens
  // to touch two of the requested accounts at once is counted once per account it touches (real,
  // if rare, for inter-category transfers) -- never silently blended into one unlabeled figure.
  let total = 0;
  const perAccountTotal = new Map<number, number>();
  const allLines: string[] = [];
  for (const t of matches) {
    let voucherAmt = 0;
    const touchedNames = new Set<string>();
    for (const e of t.entries) {
      const name = accountNameById.get(e.accountId);
      if (!name) continue;
      const amt = -e.amount;
      voucherAmt += amt;
      perAccountTotal.set(e.accountId, (perAccountTotal.get(e.accountId) ?? 0) + amt);
      touchedNames.add(name);
    }
    total += voucherAmt;
    allLines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} [account: ${[...touchedNames].join(" / ")}] (${voucherAmt.toFixed(2)} ${data.currency})`);
  }

  const truncated = allLines.length > MAX_RESULTS;
  const shownLines = truncated ? allLines.slice(0, MAX_RESULTS) : allLines;
  const breakdown = resolved.map((r) => `${r.account.name}: ${(perAccountTotal.get(r.account.id) ?? 0).toFixed(2)}`).join(", ");
  const lines = [
    `${header}: ${matches.length} voucher(s) across ${resolved.length} account(s).${note}${problemNote}`,
    `PRECOMPUTED TOTAL (authoritative, combined across all requested accounts -- quote this exact number, do NOT add up the voucher lines yourself): ${total.toFixed(2)} ${data.currency}`,
    `Per-account breakdown (same combined total, split by account so you can see where it came from): ${breakdown} ${data.currency}`,
    "",
    truncated ? `Voucher list (showing the first ${MAX_RESULTS} of ${matches.length} -- the total above already covers all ${matches.length}):` : "Voucher list (for citing examples only -- the total above is already correct):",
    ...shownLines,
  ];
  return lines.join("\n");
}

// ---- tool: get_salary_summary ----------------------------------------------------------------

function getSalarySummary(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const { period, note } = readPeriodArg(args);
  const { from, to, label } = resolvePeriod(period, todayIso);
  const masterGroups = masterGroupsOf(data);

  const salaryTx = data.transactions.filter((t) => !t.deleted && !t.cancelled && t.date >= from && t.date <= to && isSalaryVoucher(t));
  if (!salaryTx.length) return `get_salary_summary(${label}): 0 paystub vouchers found.${note}`;

  const totals = salaryTx.reduce(
    (acc, t) => {
      const b = salaryBreakdown(data, masterGroups, t);
      acc.gross += b.gross;
      acc.tax += b.tax;
      acc.k401 += b.k401;
      acc.medical += b.medical;
      acc.telephone += b.telephone;
      acc.net += b.net;
      return acc;
    },
    { gross: 0, tax: 0, k401: 0, medical: 0, telephone: 0, net: 0 }
  );
  return [
    `get_salary_summary(${label}): ${salaryTx.length} paystub voucher(s).${note}`,
    `PRECOMPUTED TOTALS (authoritative -- quote these exact numbers, do NOT recompute from anywhere else): gross pay ${totals.gross.toFixed(2)}, tax deducted ${totals.tax.toFixed(2)}, 401k ${totals.k401.toFixed(2)}, medical/health ${totals.medical.toFixed(2)}, telephone ${totals.telephone.toFixed(2)}, net take-home (actual bank deposits) ${totals.net.toFixed(2)} ${data.currency}`,
  ].join("\n");
}

// ---- tool: get_account_balances --------------------------------------------------------------

function getAccountBalances(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const nameFilter = typeof args.nameFilter === "string" ? args.nameFilter.toLowerCase().trim() : "";
  const accounts = data.accounts.filter((a) => a.active !== false && (!nameFilter || a.name.toLowerCase().includes(nameFilter)));
  const lines = [
    "get_account_balances: CUMULATIVE balances since each account was opened -- NOT scoped to any period, NOT year-to-date.",
  ];
  let any = false;
  for (const a of accounts) {
    // Confirmed live: asked "closing balance of 401K as of today", this showed -$97,452.78 against
    // the real dashboard's own +$97,452.78 for the same account -- a double-negation bug.
    // ledgerBalanceAsOf already returns the final, correctly-signed display value on its own (it
    // negates the raw opening+entries sum internally) -- EVERY other call site in this entire
    // codebase (VaultApp.tsx, BalanceConfirmationLetter.tsx, cash-flow-forecast.ts,
    // financial-ratios.ts, ...) uses it directly for exactly that reason. Wrapping it in
    // displayLedgerBalance() here (the only call site that did) applied a SECOND negation on top,
    // flipping every balance's sign back to wrong.
    const bal = ledgerBalanceAsOf(data, a.id, todayIso);
    if (Math.abs(bal) < 0.01) continue;
    any = true;
    lines.push(`- ${a.name} [${a.parent}]: ${bal.toFixed(2)} ${a.currency || data.currency}`);
  }
  if (!any) lines.push(nameFilter ? `(no non-zero account matches "${nameFilter}")` : "(no non-zero accounts)");
  return lines.join("\n");
}

// ---- tool: get_fbar_status -------------------------------------------------------------------

function getFbarStatus(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const year = typeof args.year === "number" && Number.isFinite(args.year) ? args.year : Number(todayIso.slice(0, 4));
  const fbar = computeFbarSummary(data, year);
  return `get_fbar_status(CY${year}): FBAR (FinCEN Form 114) combined peak value ${
    fbar.rate ? `$${fbar.totalUsd.toFixed(2)}` : "unknown (no Treasury rate on file for this year)"
  }, threshold $10,000 -- ${fbar.rate ? (fbar.thresholdExceeded ? "filing IS required" : "filing is NOT required") : "cannot determine yet"}.`;
}

// ---- tool: get_equity_position ---------------------------------------------------------------

// Replicates EXACTLY the dashboard's own "Equity (NVDA)" card math (components/VaultApp.tsx,
// the equityRsuMktValue/equityEsppMktValue/equityScheduledShares/equityDailyGL block) rather than
// a different approximation -- confirmed this session (the ESPP account-blending and double-
// negation bugs) that a plausible-looking but DIFFERENT formula from the real UI is exactly how a
// wrong-but-confident chat answer happens. Needs a live stock price, which this module can't fetch
// itself (no network access from a pure lib function) -- the caller (ChatAssistant.tsx) already
// fetches it once on mount for the dashboard and passes it through here.
function getEquityPosition(data: Ledger, livePrice: number | null, prevClose: number | null, todayIso: string): string {
  if (!data.equity || (!data.equity.grants.length && !data.equity.esppPurchases.length)) {
    return "get_equity_position: no RSU/ESPP equity data on file.";
  }
  if (!livePrice) {
    return "get_equity_position: live stock price is currently unavailable, so market value can't be computed right now -- try again shortly.";
  }
  const cur = livePrice;
  const grants = data.equity.grants;
  const esppPurchases = data.equity.esppPurchases;

  const equityPendingEsppShares = computePendingEsppCycles(esppPurchases, data.payroll, todayIso).reduce((s, c) => s + c.estimatedShares, 0);
  const equityRsuHeldShares = grants.reduce((s, g) => s + g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.sharesHeld, 0), 0);
  const equityRsuMktValue = grants.reduce((s, g) => {
    const actualVested = g.vests.filter((v) => !v.pending);
    const pendingVests = g.vests.filter((v) => v.pending);
    const vestedTotal = actualVested.reduce((vs, v) => vs + v.shares, 0);
    const pendingShares = pendingVests.reduce((vs, v) => vs + v.shares, 0);
    const unvested = Math.max(0, g.totalShares - vestedTotal - pendingShares);
    return s + actualVested.reduce((vs, v) => vs + v.sharesHeld * cur, 0) + (pendingShares + unvested) * cur;
  }, 0);
  const equityEsppHeldShares = esppPurchases.reduce((s, e) => s + (e.sharesHeld || e.shares), 0);
  const equityEsppMktValue = (equityEsppHeldShares + equityPendingEsppShares) * cur;
  const equityMktValue = equityRsuMktValue + equityEsppMktValue;
  const equityTotalShares =
    equityRsuHeldShares +
    equityEsppHeldShares +
    grants.reduce((s, g) => {
      const vestedTotal = g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.shares, 0);
      const pendingShares = g.vests.filter((v) => v.pending).reduce((vs, v) => vs + v.shares, 0);
      return s + pendingShares + Math.max(0, g.totalShares - vestedTotal - pendingShares);
    }, 0) +
    equityPendingEsppShares;
  const equityRsuScheduledShares = grants.reduce((s, g) => s + g.vests.filter((v) => v.pending).reduce((vs, v) => vs + v.shares, 0), 0);
  const equityScheduledShares = equityRsuScheduledShares + equityPendingEsppShares;
  const equityScheduledValue = equityScheduledShares * cur;
  const equityDailyHeld =
    grants.reduce((s, g) => s + g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.sharesHeld, 0), 0) +
    esppPurchases.reduce((s, e) => s + (e.sharesHeld || e.shares), 0);
  const equityDailyGL = prevClose !== null ? equityDailyHeld * (cur - prevClose) : null;

  const lines = [
    `get_equity_position (live price $${cur.toFixed(2)}):`,
    `RSU market value: ${equityRsuMktValue.toFixed(2)} ${data.currency}`,
    `ESPP market value: ${equityEsppMktValue.toFixed(2)} ${data.currency}`,
    `Total equity market value (RSU + ESPP, includes scheduled/unvested shares): ${equityMktValue.toFixed(2)} ${data.currency}`,
    `Total shares (held + scheduled): ${equityTotalShares.toFixed(4)}`,
    `Scheduled/pending future shares: ${equityScheduledShares.toFixed(4)}, value ${equityScheduledValue.toFixed(2)} ${data.currency}`,
  ];
  lines.push(
    equityDailyGL !== null
      ? `Today's gain/loss on HELD (already-vested, non-pending) shares vs previous close: ${equityDailyGL.toFixed(2)} ${data.currency}`
      : "Today's gain/loss: unavailable (previous close not loaded)."
  );
  return lines.join("\n");
}

// ---- tool: get_net_worth -----------------------------------------------------------------------

function getNetWorth(data: Ledger, livePrice: number | null, todayIso: string): string {
  const trend = computeNetWorthTrend(data.accounts, data.transactions, data.groups || []);
  if (!trend.length) return "get_net_worth: no transaction history to compute net worth from.";
  const latest = trend[trend.length - 1];

  // Confirmed in this app's own Net Worth report: ledger-only net worth already includes 401(k)/
  // investment accounts at their BOOK value (cumulative contributions), and separately bolts on
  // the LIVE market value of held RSU/ESPP shares (components/reports/NetWorthReport.tsx's
  // equityHoldingsRow) when a live price is available -- same adjustment made here, using the
  // SAME lib/equity-holdings.ts helper that report uses (held shares only, not pending/unvested,
  // which is a DIFFERENT, broader figure than get_equity_position's dashboard-card total).
  let netWorth = latest.netWorth;
  let note = " -- ledger-only book value; a live stock price was not available to add RSU/ESPP market value on top.";
  if (data.equity && livePrice) {
    const held = computeHeldEquityValue(data.equity.grants, data.equity.esppPurchases, livePrice);
    netWorth += held.totalValue;
    note = ` -- includes live RSU/ESPP held value of ${held.totalValue.toFixed(2)} ${data.currency} on top of the ledger book value.`;
  }
  return [
    `get_net_worth (as of ${latest.fyEndDate}, ${latest.label}):`,
    `Assets: ${latest.assets.toFixed(2)} ${data.currency}`,
    `Real liabilities (loans, credit cards, sundry creditors): ${latest.liabilities.toFixed(2)} ${data.currency}`,
    `Net worth: ${netWorth.toFixed(2)} ${data.currency}${note}`,
    "NOTE: this does NOT include a LIVE 401(k)/retirement brokerage balance (only the book value already counted in Assets above) -- that requires a live brokerage connection this assistant doesn't have access to, so it may read lower than the app's own Net Worth report by that difference.",
  ].join("\n");
}

// ---- tool: get_trading_gains --------------------------------------------------------------------

// REALIZED gains/losses from actual sales only (RSU sales, ESPP sales, and other brokerage trades)
// -- NOT the live unrealized value of shares still held (that's get_equity_position). Reuses the
// exact same classification/netting this app's own Tax Report uses (lib/tax-classify.ts), rather
// than a second, possibly-inconsistent computation.
function getTradingGains(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const year = typeof args.year === "string" && /^\d{4}$/.test(args.year) ? args.year : todayIso.slice(0, 4);
  const grants = data.equity?.grants ?? [];
  const esppPurchases = data.equity?.esppPurchases ?? [];
  const trades = data.trades ?? [];
  const employerTickers = new Set<string>();
  for (const g of grants) employerTickers.add(g.ticker);
  for (const e of esppPurchases) employerTickers.add(e.ticker);

  const events = [...classifyRsuSales(grants, year, 365), ...classifyEsppSales(esppPurchases, year, 365), ...classifyTradingSales(trades, year, 365, employerTickers)];
  if (!events.length) return `get_trading_gains(CY${year}): 0 realized sale(s) found for this calendar year. This covers SALES only, not the current value of shares still held.`;

  const summary = summarizeCapitalGains(events);
  const lines = [
    `get_trading_gains(CY${year}): ${events.length} realized sale(s) this calendar year. These are REALIZED gains/losses from actual sales ONLY -- NOT the live unrealized value of shares still held (use get_equity_position for that).`,
    `PRECOMPUTED TOTALS (authoritative -- quote these exact numbers, do NOT recompute): net short-term ${summary.netShortTerm.toFixed(2)}, net long-term ${summary.netLongTerm.toFixed(2)}, short-term taxable ${summary.shortTermGainTaxable.toFixed(2)}, long-term taxable ${summary.longTermGainTaxable.toFixed(2)} ${data.currency}`,
  ];
  if (summary.ordinaryLossDeduction > 0) lines.push(`Ordinary-income loss deduction (capped at $3,000/yr): ${summary.ordinaryLossDeduction.toFixed(2)} ${data.currency}`);
  if (summary.lossCarryforward > 0) lines.push(`Loss beyond the cap, informational only (not tracked to future years by this app): ${summary.lossCarryforward.toFixed(2)} ${data.currency}`);
  return lines.join("\n");
}

// ---- tool: get_financial_ratios ----------------------------------------------------------------

function getFinancialRatios(data: Ledger): string {
  const points = computeFinancialRatios(data);
  if (!points.length) return "get_financial_ratios: no fiscal-year history to compute ratios from.";
  const latest = points[points.length - 1];
  const pct = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(1)}%`);
  return [
    `get_financial_ratios (latest: ${latest.label}, FY${latest.fy}; savingsRate/growth figures are already percentages):`,
    `Income: ${latest.income.toFixed(2)}, Expense: ${latest.expense.toFixed(2)}, Savings rate: ${pct(latest.savingsRate)} ${data.currency}`,
    `Liquid assets (Bank + Cash): ${latest.liquidAssets.toFixed(2)} ${data.currency}`,
    `Total debt (all liabilities): ${latest.totalDebt.toFixed(2)} ${data.currency}`,
    `Emergency fund: ${latest.emergencyFundMonths !== null ? `${latest.emergencyFundMonths.toFixed(1)} months of expenses covered by liquid assets` : "n/a (monthly expense ~0)"}`,
    `Debt-to-income: ${latest.debtToIncome !== null ? latest.debtToIncome.toFixed(2) : "n/a (income ~0)"}`,
    `Net worth growth vs prior year: ${latest.netWorthGrowthPct !== null ? pct(latest.netWorthGrowthPct) : "n/a (first year on file)"}`,
    `(${points.length} fiscal year(s) of history available; this is the most recent, ${latest.label}.)`,
  ].join("\n");
}

// ---- tool: get_cash_flow_forecast --------------------------------------------------------------

function getCashFlowForecast(data: Ledger, args: Record<string, unknown>): string {
  const months = typeof args.months === "number" && args.months > 0 && args.months <= 24 ? Math.round(args.months) : 6;
  const forecast = computeCashFlowForecast(data, months);
  if (!forecast.points.length) return "get_cash_flow_forecast: not enough data to project a forecast.";
  const lines = [`get_cash_flow_forecast (next ${months} month(s), starting from today):`];
  for (const p of forecast.points) {
    lines.push(
      `- ${p.label}: paycheck ${p.paycheckNet.toFixed(2)}, passive income ${p.passiveIncome.toFixed(2)}, living expenses ${p.livingExpenses.toFixed(2)}, recurring net ${p.recurringNet.toFixed(2)}, loan payments ${p.loanPayments.toFixed(2)}, yearly items ${p.yearlyNet.toFixed(2)} -> projected cash balance ${p.projectedCash.toFixed(2)} ${data.currency}`
    );
  }
  if (forecast.budgetTieIn) {
    const b = forecast.budgetTieIn;
    lines.push(
      `Budget tie-in (FY${b.fy}): budgeted net ${b.budgetedNet.toFixed(2)}, YTD actual net ${b.ytdActualNet.toFixed(2)}, projected remaining ${b.projectedRemainingNet.toFixed(2)}, projected full-year net ${b.projectedFYNet.toFixed(2)}, variance vs budget ${b.varianceVsBudget.toFixed(2)} ${data.currency}`
    );
  }
  return lines.join("\n");
}

// ---- tool: get_budget_vs_actual ----------------------------------------------------------------

function getBudgetVsActual(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  const fy = typeof args.fy === "string" && /^\d{4}$/.test(args.fy) ? args.fy : String(fiscalYearOf(todayIso));
  const budget = (data.budgets ?? []).find((b) => b.fy === fy);
  if (!budget) return `get_budget_vs_actual(FY${fy}): no budget saved for this fiscal year.`;
  const { expenseRows } = budgetVsActualRows(data, budget, fy, "monthly");
  const totalBudget = expenseRows.reduce((s, r) => s + r.totalBudget, 0);
  const totalActual = expenseRows.reduce((s, r) => s + r.totalActual, 0);
  const lines = [
    `get_budget_vs_actual(FY${fy}): total expense budget ${totalBudget.toFixed(2)}, actual ${totalActual.toFixed(2)}, variance ${(totalActual - totalBudget).toFixed(2)} ${data.currency} (positive = over budget).`,
  ];
  const overBudget = expenseRows
    .filter((r) => r.varianceAmt > 0.5)
    .sort((a, b) => b.varianceAmt - a.varianceAmt)
    .slice(0, 5);
  if (overBudget.length) {
    lines.push("Top over-budget expense categories:");
    for (const r of overBudget) lines.push(`- ${r.name}: budget ${r.totalBudget.toFixed(2)}, actual ${r.totalActual.toFixed(2)}, over by ${r.varianceAmt.toFixed(2)} ${data.currency}`);
  }
  return lines.join("\n");
}

// ---- tool: get_multi_year_trend ----------------------------------------------------------------

function getMultiYearTrend(data: Ledger): string {
  const points = computeMultiYearTrend(data);
  if (!points.length) return "get_multi_year_trend: no fiscal-year history on file.";
  const lines = ["get_multi_year_trend (oldest to latest fiscal year):"];
  for (const p of points) {
    const growth = p.netWorthGrowthPct !== null ? ` (${p.netWorthGrowthPct >= 0 ? "+" : ""}${p.netWorthGrowthPct.toFixed(1)}% net worth vs prior year)` : "";
    lines.push(`- ${p.label}: income ${p.income.toFixed(2)}, expense ${p.expense.toFixed(2)}, surplus ${p.surplus.toFixed(2)}, net worth ${p.netWorth.toFixed(2)} ${data.currency}${growth}`);
  }
  return lines.join("\n");
}

// ---- tool: get_401k_summary --------------------------------------------------------------------

function get401kSummary(data: Ledger): string {
  const byYear = compute401kByYear(data.payroll);
  if (!byYear.length) return "get_401k_summary: no payroll/401k data on file.";
  const lifetime = compute401kLifetimeTotals(data.payroll);
  const lines = [
    `get_401k_summary: lifetime self contributions ${lifetime.self.toFixed(2)}, lifetime employer match ${lifetime.employer.toFixed(2)}, lifetime total ${(lifetime.self + lifetime.employer).toFixed(2)} ${data.currency}.`,
    "By year:",
  ];
  for (const y of byYear) lines.push(`- ${y.year}: self ${y.self.toFixed(2)}, employer match ${y.employer.toFixed(2)} ${data.currency}`);
  return lines.join("\n");
}

// ---- tool: get_fixed_assets --------------------------------------------------------------------

function getFixedAssets(data: Ledger, todayIso: string): string {
  const assets = (data.fixedAssets ?? []).filter((a) => !a.disposed);
  if (!assets.length) return "get_fixed_assets: no (non-disposed) fixed assets on file.";
  let totalBook = 0;
  const lines = ["get_fixed_assets (current book value, straight-line depreciation):"];
  for (const a of assets) {
    const bv = bookValue(a, todayIso);
    totalBook += bv;
    lines.push(`- ${a.name}${a.assetClass ? ` [${a.assetClass}]` : ""}: cost ${a.cost.toFixed(2)}, book value ${bv.toFixed(2)} ${data.currency}`);
  }
  lines.push(`PRECOMPUTED TOTAL book value across all assets: ${totalBook.toFixed(2)} ${data.currency}`);
  return lines.join("\n");
}

// ---- tool: get_loans ----------------------------------------------------------------------------

function getLoans(data: Ledger, todayIso: string): string {
  const loans = (data.loans ?? []).filter((l) => !l.closed);
  if (!loans.length) return "get_loans: no open loans on file.";
  let totalOwed = 0;
  const lines = ["get_loans (current balance owed):"];
  for (const l of loans) {
    const bal = currentLoanBalance(data, l, todayIso);
    totalOwed += bal;
    lines.push(`- ${l.name}: balance owed ${bal.toFixed(2)} ${data.currency}, rate ${(l.annualRate * 100).toFixed(2)}%, standard payment ${l.standardPayment.toFixed(2)}`);
  }
  lines.push(`PRECOMPUTED TOTAL owed across all open loans: ${totalOwed.toFixed(2)} ${data.currency}`);
  return lines.join("\n");
}

// ---- tool: get_prepaid_expenses ----------------------------------------------------------------

function getPrepaidExpenses(data: Ledger, todayIso: string): string {
  const items = (data.prepaidExpenses ?? []).filter((p) => !p.writtenOff);
  if (!items.length) return "get_prepaid_expenses: no (non-written-off) prepaid expenses on file.";
  let totalRemaining = 0;
  const lines = ["get_prepaid_expenses (remaining unamortized balance):"];
  for (const p of items) {
    const rem = remainingBalance(p, todayIso);
    totalRemaining += rem;
    lines.push(`- ${p.name}: original total ${p.totalAmount.toFixed(2)}, remaining ${rem.toFixed(2)} ${data.currency}`);
  }
  lines.push(`PRECOMPUTED TOTAL remaining prepaid balance: ${totalRemaining.toFixed(2)} ${data.currency}`);
  return lines.join("\n");
}

// ---- tool: get_us_tax_estimate -----------------------------------------------------------------

// Mirrors TaxReport.tsx's own call to computeYearTaxEstimate (filingStatus "mfj", hsaCoverage
// "family" are that report's own UI defaults -- see lib/us-tax-estimate.ts's own comment for why
// the underlying logic is a verbatim copy rather than a shared extraction).
function getUsTaxEstimate(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  if (!data.payroll) return "get_us_tax_estimate: no payroll data on file.";
  const year = typeof args.year === "string" && /^\d{4}$/.test(args.year) ? args.year : todayIso.slice(0, 4);
  const rawYr = data.payroll.years.find((y) => y.year === year);
  if (!rawYr) return `get_us_tax_estimate: no payroll data found for ${year}.`;
  const filingStatus: UsFilingStatus = args.filingStatus === "single" ? "single" : "mfj";
  const est = computeYearTaxEstimate(rawYr, data.transactions, data.accounts, data.equity, data.trades, filingStatus, "family");
  // Confirmed live: asked "what will I owe in taxes", the model answered with the GROSS estimated
  // tax liability (federal + state added together) instead of what's actually still owed after
  // withholding -- for the real case that exposed this, CA alone was a $17,681.20 REFUND (withheld
  // exceeded the CA tax), the opposite of "owed", yet got summed into an "owed" total anyway. The
  // gross liability figures alone are genuinely ambiguous for an "owe" question -- net balance
  // due/refund (per side AND combined) is now computed and labeled explicitly as the one to quote,
  // so there's no figure left for the model to mispick.
  const netFederal = est.federalBalanceDue - est.federalRefund; // positive = owed, negative = refund
  const netState = est.stateBalanceDue - est.stateRefund;
  const netCombined = netFederal + netState;
  const describe = (net: number) => (net >= 0 ? `OWE (balance due) ${net.toFixed(2)}` : `get a REFUND of ${Math.abs(net).toFixed(2)}`);
  return [
    `get_us_tax_estimate(${est.year}, filing status: ${filingStatus}): AGI ${est.agi.toFixed(2)}, deduction used ${est.deductionUsed.toFixed(2)} (${est.usedItemized ? "itemized" : "standard"}), long-term capital gain ${est.longTermGain.toFixed(2)} ${data.currency}.`,
    `Federal: gross estimated tax ${est.estimatedFederalTax.toFixed(2)}, already withheld ${est.federalWithheld.toFixed(2)} -> you ${describe(netFederal)} ${data.currency}.`,
    `State (${est.stateName}, ${est.stateCode}): taxable income ${est.stateTaxableIncome.toFixed(2)}, gross estimated tax ${est.estimatedStateTax.toFixed(2)}, already withheld ${est.stateWithheld.toFixed(2)} -> you ${describe(netState)} ${data.currency}.`,
    `PRECOMPUTED TOTAL (authoritative -- THIS is the number for a plain "what will I owe"/"what's my refund" question, NOT the gross tax figures above, which ignore withholding): combined federal + state, you ${describe(netCombined)} ${data.currency}.`,
    "This is an ESTIMATE for planning purposes, not a filed return -- verify with a tax professional before relying on it.",
  ].join("\n");
}

// ---- tool: get_india_tax_estimate --------------------------------------------------------------

// Built on estimateIndiaTaxForFy (see lib/india-tax-estimate.ts's own comment on why that's a
// deliberately simplified standalone, not a full replication of IndiaTaxReport.tsx's own
// capital-gains-aware estimate logic).
function getIndiaTaxEstimate(data: Ledger, args: Record<string, unknown>, todayIso: string): string {
  if (!data.indiaTax) return "get_india_tax_estimate: no India tax data (payslips/ITR) on file.";
  const fy = typeof args.fy === "string" && /^\d{4}-\d{2}$/.test(args.fy) ? args.fy : fyOf(todayIso);
  const months = data.indiaTax.payslips?.months ?? [];
  const result = estimateIndiaTaxForFy(fy, months, data.indiaTax.itrYears);
  // Three distinct cases, not just "real vs estimate": a filed ITR gives the real figure; no ITR
  // but the year's slabs ARE modeled gives our own estimate; no ITR AND the slabs aren't modeled
  // means the underlying 0 is neither a real figure nor a valid estimate -- must say so plainly
  // rather than mislabeling that 0 as either.
  const canEstimate = !result.hasFiledItr && result.isEstimate;
  const cannotDetermine = !result.hasFiledItr && !result.isEstimate;
  const taxLabel = result.hasFiledItr
    ? " (real filed figure)"
    : canEstimate
      ? " (ESTIMATE -- ordinary slab rates only, does NOT account for capital-gains special rates)"
      : " (cannot determine -- no ITR filed for this year and its tax slabs aren't modeled by this app)";
  // Confirmed live on the US tax tool: a gross tax-liability figure labeled as THE authoritative
  // total is genuinely ambiguous for a plain "what will I owe" question -- the model grabbed the
  // gross number over the real net refund/balance-due figure, and got a real refund case backwards
  // entirely. The net refund/balance-due (taxesPaidTotal - taxPayable, already computed as
  // result.refund) is now the one explicitly labeled as THE number to quote for "owe"/"refund"
  // questions; the gross tax payable is still shown, but only as supporting detail.
  const netLabel = result.refund >= 0 ? `get a REFUND of ${result.refund.toFixed(2)}` : `OWE (balance due) ${Math.abs(result.refund).toFixed(2)}`;
  const lines = [
    `get_india_tax_estimate(FY${result.fy}, AY${result.ay}): taxable income ${result.taxableIncome.toFixed(2)} ${data.currency} -- ${result.hasFiledItr ? "this year has a FILED ITR on record" : "NO ITR filed yet for this year"}.`,
    `Gross tax payable ${result.taxPayable.toFixed(2)} ${data.currency}${taxLabel}; taxes already paid (TDS + advance + self-assessment) ${result.taxesPaidTotal.toFixed(2)} ${data.currency}.`,
    `PRECOMPUTED TOTAL (authoritative -- THIS is the number for a plain "what will I owe"/"what's my refund" question, NOT the gross tax payable above, which ignores taxes already paid): you ${netLabel} ${data.currency}.`,
  ];
  if (canEstimate) lines.push("This is an ESTIMATE for planning purposes, not a filed return -- verify with a tax professional before relying on it.");
  if (cannotDetermine) lines.push("Say plainly that this year's tax can't be determined (no ITR on file, and this app doesn't model that year's tax slabs) -- do not state the taxable income or 0 as if it were an answer.");
  return lines.join("\n");
}

// ---- tool schemas (sent to Workers AI's `tools` parameter) ------------------------------------

const PERIOD_PARAM = {
  type: "string",
  enum: PERIOD_NAMES as unknown as string[],
  description:
    "Which time period to search. 'current_fiscal_year' and 'last_fiscal_year' are this app's own Apr-Mar books fiscal year (NOT the calendar year) -- use these whenever the question says 'fiscal year' or 'FY'. 'current_calendar_year' and 'last_calendar_year' are Jan-Dec -- use these only when the question actually says 'calendar year' or names a specific year. Never guess a date range yourself; always pick one of these named periods.",
};

export const TOOL_DEFS: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "search_vouchers",
    description:
      "Search ALL vouchers (any account) whose narration OR whose touched account name contains ANY of the given search terms, within one time period. Returns an authoritative precomputed total plus the matching vouchers. Use this for a merchant or category question (e.g. 'how much did I spend at Costco', 'gasoline spend') when the user has NOT named a specific GL account.",
    parameters: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" }, description: "One or more words to search for (e.g. [\"costco\"], [\"gas\",\"gasoline\"]). Lowercase, single words, no generic filler words like 'spend' or 'total'." },
        period: PERIOD_PARAM,
      },
      required: ["terms", "period"],
    },
  },
  {
    name: "get_account_ledger",
    description:
      "Get EVERY voucher that touches one SPECIFIC named account (e.g. 'Vehicle Maintenance', 'Travelling Expenses', 'House Hold Exps'), regardless of narration, within one time period. Returns an authoritative precomputed total plus the matching vouchers. Use this when the user names a specific GL/ledger account directly, instead of search_vouchers.",
    parameters: {
      type: "object",
      properties: {
        accountName: { type: "string", description: "The account/ledger name (or a distinctive substring of it) to look up." },
        period: PERIOD_PARAM,
      },
      required: ["accountName", "period"],
    },
  },
  {
    name: "search_accounts",
    description:
      "Get EVERY voucher across SEVERAL SPECIFIC named accounts at once, combined into one authoritative total plus a per-account breakdown, within one time period. Use this when the user names a CATEGORY or MERCHANT that spans more than one real GL account (e.g. 'gas'/'gasoline' spend could live in 'Vehicle Maintenance', 'Travelling Expenses', AND 'House Hold Exps') -- call get_account_balances first if you don't already know the real account names to list, then pass each one here. This is the multi-account version of get_account_ledger; unlike search_vouchers it is never fuzzy narration matching across the whole chart of accounts, so it never silently blends an unrelated account in.",
    parameters: {
      type: "object",
      properties: {
        accountNames: { type: "array", items: { type: "string" }, description: "Two or more real account names (or exact substrings) that together make up the category, e.g. [\"Vehicle Maintenance\", \"Travelling Expenses\", \"House Hold Exps\"]." },
        terms: { type: "array", items: { type: "string" }, description: "Optional: only include vouchers in those accounts whose narration also contains one of these words (e.g. [\"gas\",\"gasoline\"]). Omit to include every voucher in the listed accounts." },
        period: PERIOD_PARAM,
      },
      required: ["accountNames", "period"],
    },
  },
  {
    name: "get_salary_summary",
    description:
      "Get gross pay, tax deducted, 401k, medical, telephone, and net take-home (the real bank deposit) totals across every salary/paystub voucher in one time period. Use this for any salary, paycheck, take-home, or tax-withheld question.",
    parameters: {
      type: "object",
      properties: { period: PERIOD_PARAM },
      required: ["period"],
    },
  },
  {
    name: "get_account_balances",
    description:
      "Get current account balances -- CUMULATIVE since each account was opened, not scoped to any period and NOT a year-to-date figure. Optionally filter by a name substring. Use this for 'what's my balance in X' or 'how much is in my bank/investment accounts' questions.",
    parameters: {
      type: "object",
      properties: { nameFilter: { type: "string", description: "Optional substring to filter account names by (e.g. 'bank', 'NVDA')." } },
      required: [],
    },
  },
  {
    name: "get_fbar_status",
    description: "Get the FBAR (FinCEN Form 114) foreign-account filing status for a calendar year (India book only).",
    parameters: {
      type: "object",
      properties: { year: { type: "number", description: "Calendar year, e.g. 2026. Defaults to the current year if omitted." } },
      required: [],
    },
  },
  {
    name: "get_equity_position",
    description:
      "Get the live market value of held RSU/ESPP stock (at today's live price), total shares (held + scheduled/pending), and today's gain/loss vs yesterday's close on held shares -- matches the app's own 'Equity' dashboard card exactly. Use this for 'what's my stock/equity worth', 'how many shares do I have', or 'what's my gain/loss today' questions about employer equity. This is the LIVE, UNREALIZED value of shares still held -- for gains from actual past SALES, use get_trading_gains instead.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_net_worth",
    description:
      "Get overall net worth (assets minus real liabilities), as of the most recent fiscal-year-end on file, including live RSU/ESPP market value on top of the ledger's book value when a live price is available. Use this for 'what's my net worth' questions. Does NOT include a live 401(k)/retirement brokerage balance (only its book value) -- say so if asked specifically about that.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_trading_gains",
    description:
      "Get REALIZED capital gains/losses (short-term and long-term, already netted per tax rules) from actual stock SALES this calendar year -- RSU sales, ESPP sales, and other brokerage trades. This is NOT the live value of shares still held (use get_equity_position for that). Use this for 'how much did I gain/lose from selling stock' or realized-gains/tax-related trading questions.",
    parameters: {
      type: "object",
      properties: { year: { type: "string", description: "Calendar year as a 4-digit string, e.g. \"2026\". Defaults to the current calendar year if omitted." } },
      required: [],
    },
  },
  {
    name: "get_financial_ratios",
    description:
      "Get the most recent fiscal year's financial health ratios: savings rate, liquid assets, total debt, emergency fund (months of expenses covered), debt-to-income, and net worth growth vs the prior year. Use this for 'how am I doing financially', 'what's my savings rate', 'how many months of emergency fund do I have' questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_cash_flow_forecast",
    description:
      "Get a projected month-by-month cash flow forecast starting from today: paycheck, passive income, living expenses, recurring items, loan payments, and the running projected cash balance. Use this for 'what's my cash flow going forward', 'will I have enough cash in N months' questions.",
    parameters: {
      type: "object",
      properties: { months: { type: "number", description: "How many months ahead to project, 1-24. Defaults to 6 if omitted." } },
      required: [],
    },
  },
  {
    name: "get_budget_vs_actual",
    description:
      "Compare budgeted vs actual expense spending for a fiscal year, with the top over-budget categories. Use this for 'am I on budget', 'where am I overspending' questions.",
    parameters: {
      type: "object",
      properties: { fy: { type: "string", description: "Fiscal year as a 4-digit string (Apr-start), e.g. \"2026\" for FY2026 (Apr 2026 - Mar 2027). Defaults to the current fiscal year if omitted." } },
      required: [],
    },
  },
  {
    name: "get_multi_year_trend",
    description:
      "Get income, expense, surplus, and net worth for every fiscal year on file, oldest to latest, with year-over-year growth. Use this for 'how has my income/spending/net worth trended over the years' questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_401k_summary",
    description:
      "Get lifetime and by-year 401(k) contribution totals: your own contributions and the employer match, separately. Use this for '401k contribution' questions. This is BOOK value from payroll records, not a live brokerage balance.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_fixed_assets",
    description:
      "Get every fixed asset (vehicle, furniture, equipment, etc, excluding disposed ones) with its cost and current straight-line-depreciated book value. Use this for 'what fixed assets do I have', 'what's my asset book value' questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_loans",
    description:
      "Get every open loan (excluding closed ones) with its current balance owed, interest rate, and standard payment. Use this for 'what do I owe on my loans', 'what's my loan balance' questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_prepaid_expenses",
    description:
      "Get every prepaid expense (insurance paid upfront, annual subscriptions, etc, excluding written-off ones) with its original amount and remaining unamortized balance. Use this for 'what prepaid expenses do I have', 'what's left on my prepaid insurance' questions.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_us_tax_estimate",
    description:
      "Get an ESTIMATED US federal + state income tax liability for a year (AGI, deduction used, estimated federal/state tax, withheld, refund or balance due) -- the same estimate this app's own Tax Report computes. Use this for 'what will I owe in taxes', 'am I getting a refund' questions (US book only). This is an estimate for planning, not a filed return.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "string", description: "4-digit year, e.g. \"2025\". Defaults to the current year if omitted." },
        filingStatus: { type: "string", enum: ["mfj", "single"], description: "Tax filing status -- only \"mfj\" (married filing jointly) and \"single\" are modeled by this app. Defaults to \"mfj\" if omitted, matching this app's own default." },
      },
      required: [],
    },
  },
  {
    name: "get_india_tax_estimate",
    description:
      "Get India income tax for a financial year: the REAL filed figure if an ITR is on record for that year, otherwise an ESTIMATE (ordinary slab rates only, no capital-gains special rates). Use this for 'what will I owe in India tax', 'what's my refund' questions (India book only).",
    parameters: {
      type: "object",
      properties: { fy: { type: "string", description: "Financial year in \"YYYY-YY\" format (Apr-start), e.g. \"2025-26\". Defaults to the current financial year if omitted." } },
      required: [],
    },
  },
  {
    name: "navigate_to_screen",
    description:
      "Switch the app's UI to a specific screen/report/tab the user explicitly asked to go to, open, or see (e.g. 'take me to the FBAR report', 'open ledgers', 'show budget vs actual', 'go to masters'). This is an ACTION, not a data lookup -- it does not return any figures. Only use this when the user is asking to NAVIGATE somewhere, never for a question about their data (use the other tools for that).",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "A short phrase naming the screen/report to go to, in the user's own words (e.g. \"FBAR report\", \"ledgers\", \"budget vs actual\", \"dashboard\", \"tax report\")." },
      },
      required: ["destination"],
    },
  },
];

// Executes one tool call against the decrypted Ledger already in memory client-side -- the server
// route (app/api/assistant) only ever sees the model's chosen tool NAME and ARGUMENTS, never the
// vault's actual data, same vault-blind posture the whole feature has always had.
// Coerces a tool call's `arguments` into a plain object regardless of how the model actually sent
// it -- Workers AI's own function-calling docs show it as an already-parsed object, but this is
// cheap insurance against a JSON-string encoding (common in other providers' function-calling
// APIs) or any other malformed shape, rather than letting property access on the wrong type
// silently drop every argument the model intended to pass.
export function coerceToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not valid JSON -- fall through to the empty-object default below
    }
  }
  return {};
}

// livePrice/prevClose (optional) are the already-fetched NVDA quote ChatAssistant.tsx holds in
// state for the dashboard's own Equity card -- threaded through here rather than fetched inside
// this function, since a pure lib module has no network access and shouldn't gain one just for
// this; the client already has the data, this just reuses it.
export function executeTool(
  name: string,
  args: Record<string, unknown>,
  data: Ledger,
  book: "us" | "india",
  todayIso: string,
  livePrice?: number | null,
  prevClose?: number | null
): string {
  switch (name) {
    case "search_vouchers":
      return searchVouchers(data, args, todayIso);
    case "get_account_ledger":
      return getAccountLedger(data, args, todayIso);
    case "search_accounts":
      return searchAccounts(data, args, todayIso);
    case "get_salary_summary":
      return getSalarySummary(data, args, todayIso);
    case "get_account_balances":
      return getAccountBalances(data, args, todayIso);
    case "get_fbar_status":
      return book === "india"
        ? getFbarStatus(data, args, todayIso)
        : `get_fbar_status: FINAL RESULT (do not call this or any other tool again for this request) -- FBAR/FinCEN Form 114 only applies to India Books; the book currently open is US Books. Tell the user they need to switch to India Books (book switcher, top-left of the screen) to check this.`;
    case "get_equity_position":
      return getEquityPosition(data, livePrice ?? null, prevClose ?? null, todayIso);
    case "get_net_worth":
      return getNetWorth(data, livePrice ?? null, todayIso);
    case "get_trading_gains":
      return getTradingGains(data, args, todayIso);
    case "get_financial_ratios":
      return getFinancialRatios(data);
    case "get_cash_flow_forecast":
      return getCashFlowForecast(data, args);
    case "get_budget_vs_actual":
      return getBudgetVsActual(data, args, todayIso);
    case "get_multi_year_trend":
      return getMultiYearTrend(data);
    case "get_401k_summary":
      return get401kSummary(data);
    case "get_fixed_assets":
      return getFixedAssets(data, todayIso);
    case "get_loans":
      return getLoans(data, todayIso);
    case "get_prepaid_expenses":
      return getPrepaidExpenses(data, todayIso);
    // Confirmed live: "use get_india_tax_estimate instead" (the old wording) actively misled the
    // model into calling the OTHER country's tax tool as if it were a valid substitute for a
    // question that explicitly said "US" -- producing a completely different country's figures
    // for a question that never asked for them, then floundering through more tool calls when
    // that still didn't look like an answer. These are now explicit, final, book-switch-only
    // answers -- the two tax tools are never interchangeable, no matter which one is "available".
    case "get_us_tax_estimate":
      return book === "india"
        ? `get_us_tax_estimate: FINAL RESULT (do not call this or any other tool again for this request) -- US tax figures are only available in US Books; the book currently open is India Books. Tell the user they need to switch to US Books (book switcher, top-left of the screen) to see this -- NEVER substitute get_india_tax_estimate's figures here, that answers a different country's tax entirely.`
        : getUsTaxEstimate(data, args, todayIso);
    case "get_india_tax_estimate":
      return book === "us"
        ? `get_india_tax_estimate: FINAL RESULT (do not call this or any other tool again for this request) -- India tax figures are only available in India Books; the book currently open is US Books. Tell the user they need to switch to India Books (book switcher, top-left of the screen) to see this -- NEVER substitute get_us_tax_estimate's figures here, that answers a different country's tax entirely.`
        : getIndiaTaxEstimate(data, args, todayIso);
    default:
      return `Unknown tool: "${name}". Valid tools are: ${TOOL_DEFS.map((t) => t.name).join(", ")}.`;
  }
}
