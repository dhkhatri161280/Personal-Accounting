import type { Ledger, Tx } from "./vault-types.ts";
import { ledgerBalanceAsOf, accountNature, fiscalYearOf } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { fmtDate } from "./format-date.ts";
import { isSalaryVoucher, buildShadowPeriod } from "./payroll-match.ts";

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

export function executeTool(name: string, args: Record<string, unknown>, data: Ledger, book: "us" | "india", todayIso: string): string {
  switch (name) {
    case "search_vouchers":
      return searchVouchers(data, args, todayIso);
    case "get_account_ledger":
      return getAccountLedger(data, args, todayIso);
    case "get_salary_summary":
      return getSalarySummary(data, args, todayIso);
    case "get_account_balances":
      return getAccountBalances(data, args, todayIso);
    case "get_fbar_status":
      return book === "india" ? getFbarStatus(data, args, todayIso) : "get_fbar_status is only available for the India book.";
    default:
      return `Unknown tool: "${name}". Valid tools are: ${TOOL_DEFS.map((t) => t.name).join(", ")}.`;
  }
}
