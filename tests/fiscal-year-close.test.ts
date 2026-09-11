import assert from "node:assert/strict";
import test from "node:test";
import { isFiscalYearAlreadyClosed, buildFiscalYearCloseVoucher } from "../lib/vault-accounting.ts";
import type { Ledger } from "../lib/vault-types.ts";

function ledger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [
      { id: 1, name: "Salary Income", parent: "Indirect Incomes", category: "Income", currency: "USD", openingBalance: 0, active: true },
      { id: 2, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0, active: true },
      { id: 3, name: "Profit & Loss A/c", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0, active: true },
      { id: 4, name: "Dignesh Khatri", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: 0, active: true },
    ],
    transactions: [],
    groups: [],
    ...overrides,
  } as unknown as Ledger;
}

test("isFiscalYearAlreadyClosed: false when no closing voucher has ever been posted for this FY", () => {
  const data = ledger();
  assert.equal(isFiscalYearAlreadyClosed(data, 2025), false);
});

test("isFiscalYearAlreadyClosed: true once buildFiscalYearCloseVoucher's own output is saved back in", () => {
  let data = ledger({
    transactions: [
      {
        id: 1, guid: "t1", date: "2025-06-01", number: "1", type: "Receipt", narration: "Salary",
        entries: [
          { accountId: 4, accountName: "Dignesh Khatri", amount: -1000 },
          { accountId: 1, accountName: "Salary Income", amount: 1000 },
        ],
      } as any,
    ],
  });
  const result = buildFiscalYearCloseVoucher(data, 2025);
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  data = { ...data, transactions: [...data.transactions, result.tx] };
  assert.equal(isFiscalYearAlreadyClosed(data, 2025), true);
});

test("isFiscalYearAlreadyClosed: false for a DIFFERENT fiscal year even after this one is closed", () => {
  let data = ledger({
    transactions: [
      {
        id: 1, guid: "t1", date: "2025-06-01", number: "1", type: "Receipt", narration: "Salary",
        entries: [
          { accountId: 4, accountName: "Dignesh Khatri", amount: -1000 },
          { accountId: 1, accountName: "Salary Income", amount: 1000 },
        ],
      } as any,
    ],
  });
  const result = buildFiscalYearCloseVoucher(data, 2025);
  if (result.status !== "created") throw new Error("expected a created closing voucher");
  data = { ...data, transactions: [...data.transactions, result.tx] };
  assert.equal(isFiscalYearAlreadyClosed(data, 2026), false);
});
