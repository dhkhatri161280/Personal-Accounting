import type { Ledger } from "./vault-types.ts";
import { ledgerBalanceAsOf, displayLedgerBalance, accountNature } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { todayLocalIso } from "./format-date.ts";

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

  let monthIncome = 0,
    monthExpense = 0;
  for (const t of monthTx) {
    for (const e of t.entries) {
      const acct = data.accounts.find((a) => a.id === e.accountId);
      if (!acct) continue;
      const nature = accountNature(acct, masterGroups);
      if (nature === "Income") monthIncome += -e.amount;
      else if (nature === "Expense") monthExpense += e.amount;
    }
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
        : `All vouchers this month (${monthTxForContext.length}):`
    );
    for (const t of monthTxForContext) {
      const amt = t.entries.reduce((s, e) => s + Math.abs(e.amount), 0) / 2;
      lines.push(`- ${t.date} ${t.type} #${t.number}: ${t.narration} (${amt.toFixed(2)} ${data.currency})`);
    }
  } else {
    lines.push("", "No vouchers posted yet this month.");
  }

  return lines.join("\n");
}
