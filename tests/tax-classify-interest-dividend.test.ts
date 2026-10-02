import assert from "node:assert/strict";
import test from "node:test";
import { sumInterestDividendIncome } from "../lib/tax-classify.ts";
import type { Account, Tx } from "../lib/vault-types.ts";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Interest Income",
    parent: "Indirect Incomes",
    category: "Income",
    currency: "USD",
    openingBalance: 0,
    ...overrides,
  };
}

function tx(overrides: Partial<Tx> = {}): Tx {
  return {
    id: 1,
    guid: "g1",
    date: "2025-03-01",
    number: "1",
    type: "Receipt",
    narration: "",
    historical: false,
    entries: [],
    ...overrides,
  };
}

test("sums a credit to a dedicated Interest Income account", () => {
  const accounts = [account({ id: 1, name: "Interest Income" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const txs = [tx({ entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -2 }, { accountId: 1, accountName: "Interest Income", amount: 2 }] })];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 2);
});

test("sums a credit to a generic income account when the narration names it instead", () => {
  const accounts = [account({ id: 3, name: "Other Income" }), account({ id: 2, name: "Bank - Schwab", category: "Assets" })];
  const txs = [
    tx({
      narration: "Dividend/interest income",
      entries: [{ accountId: 2, accountName: "Bank - Schwab", amount: -391 }, { accountId: 3, accountName: "Other Income", amount: 391 }],
    }),
  ];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 391);
});

test("ignores an unrelated Income account whose name/narration doesn't match", () => {
  const accounts = [account({ id: 4, name: "Salary Income - Employer" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const txs = [tx({ entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -5000 }, { accountId: 4, accountName: "Salary Income - Employer", amount: 5000 }] })];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 0);
});

test("ignores the debit side of an income account (e.g. a reversal) even if the name matches", () => {
  const accounts = [account({ id: 1, name: "Interest Income" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const txs = [tx({ entries: [{ accountId: 1, accountName: "Interest Income", amount: -2 }, { accountId: 2, accountName: "Bank - Chase", amount: 2 }] })];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 0);
});

test("excludes entries outside the requested year", () => {
  const accounts = [account({ id: 1, name: "Interest Income" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const txs = [tx({ date: "2024-12-15", entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -2 }, { accountId: 1, accountName: "Interest Income", amount: 2 }] })];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 0);
});

test("excludes deleted and cancelled vouchers", () => {
  const accounts = [account({ id: 1, name: "Interest Income" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const entries = [{ accountId: 2, accountName: "Bank - Chase", amount: -2 }, { accountId: 1, accountName: "Interest Income", amount: 2 }];
  const txs = [tx({ id: 1, deleted: true, entries }), tx({ id: 2, cancelled: true, entries })];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 0);
});

test("counts a Schwab catch-up dividend toward its REAL year, not the posting (today) date", () => {
  // The actual bug from this session: confirmIncome() in SchwabImport.tsx deliberately posts a
  // catch-up dividend dated TODAY (not backdated), but its own narration names the real date --
  // a dividend truly paid in 2025 posted in 2026 must still count toward 2025.
  const accounts = [account({ id: 3, name: "Other Income" }), account({ id: 2, name: "Bank - Schwab", category: "Assets" })];
  const txs = [
    tx({
      date: "2026-08-28", // posted (confirmed) on this date
      narration: "NVDA Qualified Dividend (02-04-2025)", // but really paid 2025-04-02
      entries: [{ accountId: 2, accountName: "Bank - Schwab", amount: -88.33 }, { accountId: 3, accountName: "Other Income", amount: 88.33 }],
    }),
  ];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 88.33);
  assert.equal(sumInterestDividendIncome(txs, accounts, "2026"), 0);
});

test("falls back to Tx.date when a narration-matched posting has no embedded date to parse", () => {
  const accounts = [account({ id: 3, name: "Other Income" }), account({ id: 2, name: "Bank - Schwab", category: "Assets" })];
  const txs = [
    tx({
      date: "2025-06-01",
      narration: "Dividend/interest income",
      entries: [{ accountId: 2, accountName: "Bank - Schwab", amount: -50 }, { accountId: 3, accountName: "Other Income", amount: 50 }],
    }),
  ];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 50);
});

test("an account-name-only match (no descriptive narration) still uses Tx.date, not a narration date", () => {
  const accounts = [account({ id: 1, name: "Interest Income" }), account({ id: 2, name: "Bank - Chase", category: "Assets" })];
  const txs = [
    tx({
      date: "2025-03-01",
      narration: "", // no date to parse -- account name alone drives the match
      entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -2 }, { accountId: 1, accountName: "Interest Income", amount: 2 }],
    }),
  ];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 2);
});

test("matches the real filed-return 2025 total: $2 interest + $391 dividends", () => {
  const accounts = [
    account({ id: 1, name: "Interest Income" }),
    account({ id: 3, name: "Other Income" }),
    account({ id: 2, name: "Bank - Chase", category: "Assets" }),
  ];
  const txs = [
    tx({ entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -2 }, { accountId: 1, accountName: "Interest Income", amount: 2 }] }),
    tx({
      narration: "Dividend/interest income",
      entries: [{ accountId: 2, accountName: "Bank - Chase", amount: -391 }, { accountId: 3, accountName: "Other Income", amount: 391 }],
    }),
  ];
  assert.equal(sumInterestDividendIncome(txs, accounts, "2025"), 393);
});
