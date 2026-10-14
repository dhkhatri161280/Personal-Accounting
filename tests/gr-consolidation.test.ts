import assert from "node:assert/strict";
import test from "node:test";
import { consolidateLedger, closingBalanceAsOf, buildGrCashFlowColumns, trimGrToLatestActivity } from "../lib/gr-consolidation.ts";
import { periodBoundariesForRange } from "../lib/columnar-report.ts";
import type { Account, Tx, Ledger } from "../lib/vault-types.ts";

function account(id: number, name: string, parent: string): Account {
  return { id, name, parent, category: "Income", currency: "INR", openingBalance: 0 };
}

function tx(id: number, date: string, entries: Tx["entries"]): Tx {
  return { id, guid: `v${id}`, date, number: String(id), type: "Receipt", narration: "test", historical: false, entries };
}

function ledger(accounts: Account[], transactions: Tx[]): Ledger {
  return { version: 1, company: "Test", currency: "INR", createdAt: "2026-01-01", accounts, transactions };
}

test("consolidateLedger: resolves a transaction entry's account name via accountId, not its possibly-stale stored name", () => {
  const accounts = [
    account(1, "Salary Income - TCS", "Direct Incomes"),
    account(2, "Bank Of India", "Bank Accounts"),
  ];
  const transactions = [
    // The voucher's own stored accountName lacks the hyphen the real ledger has -- a real,
    // observed case (confirmed via a live diagnostic on the user's actual India book) where a
    // voucher's snapshot name drifted from the current ledger name, silently orphaning that
    // account's entire real activity from every GR report.
    tx(1, "2026-04-05", [
      { accountId: 2, accountName: "Bank Of India", amount: -50000 },
      { accountId: 1, accountName: "Salary Income TCS", amount: 50000 },
    ]),
  ];
  const indiaData = ledger(accounts, transactions);
  const usData = ledger([], []);
  const gr = consolidateLedger(usData, indiaData, {});

  const salaryEntry = gr.transactions[0].entries.find((e) => e.accountName === "Salary Income - TCS");
  assert.ok(salaryEntry, "transaction entry should carry the account's real current name (with hyphen), not the stale stored one");
  assert.equal(salaryEntry!.amountInr, 50000);

  // Confirm the account itself is findable with a non-zero closing balance -- this is exactly
  // the real-world symptom: before this fix, gr.accounts had a "Salary Income - TCS" account
  // with closingInr === 0 (built from Account.openingBalance alone, no transaction activity ever
  // matched it), even though real money moved through it.
  const salaryAccount = gr.accounts.find((a) => a.name === "Salary Income - TCS");
  assert.ok(salaryAccount);
  assert.equal(salaryAccount!.creditInr, 50000);
});

test("closingBalanceAsOf: the all-time case matches GrAccount.closingInr exactly (fair-value method, not per-transaction-rate summing)", () => {
  // Real bug this reproduces: GrApp.tsx's Trial Balance used to sum each US entry's OWN
  // transaction-date-rate amountInr and add that to an opening balance pre-converted at
  // latestRate -- two different conversion bases mixed into one number. A real credit-card
  // account showed a Trial Balance closing of ₹12,500 while its own ledger drilldown (reading
  // GrAccount.closingInr, computed the correct "native balance x ONE rate" way) showed ₹12,750
  // for the exact same account. This test locks in the correct, single formula both should use.
  const usAccounts = [
    account(1, "AMEX Credit Card", "Bank Accounts"),
    account(2, "Some Expense", "Indirect Expenses"),
  ];
  const usTxns = [
    // Charge #1: April (FY26), $100.
    tx(1, "2026-04-10", [
      { accountId: 2, accountName: "Some Expense", amount: -100 },
      { accountId: 1, accountName: "AMEX Credit Card", amount: 100 },
    ]),
    // Charge #2: August (FY26), $50, a different month's rate.
    tx(2, "2026-08-10", [
      { accountId: 2, accountName: "Some Expense", amount: -50 },
      { accountId: 1, accountName: "AMEX Credit Card", amount: 50 },
    ]),
  ];
  const usData = ledger(usAccounts, usTxns);
  const indiaData = ledger([], []);
  // 3 distinct months' rates -- latestRate (the most recent key) is 85, deliberately different
  // from either transaction's own applicable rate (83 for April, 84 for August).
  const fxRates = { "2026-03": 83, "2026-07": 84, "2026-09": 85 };
  const gr = consolidateLedger(usData, indiaData, fxRates);

  const account_ = gr.accounts.find((a) => a.name === "AMEX Credit Card");
  assert.ok(account_);
  // closingUsd = 150 (both charges, no opening); fair-value INR = 150 x latestRate(85) = 12,750.
  assert.equal(account_!.closingInr, 12_750);

  // A period end covering every transaction (today or later) must reduce to the exact same
  // figure as the all-time closing -- this is the regression the real bug violated.
  assert.equal(closingBalanceAsOf(gr, "AMEX Credit Card", "2030-01-01"), 12_750);

  // Explicitly NOT the old (buggy) per-transaction-rate sum: 100x83 + 50x84 = 12,500.
  assert.notEqual(closingBalanceAsOf(gr, "AMEX Credit Card", "2030-01-01"), 12_500);
});

test("closingBalanceAsOf: a mid-period cutoff uses the rate applicable as of THAT date, not latestRate", () => {
  const usAccounts = [
    account(1, "AMEX Credit Card", "Bank Accounts"),
    account(2, "Some Expense", "Indirect Expenses"),
  ];
  const usTxns = [
    tx(1, "2026-04-10", [
      { accountId: 2, accountName: "Some Expense", amount: -100 },
      { accountId: 1, accountName: "AMEX Credit Card", amount: 100 },
    ]),
    // After the cutoff below -- must NOT be included.
    tx(2, "2026-08-10", [
      { accountId: 2, accountName: "Some Expense", amount: -50 },
      { accountId: 1, accountName: "AMEX Credit Card", amount: 50 },
    ]),
  ];
  const usData = ledger(usAccounts, usTxns);
  const indiaData = ledger([], []);
  const fxRates = { "2026-03": 83, "2026-07": 84, "2026-09": 85 };
  const gr = consolidateLedger(usData, indiaData, fxRates);

  // Cutoff of 2026-05-01: only the April charge counts (closingUsd = 100), and the applicable
  // rate for that date (prevMonthKey "2026-04", not itself in the table) falls back to the
  // nearest earlier month, "2026-03" = 83 -- not latestRate (85).
  assert.equal(closingBalanceAsOf(gr, "AMEX Credit Card", "2026-05-01"), 100 * 83);
});

test("buildGrCashFlowColumns: buckets a cash-affecting voucher into the right period, inflow vs. outflow by the OTHER leg's own sign", () => {
  const usAccounts = [
    account(1, "Checking", "Bank Accounts"),
    account(2, "Salary", "Direct Incomes"),
    account(3, "Rent", "Indirect Expenses"),
  ];
  const usTxns = [
    // April: salary deposit -- bank debited (amount < 0, money received), income credited (> 0).
    tx(1, "2026-04-05", [
      { accountId: 1, accountName: "Checking", amount: -1000 },
      { accountId: 2, accountName: "Salary", amount: 1000 },
    ]),
    // May: rent paid -- bank credited (amount > 0, money leaving), expense debited (< 0).
    tx(2, "2026-05-10", [
      { accountId: 1, accountName: "Checking", amount: 500 },
      { accountId: 3, accountName: "Rent", amount: -500 },
    ]),
  ];
  const usData = ledger(usAccounts, usTxns);
  const indiaData = ledger([], []);
  // Flat 1:1 rate for every month this test touches, so USD amounts and their converted INR
  // amounts are numerically identical -- keeps the assertions about bucketing/sign readable
  // without also re-deriving an FX multiplication (that's already covered by the
  // closingBalanceAsOf tests above).
  const gr = consolidateLedger(usData, indiaData, { "2026-03": 1, "2026-04": 1 });
  const bankCashAccounts = gr.accounts.filter((a) => a.parent === "Bank Accounts");
  const periods = periodBoundariesForRange("2026-04-01", "2026-06-30", "monthly");

  const { inflowRows, outflowRows, closingByPeriod } = buildGrCashFlowColumns(gr, periods, bankCashAccounts);

  assert.equal(inflowRows.length, 1);
  assert.equal(inflowRows[0].name, "Salary");
  assert.equal(inflowRows[0].values["2026-04"], 1000);
  assert.equal(inflowRows[0].values["2026-05"] ?? 0, 0);
  assert.equal(inflowRows[0].total, 1000);

  assert.equal(outflowRows.length, 1);
  assert.equal(outflowRows[0].name, "Rent");
  assert.equal(outflowRows[0].values["2026-05"], 500);
  assert.equal(outflowRows[0].total, 500);

  // Closing cash balance as of each period-end -- sign-flipped from closingBalanceAsOf's own
  // credit-positive storage convention (same -closing flip buildCashFlowColumns itself uses for
  // display), not a flow sum.
  assert.equal(closingByPeriod["2026-04"], -closingBalanceAsOf(gr, "Checking", periods[0].end));
  assert.equal(closingByPeriod["2026-05"], -closingBalanceAsOf(gr, "Checking", periods[1].end));
  assert.equal(closingByPeriod["2026-04"], 1000); // $1000 received into the bank
  assert.equal(closingByPeriod["2026-05"], 500); // net of the +1000 receipt and -500 payment
});

test("buildGrCashFlowColumns: accountFilter narrows to vouchers whose cash leg touched that one account", () => {
  const usAccounts = [
    account(1, "Checking", "Bank Accounts"),
    account(2, "Savings", "Bank Accounts"),
    account(3, "Salary", "Direct Incomes"),
    account(4, "Interest", "Direct Incomes"),
  ];
  const usTxns = [
    tx(1, "2026-04-05", [
      { accountId: 1, accountName: "Checking", amount: -1000 },
      { accountId: 3, accountName: "Salary", amount: 1000 },
    ]),
    tx(2, "2026-04-06", [
      { accountId: 2, accountName: "Savings", amount: -50 },
      { accountId: 4, accountName: "Interest", amount: 50 },
    ]),
  ];
  const usData = ledger(usAccounts, usTxns);
  const indiaData = ledger([], []);
  const gr = consolidateLedger(usData, indiaData, {});
  const bankCashAccounts = gr.accounts.filter((a) => a.parent === "Bank Accounts");
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");

  const all = buildGrCashFlowColumns(gr, periods, bankCashAccounts);
  assert.equal(all.inflowRows.length, 2);

  const filtered = buildGrCashFlowColumns(gr, periods, bankCashAccounts, "Checking");
  assert.equal(filtered.inflowRows.length, 1);
  assert.equal(filtered.inflowRows[0].name, "Salary");
  // Closing is also scoped to just the filtered account, same reasoning as the US/India book's
  // own cashFlowBank/cashFlowOpening filtering.
  assert.equal(filtered.closingByPeriod["2026-04"], -closingBalanceAsOf(gr, "Checking", periods[0].end));
});

test("buildGrCashFlowColumns: a voucher split across two cash accounts apportions each account's own share, not the full amount", () => {
  const usAccounts = [
    account(1, "Bank Of America", "Bank Accounts"),
    account(2, "Chase Bank", "Bank Accounts"),
    account(3, "Salary Income - Nvidia", "Direct Incomes"),
  ];
  const usTxns = [
    tx(1, "2026-07-15", [
      { accountId: 3, accountName: "Salary Income - Nvidia", amount: 10666.67 },
      { accountId: 1, accountName: "Bank Of America", amount: -10166.67 },
      { accountId: 2, accountName: "Chase Bank", amount: -500 },
    ]),
  ];
  const usData = ledger(usAccounts, usTxns);
  const indiaData = ledger([], []);
  const gr = consolidateLedger(usData, indiaData, { "2026-06": 1 });
  const bankCashAccounts = gr.accounts.filter((a) => a.parent === "Bank Accounts");
  const periods = periodBoundariesForRange("2026-07-01", "2026-07-31", "monthly");

  const chaseOnly = buildGrCashFlowColumns(gr, periods, bankCashAccounts, "Chase Bank");
  const chaseSalary = chaseOnly.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(chaseSalary);
  assert.ok(Math.abs(chaseSalary!.total - 500) < 0.01, `expected ~500, got ${chaseSalary!.total}`);

  const bofaOnly = buildGrCashFlowColumns(gr, periods, bankCashAccounts, "Bank Of America");
  const bofaSalary = bofaOnly.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(bofaSalary);
  assert.ok(Math.abs(bofaSalary!.total - 10166.67) < 0.01, `expected ~10166.67, got ${bofaSalary!.total}`);

  const all = buildGrCashFlowColumns(gr, periods, bankCashAccounts);
  const allSalary = all.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(Math.abs(chaseSalary!.total + bofaSalary!.total - allSalary!.total) < 0.01);
});

test("trimGrToLatestActivity: drops periods that haven't started yet as of the latest posted voucher", () => {
  const usAccounts = [account(1, "Checking", "Bank Accounts"), account(2, "Salary", "Direct Incomes")];
  const usTxns = [
    tx(1, "2026-04-05", [
      { accountId: 1, accountName: "Checking", amount: -1000 },
      { accountId: 2, accountName: "Salary", amount: 1000 },
    ]),
  ];
  const gr = consolidateLedger(ledger(usAccounts, usTxns), ledger([], []), {});
  const periods = periodBoundariesForRange("2026-04-01", "2026-09-30", "monthly");
  assert.equal(periods.length, 6);

  const trimmed = trimGrToLatestActivity(periods, gr);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].key, "2026-04");
});
