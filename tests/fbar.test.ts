import assert from "node:assert/strict";
import test from "node:test";
import { maxBalanceInRange, computeFbarSummary, TREASURY_YEAR_END_RATE_INR } from "../lib/fbar.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string, openingBalance = 0): Account {
  return { id, name, parent, category: "Asset", currency: "INR", openingBalance, active: true };
}

function tx(id: number, date: string, accountId: number, amount: number): Tx {
  return {
    id,
    guid: `v${id}`,
    date,
    number: String(id),
    type: amount < 0 ? "Payment" : "Receipt",
    narration: "test",
    historical: false,
    entries: [
      { accountId, accountName: "", amount },
      { accountId: 999, accountName: "Other", amount: -amount },
    ],
  };
}

test("maxBalanceInRange: finds the peak balance within the window, not just the closing balance", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", 0), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    tx(1, "2025-03-01", 1, -500_000), // balance rises to 500,000 (deposit)
    tx(2, "2025-06-01", 1, 300_000), // balance drops to 200,000 (withdrawal)
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const { max, maxDate } = maxBalanceInRange(data, 1, "2025-01-01", "2025-12-31");
  assert.equal(max, 500_000);
  assert.equal(maxDate, "2025-03-01");
});

test("maxBalanceInRange: the window's own opening balance (carried from before the window) is a valid peak when nothing in the window exceeds it", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", 0), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    tx(1, "2024-06-01", 1, -1_000_000), // before the 2025 window -- balance already 1,000,000 going in
    tx(2, "2025-02-01", 1, 50_000), // a small withdrawal during 2025, never exceeds the carried-in balance
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const { max, maxDate } = maxBalanceInRange(data, 1, "2025-01-01", "2025-12-31");
  assert.equal(max, 1_000_000);
  assert.equal(maxDate, null); // the peak predates the window, not a transaction within it
});

test("maxBalanceInRange: activity after the window never counts", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts", 0), account(999, "Other", "Indirect Incomes")];
  const transactions = [
    tx(1, "2025-06-01", 1, -100_000),
    tx(2, "2026-01-05", 1, -5_000_000), // well after the 2025 window
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const { max } = maxBalanceInRange(data, 1, "2025-01-01", "2025-12-31");
  assert.equal(max, 100_000);
});

test("computeFbarSummary: converts each account's own peak using the Treasury year-end rate, flags the $10,000 aggregate threshold", () => {
  const accounts = [
    account(1, "SBI Savings", "Bank Accounts"),
    account(2, "HDFC Fixed Deposit", "Investments"),
    account(3, "Cash in hand", "Cash-in-hand"), // must be excluded -- not a financial account
    account(4, "House Hold Exps", "Indirect Expenses"), // must be excluded -- not Bank/Investment nature
    account(999, "Other", "Indirect Incomes"),
  ];
  const transactions = [
    tx(1, "2025-04-01", 1, -800_000), // SBI peak: 800,000 INR
    tx(2, "2025-07-01", 2, -200_000), // HDFC FD peak: 200,000 INR
    tx(3, "2025-05-01", 3, -50_000),
    tx(4, "2025-05-01", 4, -1_000),
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const summary = computeFbarSummary(data, 2025);

  assert.equal(summary.rows.length, 2); // only the Bank and Investment accounts
  assert.ok(summary.rows.every((r) => r.nature === "Bank" || r.nature === "Investment"));
  assert.equal(summary.rows.find((r) => r.name === "Cash in hand"), undefined);
  assert.equal(summary.rows.find((r) => r.name === "House Hold Exps"), undefined);

  const rate = TREASURY_YEAR_END_RATE_INR[2025].rate;
  const sbi = summary.rows.find((r) => r.name === "SBI Savings")!;
  assert.equal(sbi.maxBalanceNative, 800_000);
  assert.ok(Math.abs(sbi.maxBalanceUsd - 800_000 / rate) < 0.01);

  const expectedTotalUsd = 800_000 / rate + 200_000 / rate;
  assert.ok(Math.abs(summary.totalUsd - expectedTotalUsd) < 0.01);
  assert.equal(summary.thresholdExceeded, expectedTotalUsd > 10_000);
});

test("computeFbarSummary: returns no rate info for a year with no published Treasury rate on file", () => {
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts: [], transactions: [] };
  const summary = computeFbarSummary(data, 1999);
  assert.equal(summary.rate, null);
  assert.deepEqual(summary.rows, []);
});
