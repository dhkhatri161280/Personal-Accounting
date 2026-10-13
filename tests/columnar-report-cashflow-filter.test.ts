import assert from "node:assert/strict";
import test from "node:test";
import { buildCashFlowColumns, periodBoundariesForRange } from "../lib/columnar-report.ts";
import type { Ledger } from "../lib/vault-types.ts";

function ledger(): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: -1000, active: true },
      { id: 2, name: "AMEX Credit Card", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0, active: true },
      { id: 3, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0, active: true },
    ],
    transactions: [
      // $100 grocery charge on AMEX.
      {
        id: 1,
        guid: "t1",
        date: "2026-04-10",
        number: "1",
        type: "Payment",
        narration: "Groceries on AMEX",
        entries: [
          { accountId: 3, accountName: "Groceries", amount: -100 },
          { accountId: 2, accountName: "AMEX Credit Card", amount: 100 },
        ],
      },
      // $50 grocery purchase from Bank Of America.
      {
        id: 2,
        guid: "t2",
        date: "2026-04-15",
        number: "2",
        type: "Payment",
        narration: "Groceries from BofA",
        entries: [
          { accountId: 3, accountName: "Groceries", amount: -50 },
          { accountId: 1, accountName: "Bank Of America", amount: 50 },
        ],
      },
      // A pure transfer between the two cash accounts (AMEX payment from BofA) -- must never
      // show up as a cash-flow line for either account, filtered or not.
      {
        id: 3,
        guid: "t3",
        date: "2026-04-20",
        number: "3",
        type: "Contra",
        narration: "AMEX payment",
        entries: [
          { accountId: 2, accountName: "AMEX Credit Card", amount: -75 },
          { accountId: 1, accountName: "Bank Of America", amount: 75 },
        ],
      },
    ],
    groups: [],
  } as unknown as Ledger;
}

test("buildCashFlowColumns: with no accountFilter, combines every cash/bank account", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");
  const { outflowRows } = buildCashFlowColumns(data, periods);
  const groceries = outflowRows.find((r) => r.name === "Groceries");
  assert.ok(groceries);
  assert.equal(groceries!.total, 150); // 100 (AMEX) + 50 (BofA)
});

test("buildCashFlowColumns: accountFilter narrows to only vouchers through that one account", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");

  const amexOnly = buildCashFlowColumns(data, periods, 2);
  const amexGroceries = amexOnly.outflowRows.find((r) => r.name === "Groceries");
  assert.ok(amexGroceries);
  assert.equal(amexGroceries!.total, 100);

  const bofaOnly = buildCashFlowColumns(data, periods, 1);
  const bofaGroceries = bofaOnly.outflowRows.find((r) => r.name === "Groceries");
  assert.ok(bofaGroceries);
  assert.equal(bofaGroceries!.total, 50);
});

test("buildCashFlowColumns: a pure transfer between two cash accounts never appears, filtered or not", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");
  for (const filter of [undefined, 1, 2] as const) {
    const { inflowRows, outflowRows } = buildCashFlowColumns(data, periods, filter);
    const allNames = [...inflowRows, ...outflowRows].map((r) => r.name);
    assert.ok(!allNames.includes("AMEX Credit Card"));
    assert.ok(!allNames.includes("Bank Of America"));
  }
});

test("buildCashFlowColumns: closingByPeriod scopes to the filtered account's own balance", () => {
  const data = ledger();
  const periods = periodBoundariesForRange("2026-04-01", "2026-04-30", "monthly");
  const key = periods[0].key;

  const all = buildCashFlowColumns(data, periods);
  const amexOnly = buildCashFlowColumns(data, periods, 2);
  const bofaOnly = buildCashFlowColumns(data, periods, 1);

  // Combined closing = sum of both accounts' own closing.
  assert.equal(all.closingByPeriod[key], amexOnly.closingByPeriod[key] + bofaOnly.closingByPeriod[key]);
});
