import assert from "node:assert/strict";
import test from "node:test";
import { closingBalanceAsOf, sumEntriesInRange, lastMonthEndCutoff, computeDashboardTrend } from "../lib/dashboard-trend.ts";
import type { Ledger } from "../lib/vault-types.ts";

const accounts = [
  { id: 1, openingBalance: 1000 },
  { id: 2, openingBalance: -500 },
];

const transactions = [
  { date: "2026-01-10", entries: [{ accountId: 1, amount: 200 }, { accountId: 2, amount: -200 }] },
  { date: "2026-02-05", entries: [{ accountId: 1, amount: -50 }] },
  { date: "2026-03-01", entries: [{ accountId: 1, amount: 500 }] },
  { date: "2026-03-15", deleted: true, entries: [{ accountId: 1, amount: 999999 }] },
  { date: "2026-03-20", cancelled: true, entries: [{ accountId: 1, amount: 999999 }] },
];

test("closingBalanceAsOf sums openingBalance plus every entry dated on or before the cutoff", () => {
  // Account 1: 1000 + 200 - 50 = 1150 as of 2026-02-28 (the 2026-03-01 entry is excluded)
  assert.equal(closingBalanceAsOf(accounts, transactions, new Set([1]), "2026-02-28"), 1150);
  assert.equal(closingBalanceAsOf(accounts, transactions, new Set([1]), "2026-03-01"), 1650);
});

test("closingBalanceAsOf excludes deleted and cancelled transactions", () => {
  // If the deleted/cancelled rows counted, this would be 1650 + 999999 + 999999
  assert.equal(closingBalanceAsOf(accounts, transactions, new Set([1]), "2026-03-31"), 1650);
});

test("closingBalanceAsOf sums across multiple accounts in the set", () => {
  assert.equal(closingBalanceAsOf(accounts, transactions, new Set([1, 2]), "2026-01-31"), 1000 + 200 + (-500 + -200));
});

test("closingBalanceAsOf ignores accounts not in the requested set", () => {
  assert.equal(closingBalanceAsOf(accounts, transactions, new Set([1]), "2026-01-31"), 1200);
});

test("sumEntriesInRange sums only entries strictly within [start, end], inclusive", () => {
  assert.equal(sumEntriesInRange(transactions, new Set([1]), "2026-01-01", "2026-02-28"), 200 - 50);
  assert.equal(sumEntriesInRange(transactions, new Set([1]), "2026-01-10", "2026-01-10"), 200);
  assert.equal(sumEntriesInRange(transactions, new Set([1]), "2026-04-01", "2026-04-30"), 0);
});

test("sumEntriesInRange excludes deleted and cancelled transactions", () => {
  assert.equal(sumEntriesInRange(transactions, new Set([1]), "2026-03-01", "2026-03-31"), 500);
});

test("lastMonthEndCutoff returns the last day of the previous calendar month", () => {
  assert.equal(lastMonthEndCutoff("2026-09-25"), "2026-08-31");
  assert.equal(lastMonthEndCutoff("2026-03-01"), "2026-02-28");
  assert.equal(lastMonthEndCutoff("2026-01-15"), "2025-12-31");
  assert.equal(lastMonthEndCutoff("2028-03-15"), "2028-02-29"); // leap year
});

function baseLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Chase Checking", parent: "Bank Accounts", category: "Asset", currency: "USD", openingBalance: 0 },
      { id: 2, name: "Owner Capital", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0 },
      { id: 3, name: "Consulting Income", parent: "Direct Incomes", category: "Income", currency: "USD", openingBalance: 0 },
      { id: 4, name: "Office Rent", parent: "Direct Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
    ],
    transactions: [],
    ...overrides,
  } as Ledger;
}

test("computeDashboardTrend returns {} outside a plain FY selection (all/custom/single month)", () => {
  const data = baseLedger();
  const ids = new Set([1]);
  for (const year of ["all", "custom", "2026-08"]) {
    const result = computeDashboardTrend({
      data, year, todayIso: "2026-09-25", cashIds: ids, capitalIds: ids, nominalIds: ids, cashBank: 100, dashboardCapitalTotal: 100,
    });
    assert.deepEqual(result, {}, `expected no trend for year=${year}`);
  }
});

test("computeDashboardTrend computes cashTrend as exactly the delta from entries dated after last month-end", () => {
  const data = baseLedger({
    transactions: [
      { id: 1, guid: "a", date: "2026-04-15", number: "1", type: "journal", narration: "", historical: false, entries: [{ accountId: 1, accountName: "Chase Checking", amount: -1000 }] },
      { id: 2, guid: "b", date: "2026-08-20", number: "2", type: "journal", narration: "", historical: false, entries: [{ accountId: 1, accountName: "Chase Checking", amount: -500 }] },
      { id: 3, guid: "c", date: "2026-09-10", number: "3", type: "journal", narration: "", historical: false, entries: [{ accountId: 1, accountName: "Chase Checking", amount: -2000 }] },
    ] as Ledger["transactions"],
  });
  // Matches VaultApp.tsx's own sign convention: cashBank = -sum(closing).
  const cashBank = 3500; // -(-1000 - 500 - 2000)
  const result = computeDashboardTrend({
    data, year: "2026", todayIso: "2026-09-25", cashIds: new Set([1]), capitalIds: new Set([2]), nominalIds: new Set([3, 4]),
    cashBank, dashboardCapitalTotal: 0,
  });
  // As of 2026-08-31, only the first two entries count: cashBankPrior = -(-1000-500) = 1500.
  // The delta should be exactly the excluded 2026-09-10 entry's display contribution (+2000).
  assert.equal(result.cashTrend, 2000);
});

test("computeDashboardTrend computes capitalTrend correctly when the FY is still open (uses live nominal-account activity)", () => {
  const data = baseLedger({
    transactions: [
      { id: 1, guid: "a", date: "2026-04-01", number: "1", type: "journal", narration: "", historical: false, entries: [{ accountId: 2, accountName: "Owner Capital", amount: 10000 }] },
      { id: 2, guid: "b", date: "2026-05-01", number: "2", type: "journal", narration: "", historical: false, entries: [{ accountId: 3, accountName: "Consulting Income", amount: 3000 }] },
      { id: 3, guid: "c", date: "2026-06-01", number: "3", type: "journal", narration: "", historical: false, entries: [{ accountId: 4, accountName: "Office Rent", amount: -800 }] },
      { id: 4, guid: "d", date: "2026-09-05", number: "4", type: "journal", narration: "", historical: false, entries: [{ accountId: 3, accountName: "Consulting Income", amount: 1500 }] },
    ] as Ledger["transactions"],
  });
  const dashboardCapitalTotal = 13700; // capitalClosing 10000 + transfer (3000 - 800 + 1500) 3700
  const result = computeDashboardTrend({
    data, year: "2026", todayIso: "2026-09-25", cashIds: new Set([1]), capitalIds: new Set([2]), nominalIds: new Set([3, 4]),
    cashBank: 0, dashboardCapitalTotal,
  });
  // As of 2026-08-31: capitalClosingPrior = 10000, transferPrior = 3000 - 800 = 2200 (the
  // 2026-09-05 income entry is excluded) -> capitalTotalPrior = 12200 -> delta = 1500, exactly
  // the excluded entry.
  assert.equal(result.capitalTrend, 1500);
});

test("computeDashboardTrend does not double-count nominal activity once the fiscal year is already formally closed", () => {
  const data = baseLedger({
    accounts: [
      { id: 1, name: "Chase Checking", parent: "Bank Accounts", category: "Asset", currency: "USD", openingBalance: 0 },
      { id: 2, name: "Owner Capital", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0 },
      { id: 3, name: "Consulting Income", parent: "Direct Incomes", category: "Income", currency: "USD", openingBalance: 0 },
      { id: 4, name: "Office Rent", parent: "Direct Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
      { id: 5, name: "Profit & Loss A/c", parent: "Direct Incomes", category: "Income", currency: "USD", openingBalance: 0 },
    ],
    transactions: [
      // A real FY2025 closing voucher (Apr 2025 - Mar 2026), dated the FY's own last day,
      // transferring a $2,200 surplus into Capital for real.
      {
        id: 1, guid: "close", date: "2026-03-31", number: "1", type: "journal", narration: "FY close", historical: false,
        entries: [
          { accountId: 2, accountName: "Owner Capital", amount: 2200 },
          { accountId: 5, accountName: "Profit & Loss A/c", amount: -2200 },
        ],
      },
      // A nominal entry that, if wrongly re-summed on top of the already-closed capital balance,
      // would double-count part of the same surplus.
      { id: 2, guid: "b", date: "2026-02-01", number: "2", type: "journal", narration: "", historical: false, entries: [{ accountId: 3, accountName: "Consulting Income", amount: 2200 }] },
    ] as Ledger["transactions"],
  });
  // Viewing the now-closed FY2025 from later in 2026 -- lastMonthEnd (2026-08-31) is past FY2025's
  // own end (2026-03-31), so the closed-year guard applies.
  const dashboardCapitalTotal = 2200; // capitalClosing already includes the real transfer
  const result = computeDashboardTrend({
    data, year: "2025", todayIso: "2026-09-25", cashIds: new Set([1]), capitalIds: new Set([2]), nominalIds: new Set([3, 4]),
    cashBank: 0, dashboardCapitalTotal,
  });
  // capitalClosingPrior already includes the close voucher's +2200 (dated 2026-03-31, before
  // lastMonthEnd) -- transferPrior must be forced to 0, not re-add the 2026-02-01 income entry,
  // or this would show a spurious +2200 "trend" for a fiscal year that's already fully closed.
  assert.equal(result.capitalTrend, 0);
});
