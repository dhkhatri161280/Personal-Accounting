import type { Ledger } from "./vault-types.ts";
import { ledgerBalanceAsOf, displayLedgerBalance, accountNature } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { todayLocalIso, fmtDate } from "./format-date.ts";
import { isSalaryVoucher, buildShadowPeriod } from "./payroll-match.ts";

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

  lines.push("", "Current account balances (non-zero only):");
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

  // Per-voucher classification used for BOTH the month total below and the per-voucher list
  // further down, so the two can never drift out of sync with each other again. Confirmed live
  // (user's own Day Book data) that deriving spend-vs-refund from each entry's raw signed amount
  // against its account's nature got it backwards. The voucher's own `type` field is the correct,
  // simple signal -- exactly the convention lib/costco-reward.ts already uses and has proven
  // correct: a "Payment" voucher is money going out (a purchase), a "Receipt" voucher against an
  // expense account is money coming back (a refund/return).
  //
  // Confirmed live a SECOND time: a semi-monthly paystub voucher (one Income-nature entry for
  // gross pay, plus several Expense-nature entries for withheld tax/benefits deductions in the
  // same voucher) got mislabeled "REFUND/return" too -- picking "Expense" as the voucher's nature
  // just because ANY entry touched an Expense account, even though the same voucher also had a
  // real Income entry. The refund rule only makes sense for a voucher that's PURELY on the expense
  // side (like a Costco return, which never touches an Income account at all) -- so an Income
  // entry anywhere in the voucher now wins and rules out the refund interpretation entirely.
  function classify(t: { type: string; entries: { accountId: number; amount: number }[] }): { amt: number; nature: "Expense" | "Income" | null; isRefund: boolean } {
    const magnitude = t.entries.reduce((s, e) => s + Math.abs(e.amount), 0) / 2;
    let nature: "Expense" | "Income" | null = null;
    for (const e of t.entries) {
      const acct = data.accounts.find((a) => a.id === e.accountId);
      if (!acct) continue;
      const n = accountNature(acct, masterGroups);
      if (n === "Income") nature = "Income";
      else if (n === "Expense" && nature !== "Income") nature = "Expense";
    }
    const isReceipt = t.type.toLowerCase() === "receipt";
    const isRefund = nature === "Expense" && isReceipt;
    const amt = nature === "Expense" ? (isReceipt ? -magnitude : magnitude) : magnitude;
    return { amt, nature, isRefund };
  }

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
        ? `All vouchers this month (${monthTx.length} total, showing the most recent ${MAX_MONTH_VOUCHERS} -- some earlier-in-month vouchers are NOT included below):`
        : `All vouchers this month (${monthTxForContext.length}). A negative amount or "REFUND" note means money came back -- SUBTRACT it from any spending total, don't add its size:`
    );
    for (const t of monthTxForContext) {
      // Confirmed live: a "take-home / tax deducted" question couldn't be answered because a
      // salary voucher was only ever shown as ONE summed amount -- the gross pay, tax withheld,
      // 401k/medical/telephone deductions, and net deposit live as separate entries inside the
      // same voucher, collapsed away by the magnitude-only line below. isSalaryVoucher/
      // buildShadowPeriod (lib/payroll-match.ts) already parse those entries by account name
      // (e.g. "Salary Income", "Tax Deduction", "401k") for the payroll-reconciliation feature --
      // reused here instead of re-deriving the same breakdown a second, possibly-inconsistent way.
      if (isSalaryVoucher(t)) {
        const sp = buildShadowPeriod(t);
        // Confirmed live a THIRD time: buildShadowPeriod's `net` is DERIVED (gross + telephone -
        // medical - 401k - tax), which silently drifts from reality the moment the voucher has any
        // deduction line that regex doesn't recognize. "Take-home" must be the literal amount that
        // landed in the bank, so read it straight off the voucher's own Bank/Cash-nature entry
        // instead of trusting the subtraction -- falling back to the derived figure only if the
        // voucher has no such entry to read (e.g. net pay rolled into a non-bank account).
        const bankAmt = t.entries.reduce((s, e) => {
          const acct = data.accounts.find((a) => a.id === e.accountId);
          if (!acct) return s;
          const n = accountNature(acct, masterGroups);
          return n === "Bank" || n === "Cash" ? s + Math.abs(e.amount) : s;
        }, 0);
        const net = bankAmt > 0 ? bankAmt : sp.net;
        lines.push(
          `- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} -- gross pay ${sp.base.toFixed(2)}, tax deducted ${sp.tax.toFixed(2)}, 401k ${sp.k401.toFixed(2)}, medical/health ${sp.medical.toFixed(2)}, telephone ${sp.telephone.toFixed(2)}, net take-home (actual bank deposit) ${net.toFixed(2)} ${data.currency}`
        );
        continue;
      }
      // Confirmed live: showing the plain absolute amount for every voucher made a refund (a
      // "Receipt" against a prior expense, e.g. a Costco return) look identical to a normal
      // purchase, so a spending total the model computed over the list silently added it instead
      // of subtracting it. Reuses the same classify() the month total above uses, so the two can
      // never disagree with each other.
      const { amt, isRefund } = classify(t);
      const refundNote = isRefund ? " -- REFUND/return" : "";
      lines.push(`- ${fmtDate(t.date)} ${t.type} #${t.number}: ${t.narration} (${amt.toFixed(2)} ${data.currency}${refundNote})`);
    }
  } else {
    lines.push("", "No vouchers posted yet this month.");
  }

  return lines.join("\n");
}
