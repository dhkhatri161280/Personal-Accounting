import assert from "node:assert/strict";
import test from "node:test";
import { currentMonthSiblingAccount, backfillReversalLinks } from "../lib/vault-accounting.ts";

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

test("backfillReversalLinks links a pre-existing reversal voucher to the original it names in its narration", () => {
  const original = { id: 112, type: "Payment", number: "469", date: "2026-09-10", narration: "Amazon", entries: [] };
  const reversal = {
    id: 121,
    type: "Receipt",
    number: "550",
    date: "2026-10-02",
    narration: "Reversal of Payment 469 (10-09-2026) — Amazon",
    entries: [],
  };
  const ledger = { accounts: [], transactions: [original, reversal] } as any;
  const result = backfillReversalLinks(ledger);
  const linked = result.transactions.find((t: any) => t.id === 121)!;
  assert.equal(linked.reversalOf, 112);
});

test("backfillReversalLinks never overwrites an already-set reversalOf", () => {
  const reversal = { id: 2, type: "Receipt", number: "1", date: "2026-10-02", narration: "Reversal of Payment 1 (01-10-2026) — x", reversalOf: 99, entries: [] };
  const original = { id: 1, type: "Payment", number: "1", date: "2026-10-01", narration: "x", entries: [] };
  const ledger = { accounts: [], transactions: [original, reversal] } as any;
  const result = backfillReversalLinks(ledger);
  assert.equal(result.transactions.find((t: any) => t.id === 2)!.reversalOf, 99);
});

test("backfillReversalLinks is a no-op (same reference) when there's nothing to link", () => {
  const ledger = {
    accounts: [],
    transactions: [{ id: 1, type: "Payment", number: "1", date: "2026-10-01", narration: "Groceries", entries: [] }],
  } as any;
  assert.equal(backfillReversalLinks(ledger), ledger);
});

test("backfillReversalLinks leaves a 'Reversal of' narration unlinked when no matching original exists", () => {
  const reversal = { id: 1, type: "Receipt", number: "99", date: "2026-10-02", narration: "Reversal of Payment 999 (01-10-2026) — ghost", entries: [] };
  const ledger = { accounts: [], transactions: [reversal] } as any;
  const result = backfillReversalLinks(ledger);
  assert.equal(result.transactions.find((t: any) => t.id === 1)!.reversalOf, undefined);
});
