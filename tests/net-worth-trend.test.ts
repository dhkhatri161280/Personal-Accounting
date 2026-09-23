import assert from "node:assert/strict";
import test from "node:test";
import { computeNetWorthTrend, computeGrNetWorthTrend } from "../lib/net-worth-trend.ts";
import type { Account, Tx } from "../lib/vault-types.ts";
import type { GrAccount, GrTx } from "../lib/gr-consolidation.ts";

// Untested since the file was created (flagged in a whole-app review as one of the highest-risk
// gaps: this is the exact "twin implementation, only one side tested" pattern that let the Bank
// Reconciliation diff-formula drift bug through undetected). These lock in the US/India and GR
// variants' asset/liability classification and per-fiscal-year running balance, using the
// canonical accountNature() this file now imports instead of its own copy of the regex.

function accounts(): Account[] {
  return [
    { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
    { id: 2, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
    { id: 3, name: "Credit Card - BofA", parent: "Current Liabilities", category: "Liability", currency: "USD", openingBalance: 0 },
    { id: 4, name: "Dignesh Khatri", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0 },
  ];
}

function tx(id: number, date: string, entries: Tx["entries"]): Tx {
  return { id, guid: `v${id}`, date, number: String(id), type: "Payment", narration: "test", historical: false, entries };
}

test("computeNetWorthTrend: one snapshot per fiscal year-end, assets/liabilities accumulate, Capital Account excluded from real liabilities", () => {
  const transactions: Tx[] = [
    // FY2025 (Apr 2025 - Mar 2026): spend $100 out of the bank on groceries.
    tx(1, "2025-06-01", [
      { accountId: 2, accountName: "Groceries", amount: -100 },
      { accountId: 1, accountName: "Bank Of America", amount: 100 },
    ]),
    // FY2026 (Apr 2026 - Mar 2027): charge $50 to the credit card.
    tx(2, "2026-06-01", [
      { accountId: 2, accountName: "Groceries", amount: -50 },
      { accountId: 3, accountName: "Credit Card - BofA", amount: 50 },
    ]),
  ];
  const points = computeNetWorthTrend(accounts(), transactions, []);
  assert.equal(points.length, 2);
  assert.equal(points[0].fyEndDate, "2026-03-31");
  assert.equal(points[0].assets, -100);
  assert.equal(points[0].liabilities, 0);
  assert.equal(points[0].netWorth, -100);
  assert.equal(points[1].fyEndDate, "2027-03-31");
  assert.equal(points[1].assets, -100);
  assert.equal(points[1].liabilities, 50);
  assert.equal(points[1].netWorth, -150);
});

test("computeNetWorthTrend: a MasterGroup override changes classification the same way accountNature() does everywhere else", () => {
  const custom: Account[] = [
    { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
    { id: 2, name: "Owner Draw", parent: "My Custom Group", category: "Asset", currency: "USD", openingBalance: 0 },
  ];
  const transactions: Tx[] = [
    tx(1, "2025-06-01", [
      { accountId: 1, accountName: "Bank Of America", amount: -10 },
      { accountId: 2, accountName: "Owner Draw", amount: 10 },
    ]),
  ];
  // Without an override, "My Custom Group" falls through to the default "Asset" bucket, so Owner
  // Draw's balance nets into assets, not liabilities.
  const withoutOverride = computeNetWorthTrend(custom, transactions, []);
  assert.equal(withoutOverride[0].liabilities, 0);
  assert.equal(withoutOverride[0].assets, 0); // bank +10, owner draw -10 (both "Asset"), net zero

  // With the override forcing "My Custom Group" to Liability, Owner Draw's balance moves out of
  // assets and into liabilities instead -- bank's own classification (a different group) is
  // unaffected.
  const withOverride = computeNetWorthTrend(custom, transactions, [{ name: "My Custom Group", nature: "Liability" }]);
  assert.equal(withOverride[0].liabilities, 10);
  assert.equal(withOverride[0].assets, 10);
});

test("computeGrNetWorthTrend: same fiscal-year bucketing over the consolidated INR ledger, using the caller-supplied GR classifier", () => {
  const accts: GrAccount[] = [
    { name: "Bank Of America", parent: "Bank Accounts", sources: ["US"], inOpeningInr: 0, inDebitInr: 0, inCreditInr: 0, inClosingInr: 0, usOpeningUsd: 0, usClosingUsd: 0, usOpeningInr: 0, usDebitInr: 0, usCreditInr: 0, usClosingInr: 0, openingInr: 0, debitInr: 0, creditInr: 0, closingInr: 0 },
    { name: "Groceries", parent: "Indirect Expenses", sources: ["US"], inOpeningInr: 0, inDebitInr: 0, inCreditInr: 0, inClosingInr: 0, usOpeningUsd: 0, usClosingUsd: 0, usOpeningInr: 0, usDebitInr: 0, usCreditInr: 0, usClosingInr: 0, openingInr: 0, debitInr: 0, creditInr: 0, closingInr: 0 },
  ];
  const grTx: GrTx[] = [
    {
      guid: "g1", date: "2025-06-01", type: "Payment", number: "1", narration: "test", source: "US",
      originalCurrency: "USD", amountUsd: 100, amountInr: 8300, appliedRate: 83,
      entries: [
        { accountName: "Groceries", amountInr: -8300, originalAmount: -100 },
        { accountName: "Bank Of America", amountInr: 8300, originalAmount: 100 },
      ],
    },
  ];
  const grNature = (parent: string) => (parent.toLowerCase() === "bank accounts" ? "Bank" : "Expense");
  const points = computeGrNetWorthTrend(accts, grTx, grNature);
  assert.equal(points.length, 1);
  assert.equal(points[0].fyEndDate, "2026-03-31");
  assert.equal(points[0].assets, -8300);
  assert.equal(points[0].liabilities, 0);
});
