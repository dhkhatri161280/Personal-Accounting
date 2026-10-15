import type { Ledger, Tx } from "./vault-types.ts";
import { ledgerBalanceAsOf, displayLedgerBalance, accountNature, fiscalYearOf } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { todayLocalIso, fmtDate } from "./format-date.ts";
import { isSalaryVoucher, buildShadowPeriod } from "./payroll-match.ts";

// Classifies one voucher's signed amount, nature, refund status, and the real account name(s) it
// posted to -- shared by buildAssistantContext's month total/per-voucher list AND
// searchVouchersThisFiscalYear below, so the two can never drift out of sync with each other.
// Confirmed live (user's own Day Book data) that deriving spend-vs-refund from each entry's raw
// signed amount against its account's nature got it backwards. The voucher's own `type` field is
// the correct, simple signal -- exactly the convention lib/costco-reward.ts already uses and has
// proven correct: a "Payment" voucher is money going out (a purchase), a "Receipt" voucher against
// an expense account is money coming back (a refund/return).
//
// Confirmed live a SECOND time: a semi-monthly paystub voucher (one Income-nature entry for gross
// pay, plus several Expense-nature entries for withheld tax/benefits deductions in the same
// voucher) got mislabeled "REFUND/return" too -- picking "Expense" as the voucher's nature just
// because ANY entry touched an Expense account, even though the same voucher also had a real
// Income entry. The refund rule only makes sense for a voucher that's PURELY on the expense side
// (like a Costco return, which never touches an Income account at all) -- so an Income entry
// anywhere in the voucher now wins and rules out the refund interpretation entirely.
//
// Confirmed live a THIRD time: asked to "check the Vehicle Maintenance account" for a Costco
// match, the assistant flatly contradicted its own prior answer -- it had NO way to actually check
// account membership, since the per-voucher line only ever showed narration text, never which
// account(s) the voucher posted to. Also returns the account name(s) touched, so an
// account-specific question has real data to check against instead of the model having to guess.
function classifyVoucher(
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

const STOPWORD_LEN_FLOOR = 3;
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= STOPWORD_LEN_FLOOR);
}

// Confirmed live: filtering search terms by "does this word appear anywhere in the vault's own
// vocabulary" was NOT enough on its own -- common question words like "for", "this", "year" very
// often also appear as genuine whole words inside real narrations once a vault has years of
// history (e.g. any "... for groceries" narration contains "for"), so they survived the filter
// and got treated as real search terms, massively over-matching (2219 vouchers for one query). A
// real stopword list comes first and is authoritative -- vocabulary membership alone was never a
// safe substitute for it.
const QUESTION_STOPWORDS = new Set([
  "how", "much", "many", "what", "which", "who", "when", "where", "why", "is", "are", "was", "were",
  "the", "a", "an", "my", "our", "your", "this", "that", "these", "those", "for", "of", "in", "on",
  "at", "to", "from", "till", "until", "today", "now", "please", "can", "you", "tell", "me", "and",
  "or", "with", "check", "give", "show", "see", "find", "there", "here", "it", "its", "vs", "compare",
  "than", "have", "has", "had", "do", "does", "did", "total", "spend", "spent", "spending", "amount",
  "account", "accounts", "fiscal", "year", "years", "month", "months", "quarter", "quarters", "so",
  "far", "all", "any", "not", "about", "info", "information", "data",
]);

// Confirmed live: asked "this fiscal year" questions, the assistant could only ever honestly say
// "I only have this month's data" -- accurate, but useless for what the user actually asked. The
// real fix isn't dumping every voucher ever posted into the context (hundreds of vouchers would
// blow both the char budget and the free model's practical context window) -- it's a real SEARCH,
// scoped to just the terms the user's own question named. A word only counts as a search term if
// it's NOT a generic question word (QUESTION_STOPWORDS above) AND it actually appears somewhere in
// THIS vault's own vocabulary (an account name or a voucher narration) -- "Costco"/"Gasoline"/
// "Vehicle"/"Maintenance" pass both checks for a vault that has them.
export function extractSearchTerms(message: string, data: Ledger): string[] {
  const vocab = new Set<string>();
  for (const a of data.accounts) for (const w of wordsOf(a.name)) vocab.add(w);
  for (const t of data.transactions) {
    if (t.deleted) continue;
    for (const w of wordsOf(t.narration || "")) vocab.add(w);
  }
  const terms = new Set<string>();
  for (const w of wordsOf(message)) if (!QUESTION_STOPWORDS.has(w) && vocab.has(w)) terms.add(w);
  return [...terms];
}

const MAX_SEARCH_RESULTS = 100;

// Searches the CURRENT FISCAL YEAR's non-deleted/cancelled vouchers (same Apr-Mar FY the rest of
// this app uses -- see fiscalYearOf) for one whose narration OR whose touched account name
// contains any of `terms` -- the real answer to "how much X this fiscal year", computed and listed
// directly rather than asking the model to re-derive it from a giant dump of unrelated vouchers.
// Confirmed live this needs an explicit boundary: with none at all, a "this fiscal year" question
// searched the vault's ENTIRE history back to 2016, returning 2219 matches and a confused, overrun
// partial answer, not "this fiscal year"'s actual (much smaller) total. Returns "" when there are
// no terms to search for (buildAssistantContext's own month-scoped list already covers that case)
// or when nothing matches within the FY (the caller still gets an explicit "zero matches" line, so
// the model says so plainly instead of inventing a connection to something unrelated).
export function searchVouchersThisFiscalYear(data: Ledger, terms: string[], todayIso: string): string {
  if (!terms.length) return "";
  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g as unknown as { nature: string }]));
  const quoted = terms.map((t) => `"${t}"`).join(", ");
  const fy = fiscalYearOf(todayIso);
  const fromDate = `${fy}-04-01`,
    toDate = `${fy + 1}-03-31`;
  const fyLabel = `FY${fy} (${fromDate} to ${toDate})`;

  const matches = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.date >= fromDate && t.date <= toDate)
    .filter((t) => {
      const narration = t.narration.toLowerCase();
      if (terms.some((term) => narration.includes(term))) return true;
      return t.entries.some((e) => {
        const acct = data.accounts.find((a) => a.id === e.accountId);
        return acct && terms.some((term) => acct.name.toLowerCase().includes(term));
      });
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (!matches.length) {
    return `Fiscal-year search (${fyLabel}, not just this month) for ${quoted}: 0 matching vouchers found.`;
  }

  // Confirmed live: even with the correct voucher set in front of it, the free model re-derived
  // its OWN total by reading and adding up a subset of the listed lines -- and silently dropped 3
  // of 6 real matches doing it, understating a real total ($365.05) as $171.02. The fix isn't a
  // better instruction to "please add these up correctly" -- it's to never ask the model to do the
  // arithmetic at all. The total below is computed here, once, over EVERY real match (not just the
  // ones shown if the list is truncated), stated as its own authoritative line before the voucher
  // list even starts, with an explicit instruction (see the system prompt) to quote that number
  // verbatim rather than recompute it.
  let total = 0;
  for (const t of matches) total += classifyVoucher(data, masterGroups, t).amt;

  const truncated = matches.length > MAX_SEARCH_RESULTS;
  const forContext = truncated ? matches.slice(0, MAX_SEARCH_RESULTS) : matches;
  const lines: string[] = [
    `Fiscal-year search (${fyLabel}, not just this month) for ${quoted}: ${matches.length} matching voucher(s).`,
    `PRECOMPUTED TOTAL (authoritative, refunds already subtracted -- quote this exact number, do NOT add up the voucher lines yourself): ${total.toFixed(2)} ${data.currency}`,
    "",
    truncated
      ? `Voucher list (showing the first ${MAX_SEARCH_RESULTS} of ${matches.length} -- some are not shown, but the total above already covers all ${matches.length}):`
      : "Voucher list (every matching voucher, for citing examples only -- the total above is already correct, don't recompute it from this list):",
  ];
  for (const t of forContext) {
    const { amt, isRefund, acctNames } = classifyVoucher(data, masterGroups, t);
    const refundNote = isRefund ? " -- REFUND/return" : "";
    lines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} [accounts: ${acctNames}] (${amt.toFixed(2)} ${data.currency}${refundNote})`);
  }
  return lines.join("\n");
}

// Builds the plain-text "financial data snapshot" sent to the free chat assistant (see
// app/api/assistant) alongside each question -- the ONLY thing the server-side model ever sees
// about the user's actual data, computed here client-side where the decrypted Ledger already
// lives. A bounded SUMMARY, not a full data dump -- Workers AI's free-tier models have a much
// smaller practical context budget than Claude.
//
// Confirmed live this needs to be more than just "a list and let the model search it": asked
// "Costco spending this month", it missed a real Costco voucher entirely (truncated out of a
// plain most-recent-15 window that wasn't scoped to the month); asked about Costco gasoline, it
// INVENTED a connection to an unrelated "C-STORE TRANS" voucher with no description, rather than
// saying it couldn't find one. Two fixes for that: (1) give it the WHOLE current month, not an
// arbitrary recent-N cut that can silently drop earlier-in-month vouchers, and (2) a free-text
// merchant search the model doesn't have to reinvent, with an explicit instruction not to guess
// when nothing actually matches.
export function buildAssistantContext(data: Ledger, book: "us" | "india"): string {
  const today = todayLocalIso();
  const lines: string[] = [`Book: ${book === "india" ? "India" : "US"} | Base currency: ${data.currency} | Today: ${today}`];

  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g as unknown as { nature: string }]));
  const activeAccounts = data.accounts.filter((a) => a.active !== false);

  lines.push("", "Current account balances (non-zero only -- CUMULATIVE since the account was opened, NOT year-to-date):");
  for (const a of activeAccounts) {
    const bal = displayLedgerBalance(a, ledgerBalanceAsOf(data, a.id, today));
    if (Math.abs(bal) < 0.01) continue;
    lines.push(`- ${a.name} [${a.parent}]: ${bal.toFixed(2)} ${a.currency || data.currency}`);
  }

  const monthKey = today.slice(0, 7);
  const monthTx = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.date.startsWith(monthKey))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const classify = (t: { type: string; entries: { accountId: number; amount: number }[] }) => classifyVoucher(data, masterGroups, t);

  let monthIncome = 0,
    monthExpense = 0;
  for (const t of monthTx) {
    const { amt, nature } = classify(t);
    if (nature === "Income") monthIncome += amt;
    else if (nature === "Expense") monthExpense += amt;
  }
  lines.push(
    "",
    `This month (${monthKey}) so far: income ${monthIncome.toFixed(2)}, expense ${monthExpense.toFixed(2)}, net ${(monthIncome - monthExpense).toFixed(2)} ${data.currency}`
  );

  // Same breakdown used for BOTH the per-voucher salary lines below and the year-to-date summary
  // just below that, so the two can't disagree. "Take-home" reads the voucher's own Bank/Cash-
  // nature entry directly (see the comment at its call site) rather than deriving it by
  // subtraction, which silently drifts from reality on any deduction line the parser doesn't
  // recognize.
  function salaryBreakdown(t: Tx) {
    const sp = buildShadowPeriod(t);
    const bankAmt = t.entries.reduce((s, e) => {
      const acct = data.accounts.find((a) => a.id === e.accountId);
      if (!acct) return s;
      const n = accountNature(acct, masterGroups);
      return n === "Bank" || n === "Cash" ? s + Math.abs(e.amount) : s;
    }, 0);
    return { gross: sp.base, tax: sp.tax, k401: sp.k401, medical: sp.medical, telephone: sp.telephone, net: bankAmt > 0 ? bankAmt : sp.net };
  }

  // Confirmed live: asked "how much YTD" right after a correct per-paystub answer, the assistant
  // had no year-to-date figure anywhere in its context and fabricated one from the "Current
  // account balances" section instead -- those are CUMULATIVE since the account was opened, not
  // year-to-date, and presenting them as a YTD estimate was a confident wrong answer. Give it the
  // real thing: every salary voucher dated this calendar year, summed the same way as the
  // per-voucher lines below.
  const yearKey = today.slice(0, 4);
  const yearSalaryTx = data.transactions.filter((t) => !t.deleted && !t.cancelled && t.date.startsWith(yearKey) && isSalaryVoucher(t));
  if (yearSalaryTx.length) {
    const ytd = yearSalaryTx.reduce(
      (acc, t) => {
        const b = salaryBreakdown(t);
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
    lines.push(
      "",
      `Year-to-date (CY${yearKey}) salary summary across ${yearSalaryTx.length} paystub voucher(s): gross pay ${ytd.gross.toFixed(2)}, tax deducted ${ytd.tax.toFixed(2)}, 401k ${ytd.k401.toFixed(2)}, medical/health ${ytd.medical.toFixed(2)}, telephone ${ytd.telephone.toFixed(2)}, net take-home (actual bank deposits) ${ytd.net.toFixed(2)} ${data.currency}`
    );
  }

  if (book === "india") {
    const year = new Date(today).getFullYear();
    const fbar = computeFbarSummary(data, year);
    lines.push(
      "",
      `FBAR (FinCEN Form 114) CY${year}: combined peak value ${fbar.rate ? `$${fbar.totalUsd.toFixed(2)}` : "unknown (no Treasury rate on file for this year)"}, threshold $10,000 -- ${
        fbar.rate ? (fbar.thresholdExceeded ? "filing IS required" : "filing is NOT required") : "cannot determine yet"
      }.`
    );
  }

  // Every voucher THIS CALENDAR MONTH, not an arbitrary most-recent-N -- a merchant/category
  // question ("how much at Costco", "what did I spend on groceries") needs the complete month to
  // answer correctly, and a recent-N cut silently drops whatever's earlier in the month once
  // voucher volume exceeds N. Capped only as a hard safety ceiling for an extreme-volume month,
  // with the model told explicitly when that ceiling was hit so it doesn't treat a partial list
  // as complete.
  const MAX_MONTH_VOUCHERS = 150;
  const truncated = monthTx.length > MAX_MONTH_VOUCHERS;
  const monthTxForContext = truncated ? monthTx.slice(-MAX_MONTH_VOUCHERS) : monthTx;
  if (monthTxForContext.length) {
    lines.push(
      "",
      truncated
        ? `All vouchers THIS CALENDAR MONTH ONLY (${monthKey}) -- nothing from any earlier or later month is included below (${monthTx.length} total, showing the most recent ${MAX_MONTH_VOUCHERS} -- some earlier-in-month vouchers are NOT included below):`
        : `All vouchers THIS CALENDAR MONTH ONLY (${monthKey}) -- nothing from any earlier or later month is included below (${monthTxForContext.length} voucher(s)). A negative amount or "REFUND" note means money came back -- SUBTRACT it from any spending total, don't add its size:`
    );
    for (const t of monthTxForContext) {
      // Confirmed live: a "take-home / tax deducted" question couldn't be answered because a
      // salary voucher was only ever shown as ONE summed amount -- the gross pay, tax withheld,
      // 401k/medical/telephone deductions, and net deposit live as separate entries inside the
      // same voucher, collapsed away by the magnitude-only line below. Reuses salaryBreakdown()
      // above, which is also what feeds the year-to-date summary, so the two can't disagree.
      if (isSalaryVoucher(t)) {
        const b = salaryBreakdown(t);
        lines.push(
          `- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} -- gross pay ${b.gross.toFixed(2)}, tax deducted ${b.tax.toFixed(2)}, 401k ${b.k401.toFixed(2)}, medical/health ${b.medical.toFixed(2)}, telephone ${b.telephone.toFixed(2)}, net take-home (actual bank deposit) ${b.net.toFixed(2)} ${data.currency}`
        );
        continue;
      }
      // Confirmed live: showing the plain absolute amount for every voucher made a refund (a
      // "Receipt" against a prior expense, e.g. a Costco return) look identical to a normal
      // purchase, so a spending total the model computed over the list silently added it instead
      // of subtracting it. Reuses the same classify() the month total above uses, so the two can
      // never disagree with each other.
      const { amt, isRefund, acctNames } = classify(t);
      const refundNote = isRefund ? " -- REFUND/return" : "";
      lines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} [accounts: ${acctNames}] (${amt.toFixed(2)} ${data.currency}${refundNote})`);
    }
  } else {
    lines.push("", "No vouchers posted yet this month.");
  }

  return lines.join("\n");
}
