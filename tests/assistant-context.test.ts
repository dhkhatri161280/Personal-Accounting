import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantContext } from "../lib/assistant-context.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string, openingBalance = 0): Account {
  return { id, name, parent, category: "Asset", currency: "INR", openingBalance, active: true };
}

function tx(id: number, date: string, accountId: number, amount: number, narration = "test"): Tx {
  return {
    id,
    guid: `v${id}`,
    date,
    number: String(id),
    type: amount < 0 ? "Payment" : "Receipt",
    narration,
    historical: false,
    entries: [
      { accountId, accountName: "", amount },
      { accountId: 999, accountName: "Other", amount: -amount },
    ],
  };
}

test("buildAssistantContext: includes non-zero balances and omits zero ones", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", -500_000), account(2, "Zero Balance Acct", "Bank Accounts", 0), account(999, "Other", "Indirect Incomes")];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions: [] };
  const context = buildAssistantContext(data, "india");
  assert.ok(context.includes("SBI Savings"));
  assert.ok(!context.includes("Zero Balance Acct"));
});

test("buildAssistantContext: sums this month's income/expense from current transactions", () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [
    account(1, "Salary Income", "Direct Incomes"),
    account(2, "Groceries", "Indirect Expenses"),
    account(999, "Bank", "Bank Accounts"),
  ];
  const transactions = [
    tx(1, `${monthKey}-02`, 1, -100_000), // income
    tx(2, `${monthKey}-05`, 2, 5_000), // expense
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes(`This month (${monthKey})`));
  assert.ok(context.includes("income 100000.00"));
  assert.ok(context.includes("expense 5000.00"));
});

test("buildAssistantContext: includes FBAR status only for the India book", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts: [], transactions: [] };
  const indiaContext = buildAssistantContext(data, "india");
  const usContext = buildAssistantContext(data, "us");
  assert.ok(indiaContext.includes("FBAR"));
  assert.ok(!usContext.includes("FBAR"));
});

test("buildAssistantContext: includes the WHOLE current month in chronological order, not just the most-recent few", () => {
  // Confirmed live: a real question ("Costco spending this month") got a wrong answer because an
  // earlier fix only sent the most-recent-15-overall vouchers, silently dropping an
  // earlier-in-month voucher once monthly volume exceeded that. This locks in the fix: every
  // voucher dated this month is present, oldest first (how a real ledger reads), and nothing
  // outside this month leaks in just because it's "recent" in absolute terms.
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    ...Array.from({ length: 20 }, (_, i) => tx(i + 1, `${monthKey}-01`, 1, -(i + 1), `Filler voucher ${i + 1}`)),
    tx(100, `${monthKey}-02`, 1, -999, "Early-in-month Costco voucher"),
    tx(101, "2020-01-01", 1, -1, "Long-ago voucher outside this month"),
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("Early-in-month Costco voucher"), "an earlier-in-month voucher must not be dropped just because other vouchers are more recent");
  assert.ok(!context.includes("Long-ago voucher outside this month"));
  // Chronological (oldest first) within the month, not most-recent-first
  const firstFillerIdx = context.indexOf("Filler voucher 1 ");
  const earlyCostcoIdx = context.indexOf("Early-in-month Costco voucher");
  assert.ok(firstFillerIdx > -1 && earlyCostcoIdx > -1 && firstFillerIdx < earlyCostcoIdx);
});

test("buildAssistantContext: flags truncation explicitly instead of silently dropping vouchers past the safety cap", () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = Array.from({ length: 160 }, (_, i) => tx(i + 1, `${monthKey}-01`, 1, -1, `Voucher ${i + 1}`));
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  assert.ok(context.includes("160 total"));
  assert.ok(context.includes("NOT included below"));
});
