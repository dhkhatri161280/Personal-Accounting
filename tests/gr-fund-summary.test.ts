import assert from "node:assert/strict";
import test from "node:test";
import { computeGrFundSummary } from "../lib/gr-fund-summary.ts";
import type { GrAccount, GrTx, GrLedger } from "../lib/gr-consolidation.ts";

// computeGrFundSummary's `active` filter mirrors GrApp.tsx's own activeAccounts check (any
// nonzero debit/credit/closing/opening), same as a real consolidateLedger() output would produce
// for any account with real activity -- stubbed non-zero here since the actual period math under
// test comes from the transactions' own dr/cr maps, not these aggregate fields.
function acc(name: string, parent: string, overrides: Partial<GrAccount> = {}): GrAccount {
  return {
    name,
    parent,
    sources: ["US"],
    inOpeningInr: 0, inDebitInr: 0, inCreditInr: 0, inClosingInr: 0,
    usOpeningUsd: 0, usClosingUsd: 0, usOpeningInr: 0, usDebitInr: 0, usCreditInr: 0, usClosingInr: 0,
    openingInr: 0, debitInr: 0, creditInr: 1, closingInr: 1,
    ...overrides,
  };
}

function tx(guid: string, date: string, entries: GrTx["entries"]): GrTx {
  return { guid, date, type: "Journal", number: "1", narration: "test", source: "US", originalCurrency: "INR", amountInr: 0, amountUsd: 0, appliedRate: 1, entries };
}

function ledger(accounts: GrAccount[], transactions: GrTx[]): GrLedger {
  return { accounts, transactions, fxRates: {}, missingRateMonths: [], latestRate: 83 };
}

test("computeGrFundSummary: income (Cr+) and expense (Dr+) land with the right sign, Liquidity Balance ties to real Bank+Cash change", () => {
  const accounts = [
    acc("Salary Income", "Direct Incomes"),
    acc("Groceries", "Indirect Expenses"),
    acc("Bank Of America", "Bank Accounts"),
  ];
  const transactions = [
    // Salary received: Dr Bank (cash in, negative = debit = asset increase) / Cr Salary Income
    // (positive = credit = income).
    tx("t1", "2026-04-05", [
      { accountName: "Bank Of America", amountInr: -100000, originalAmount: -1200 },
      { accountName: "Salary Income", amountInr: 100000, originalAmount: 1200 },
    ]),
    // Groceries paid from the bank: Dr Groceries (expense grows) / Cr Bank (cash out).
    tx("t2", "2026-04-10", [
      { accountName: "Groceries", amountInr: -8300, originalAmount: -100 },
      { accountName: "Bank Of America", amountInr: 8300, originalAmount: 100 },
    ]),
  ];
  const s = computeGrFundSummary(ledger(accounts, transactions), "2026-04-01", "2027-03-31", new Map());

  assert.equal(s.incoming.total, 100000); // Salary, positive
  assert.equal(s.outgoingExpenses.total, 8300); // Groceries, positive (a use of funds)
  assert.equal(s.liquidityBalance, 100000 - 8300);
  // Real Bank movement: +100000 (salary) - 8300 (groceries) = 91700, same as Liquidity Balance.
  assert.equal(s.bankCashChange, 91700);
  assert.equal(s.liquidityBalance, s.bankCashChange);
});

test("computeGrFundSummary: CCU Home Loan is excluded from Financing, netted into the Home Fixed Assets line instead", () => {
  const accounts = [
    acc("Home", "Fixed Assets"),
    acc("Home Mortgage", "Fixed Assets"),
    acc("CCU Home Loan", "Loans (Liability)"),
  ];
  const transactions = [
    // A mortgage draw that funded the home purchase directly (never touched Bank/Cash):
    // Dr Home Mortgage (asset mirror grows) / Cr CCU Home Loan (liability grows).
    tx("t1", "2026-04-05", [
      { accountName: "Home Mortgage", amountInr: -500000, originalAmount: -6000 },
      { accountName: "CCU Home Loan", amountInr: 500000, originalAmount: 6000 },
    ]),
    // The actual home's own cash-funded value:
    tx("t2", "2026-04-05", [
      { accountName: "Home", amountInr: -200000, originalAmount: -2400 },
    ]),
  ];
  const s = computeGrFundSummary(ledger(accounts, transactions), "2026-04-01", "2027-03-31", new Map());

  // Financing must be empty -- CCU Home Loan's effect is fully absorbed into the Home line below,
  // not double-counted as a separate cash source with nothing to offset it.
  assert.equal(s.financing.total, 0);
  // Home line = Home(200000) + Home Mortgage(500000) + CCU Home Loan(-500000) = 200000, the real
  // cash-funded portion only.
  assert.equal(s.outgoingFixedAssets.total, 200000);
});

test("computeGrFundSummary: Investment stays distinct from generic Asset via groupNatures override", () => {
  const accounts = [acc("Mutual Fund XYZ", "Custom Investments Group")];
  const transactions = [tx("t1", "2026-05-01", [{ accountName: "Mutual Fund XYZ", amountInr: -50000, originalAmount: -600 }])];
  const groupNatures = new Map([["custom investments group", "Investment"]]);
  const s = computeGrFundSummary(ledger(accounts, transactions), "2026-04-01", "2027-03-31", groupNatures);
  assert.equal(s.outgoingInvestments.total, 50000);
  assert.equal(s.outgoingFixedAssets.total, 0);
});
