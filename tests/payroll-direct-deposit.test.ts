import assert from "node:assert/strict";
import test from "node:test";
import { computePayrollDepositSplits } from "../lib/payroll-direct-deposit.ts";
import type { Account, PayrollDirectDepositSplit } from "../lib/vault-types.ts";

const accounts: Account[] = [
  { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
  { id: 2, name: "Chase Bank", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
  { id: 3, name: "Chime", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 },
];

test("computePayrollDepositSplits returns nothing when no splits are configured", () => {
  assert.deepEqual(computePayrollDepositSplits(undefined, 10000, accounts), []);
  assert.deepEqual(computePayrollDepositSplits([], 10000, accounts), []);
});

test("computePayrollDepositSplits ignores inactive (archived) splits entirely", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 2, amountType: "fixed", amount: 2000, active: false },
    { id: "b", accountId: 1, amountType: "remainder", active: false },
  ];
  assert.deepEqual(computePayrollDepositSplits(splits, 10000, accounts), []);
});

test("computePayrollDepositSplits: single active Remainder account gets the full deposit", () => {
  const splits: PayrollDirectDepositSplit[] = [{ id: "a", accountId: 1, amountType: "remainder", active: true }];
  const legs = computePayrollDepositSplits(splits, 8500.25, accounts);
  assert.deepEqual(legs, [{ accountId: 1, accountName: "Bank Of America", amount: 8500.25 }]);
});

test("computePayrollDepositSplits: fixed split taken off the top, remainder gets what's left", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 2, amountType: "fixed", amount: 2000, active: true },
    { id: "b", accountId: 1, amountType: "remainder", active: true },
  ];
  const legs = computePayrollDepositSplits(splits, 10000, accounts);
  assert.deepEqual(legs, [
    { accountId: 2, accountName: "Chase Bank", amount: 2000 },
    { accountId: 1, accountName: "Bank Of America", amount: 8000 },
  ]);
});

test("computePayrollDepositSplits: multiple fixed splits plus remainder", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 2, amountType: "fixed", amount: 1500, active: true },
    { id: "b", accountId: 3, amountType: "fixed", amount: 500, active: true },
    { id: "c", accountId: 1, amountType: "remainder", active: true },
  ];
  const legs = computePayrollDepositSplits(splits, 10000, accounts);
  assert.deepEqual(legs, [
    { accountId: 2, accountName: "Chase Bank", amount: 1500 },
    { accountId: 3, accountName: "Chime", amount: 500 },
    { accountId: 1, accountName: "Bank Of America", amount: 8000 },
  ]);
});

test("computePayrollDepositSplits: a fixed amount larger than the deposit is capped, not negative", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 2, amountType: "fixed", amount: 2000, active: true },
    { id: "b", accountId: 1, amountType: "remainder", active: true },
  ];
  const legs = computePayrollDepositSplits(splits, 1000, accounts);
  assert.deepEqual(legs, [{ accountId: 2, accountName: "Chase Bank", amount: 1000 }]);
});

test("computePayrollDepositSplits: no remainder configured folds the leftover into the last fixed leg instead of dropping it", () => {
  const splits: PayrollDirectDepositSplit[] = [{ id: "a", accountId: 2, amountType: "fixed", amount: 2000, active: true }];
  const legs = computePayrollDepositSplits(splits, 10000, accounts);
  assert.deepEqual(legs, [{ accountId: 2, accountName: "Chase Bank", amount: 10000 }]);
});

test("computePayrollDepositSplits: more than one active Remainder -- only the first gets the leftover", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 1, amountType: "remainder", active: true },
    { id: "b", accountId: 2, amountType: "remainder", active: true },
  ];
  const legs = computePayrollDepositSplits(splits, 10000, accounts);
  assert.deepEqual(legs, [{ accountId: 1, accountName: "Bank Of America", amount: 10000 }]);
});

test("computePayrollDepositSplits: skips a split whose account id no longer exists", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 999, amountType: "fixed", amount: 2000, active: true },
    { id: "b", accountId: 1, amountType: "remainder", active: true },
  ];
  const legs = computePayrollDepositSplits(splits, 10000, accounts);
  assert.deepEqual(legs, [{ accountId: 1, accountName: "Bank Of America", amount: 10000 }]);
});

test("computePayrollDepositSplits: your exact scenario -- entire paycheck now goes to BofA only", () => {
  const splits: PayrollDirectDepositSplit[] = [
    { id: "a", accountId: 1, amountType: "remainder", active: true },
    { id: "b", accountId: 2, amountType: "fixed", amount: 1500, active: false },
    { id: "c", accountId: 3, amountType: "fixed", amount: 500, active: false },
  ];
  const legs = computePayrollDepositSplits(splits, 9411.52, accounts);
  assert.deepEqual(legs, [{ accountId: 1, accountName: "Bank Of America", amount: 9411.52 }]);
});
