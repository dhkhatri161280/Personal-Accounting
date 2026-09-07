import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyAmortization,
  amortizedToDate,
  remainingBalance,
  pendingAmortizationMonths,
} from "../lib/prepaid-expense.ts";
import type { PrepaidExpense } from "../lib/vault-types.ts";

function prepaid(overrides: Partial<PrepaidExpense> = {}): PrepaidExpense {
  return {
    id: "p1",
    name: "Annual Insurance",
    accountId: 1,
    expenseAccountId: 2,
    startDate: "2026-01-15",
    totalAmount: 1200,
    termMonths: 12,
    ...overrides,
  };
}

test("monthlyAmortization: straight-line over term", () => {
  assert.equal(monthlyAmortization(prepaid()), 100);
});

test("monthlyAmortization: non-amortizable (termMonths 0) returns 0, no divide-by-zero", () => {
  assert.equal(monthlyAmortization(prepaid({ termMonths: 0 })), 0);
});

test("amortizedToDate: counts only fully-elapsed months, caps at term", () => {
  assert.equal(amortizedToDate(prepaid(), "2026-03-15"), 200); // Jan+Feb fully elapsed
  assert.equal(amortizedToDate(prepaid(), "2027-06-01"), 1200); // well past 12 months, capped
});

test("amortizedToDate: caps at write-off date, not asOfDate, when written off", () => {
  const writtenOff = prepaid({ writtenOff: { date: "2026-04-10" } });
  assert.equal(amortizedToDate(writtenOff, "2027-01-01"), 300); // Jan+Feb+Mar
});

test("remainingBalance: total minus amortized", () => {
  assert.equal(remainingBalance(prepaid(), "2026-03-15"), 1000);
});

test("pendingAmortizationMonths: first run posts all fully-elapsed months since start", () => {
  const pending = pendingAmortizationMonths(prepaid(), "2026-03-15");
  assert.deepEqual(pending, [
    { yearMonth: "2026-01", amount: 100 },
    { yearMonth: "2026-02", amount: 100 },
  ]);
});

test("pendingAmortizationMonths: incremental run only posts new months, matches amortizedToDate", () => {
  const p = prepaid({ lastAmortizedThrough: "2026-02" });
  const pending = pendingAmortizationMonths(p, "2026-04-10");
  assert.deepEqual(pending, [{ yearMonth: "2026-03", amount: 100 }]);
  assert.equal(pending.reduce((s, x) => s + x.amount, 0), amortizedToDate(p, "2026-04-10") - 200);
});

test("pendingAmortizationMonths: nothing pending in the same month as last run", () => {
  const p = prepaid({ lastAmortizedThrough: "2026-02" });
  assert.deepEqual(pendingAmortizationMonths(p, "2026-03-05"), []);
});

test("pendingAmortizationMonths: stops at term length even if throughDate is much later", () => {
  const p = prepaid({ termMonths: 2 });
  const pending = pendingAmortizationMonths(p, "2027-01-01");
  assert.equal(pending.length, 2);
  assert.equal(pending.reduce((s, x) => s + x.amount, 0), 1200);
});

test("pendingAmortizationMonths: nothing pending once fully amortized and re-run later", () => {
  const p = prepaid({ termMonths: 2, lastAmortizedThrough: "2026-02" });
  assert.deepEqual(pendingAmortizationMonths(p, "2027-01-01"), []);
});
