import type { Ledger } from "./vault-types.ts";
import { ledgerBalanceAsOf, displayLedgerBalance, accountNature } from "./vault-accounting.ts";
import { computeFbarSummary } from "./fbar.ts";
import { todayLocalIso } from "./format-date.ts";

// Builds the plain-text "financial data snapshot" sent to the free chat assistant (see
// app/api/assistant) alongside each question -- the ONLY thing the server-side model ever sees
// about the user's actual data, computed here client-side where the decrypted Ledger already
// lives. Deliberately a bounded SUMMARY (balances + this month's totals + this year's FBAR
// status), not a full data dump -- Workers AI's free-tier models have a much smaller practical
// context budget than Claude, and most personal questions ("what's my balance", "am I over
// threshold", "what did I spend this month") don't need every historical transaction to answer.
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

  // This calendar month's net income/expense flow -- same Income/Expense nature classification
  // every other report in this app uses, kept to a single total per side rather than the full
  // per-category breakdown (SpendReport's own job) to stay compact.
  const monthKey = today.slice(0, 7);
  let monthIncome = 0,
    monthExpense = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled || !t.date.startsWith(monthKey)) continue;
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

  const recent = data.transactions
    .filter((t) => !t.deleted && !t.cancelled)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 15);
  if (recent.length) {
    lines.push("", "Most recent vouchers:");
    for (const t of recent) {
      const amt = t.entries.reduce((s, e) => s + Math.abs(e.amount), 0) / 2;
      lines.push(`- ${t.date} ${t.type} #${t.number}: ${t.narration} (${amt.toFixed(2)} ${data.currency})`);
    }
  }

  return lines.join("\n");
}
