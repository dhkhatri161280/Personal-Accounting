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

test("buildAssistantContext: lists recent vouchers, most recent first", () => {
  const accounts = [account(1, "Bank", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    tx(1, "2026-01-01", 1, -100, "Older voucher"),
    tx(2, "2026-06-01", 1, -200, "Newer voucher"),
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
  const context = buildAssistantContext(data, "us");
  const newerIdx = context.indexOf("Newer voucher");
  const olderIdx = context.indexOf("Older voucher");
  assert.ok(newerIdx > -1 && olderIdx > -1 && newerIdx < olderIdx);
});
