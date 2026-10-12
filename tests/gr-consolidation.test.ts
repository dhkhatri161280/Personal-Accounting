import assert from "node:assert/strict";
import test from "node:test";
import { consolidateLedger, closingBalanceAsOf } from "../lib/gr-consolidation.ts";
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
