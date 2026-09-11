import assert from "node:assert/strict";
import test from "node:test";
import { currentMonthSiblingAccount } from "../lib/vault-accounting.ts";

test("currentMonthSiblingAccount redirects a House Hold Exps account to the current month's sibling", () => {
  const aug = { id: 1, name: "House Hold Exps - Aug 26", active: true };
  const sep = { id: 2, name: "House Hold Exps - Sep 26", active: true };
  const result = currentMonthSiblingAccount(aug as any, [aug, sep] as any, "2026-09-11");
  assert.equal(result.id, 2);
  assert.equal(result.name, "House Hold Exps - Sep 26");
});

test("currentMonthSiblingAccount leaves a non-monthly account (e.g. Salary Income - Employer) untouched", () => {
  const salary = { id: 3, name: "Salary Income - NVIDIA", active: true };
  const result = currentMonthSiblingAccount(salary as any, [salary] as any, "2026-09-11");
  assert.equal(result, salary);
});

test("currentMonthSiblingAccount falls back to the original account when this month's sibling doesn't exist yet", () => {
  const aug = { id: 1, name: "House Hold Exps - Aug 26", active: true };
  const result = currentMonthSiblingAccount(aug as any, [aug] as any, "2026-09-11");
  assert.equal(result, aug);
});

test("currentMonthSiblingAccount is a no-op when the account already IS the current month's", () => {
  const sep = { id: 2, name: "House Hold Exps - Sep 26", active: true };
  const result = currentMonthSiblingAccount(sep as any, [sep] as any, "2026-09-11");
  assert.equal(result, sep);
});
