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

test("computeFbarSummary: a self-service manual rate (Masters > Settings) fills in for a year not yet in the reviewed table", () => {
  const accounts = [account(1, "SBI Savings", "Bank Accounts"), account(999, "Other", "Indirect Incomes")];
  const transactions = [tx(1, "2026-04-01", 1, -900_000)];
  const data: Ledger = {
    version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions,
    fbarManualTreasuryRates: { "2026": 90 },
  };
  const summary = computeFbarSummary(data, 2026);
  assert.deepEqual(summary.rate, { rate: 90, asOf: "2026-12-31", source: "Entered manually in Masters > Settings" });
  const sbi = summary.rows.find((r) => r.name === "SBI Savings")!;
  assert.ok(Math.abs(sbi.maxBalanceUsd - 900_000 / 90) < 0.01);
});

test("computeFbarSummary: the reviewed hardcoded rate always wins over a manual entry, for a year already on file", () => {
  const data: Ledger = {
    version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts: [], transactions: [],
    fbarManualTreasuryRates: { "2025": 1 }, // deliberately wrong -- must never be used
  };
  const summary = computeFbarSummary(data, 2025);
  assert.equal(summary.rate, TREASURY_YEAR_END_RATE_INR[2025]);
});

test("computeFbarSummary: 'exclude' treatment (e.g. a premium-payment ledger, not a real balance) shows a row but contributes nothing to the total", () => {
  const premiumAcct: Account = { ...account(1, "LIC Premium", "Investments"), fbarTreatment: "exclude" };
  const accounts = [premiumAcct, account(999, "Other", "Indirect Incomes")];
  const transactions = [tx(1, "2025-08-11", 1, -569_644.2)]; // real ledger balance, must be ignored
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const summary = computeFbarSummary(data, 2025);

  const row = summary.rows.find((r) => r.name === "LIC Premium")!;
  assert.ok(row); // still listed, for transparency
  assert.equal(row.treatment, "exclude");
  assert.equal(row.maxBalanceUsd, 0);
  assert.equal(summary.totalUsd, 0); // the real ledger balance never counted
});

test("computeFbarSummary: 'manual' treatment uses the entered value for THAT calendar year, not the ledger's own balance, and flags a missing value", () => {
  const policyAcct: Account = {
    ...account(1, "Max Life Insurance", "Investments"),
    fbarTreatment: "manual",
    fbarManualValuesInr: { "2025": 210_875.1 }, // the real cash surrender value, not the premiums paid
  };
  const noValueYetAcct: Account = { ...account(2, "Max Life Insurance 2", "Investments"), fbarTreatment: "manual" };
  const accounts = [policyAcct, noValueYetAcct, account(999, "Other", "Indirect Incomes")];
  const transactions = [
    tx(1, "2025-08-11", 1, -1_000_000), // premiums-paid ledger balance, must be ignored in favor of the manual value
  ];
  const data: Ledger = { version: 1, company: "Test", currency: "INR", createdAt: "2025-01-01", accounts, transactions };
  const summary = computeFbarSummary(data, 2025);

  const rate = TREASURY_YEAR_END_RATE_INR[2025].rate;
  const withValue = summary.rows.find((r) => r.name === "Max Life Insurance")!;
  assert.equal(withValue.maxBalanceNative, 210_875.1);
  assert.equal(withValue.needsManualValue, false);
  assert.ok(Math.abs(withValue.maxBalanceUsd - 210_875.1 / rate) < 0.01);

  const missingValue = summary.rows.find((r) => r.name === "Max Life Insurance 2")!;
  assert.equal(missingValue.needsManualValue, true);
  assert.equal(missingValue.maxBalanceUsd, 0);

  // Only the entered manual value counts toward the total -- the missing one contributes nothing
  // (not silently treated as $0 of real value) and neither reads the ledger's own balance.
  assert.ok(Math.abs(summary.totalUsd - 210_875.1 / rate) < 0.01);
});
