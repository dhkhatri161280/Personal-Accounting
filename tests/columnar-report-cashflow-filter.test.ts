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

test("buildCashFlowColumns: a voucher split across two cash accounts (e.g. payroll deposited to two banks) apportions each account's own share, not the full amount", () => {
  // Real confirmed bug: a $10,666.67 Salary Income credit split $10,166.67 to BofA + $500 to
  // Chase showed the FULL $10,666.67 against EITHER bank once filtered to just one of them.
  const data: Ledger = {
    currency: "USD",
    accounts: [
      { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0, active: true },
      { id: 2, name: "Chase Bank", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0, active: true },
      { id: 3, name: "Salary Income - Nvidia", parent: "Direct Incomes", category: "Income", currency: "USD", openingBalance: 0, active: true },
    ],
    transactions: [
      {
        id: 1,
        guid: "t1",
        date: "2026-07-15",
        number: "1",
        type: "Receipt",
        narration: "Salary Income - Semi Monthly",
        entries: [
          { accountId: 3, accountName: "Salary Income - Nvidia", amount: 10666.67 },
          { accountId: 1, accountName: "Bank Of America", amount: -10166.67 },
          { accountId: 2, accountName: "Chase Bank", amount: -500 },
        ],
      },
    ],
    groups: [],
  } as unknown as Ledger;
  const periods = periodBoundariesForRange("2026-07-01", "2026-07-31", "monthly");

  const chaseOnly = buildCashFlowColumns(data, periods, 2);
  const chaseSalary = chaseOnly.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(chaseSalary);
  assert.ok(Math.abs(chaseSalary!.total - 500) < 0.01, `expected ~500, got ${chaseSalary!.total}`);

  const bofaOnly = buildCashFlowColumns(data, periods, 1);
  const bofaSalary = bofaOnly.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(bofaSalary);
  assert.ok(Math.abs(bofaSalary!.total - 10166.67) < 0.01, `expected ~10166.67, got ${bofaSalary!.total}`);

  // The two accounts' shares must add back up to the unfiltered total -- apportionment, not
  // double-counting or under-counting.
  const all = buildCashFlowColumns(data, periods);
  const allSalary = all.inflowRows.find((r) => r.name === "Salary Income - Nvidia");
  assert.ok(Math.abs(chaseSalary!.total + bofaSalary!.total - allSalary!.total) < 0.01);
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
