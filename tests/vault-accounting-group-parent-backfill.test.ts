import assert from "node:assert/strict";
import test from "node:test";
import { backfillGroupParentNames } from "../lib/vault-accounting.ts";

test("backfillGroupParentNames strips Tally's stray '&#4;' marker from a group's parent", () => {
  // Confirmed live via the Masters > Groups screen: a group directly under Tally's built-in
  // "Primary" group showed its parent as the literal raw string "&#4; Primary" instead of
  // "Primary" -- a leftover from a master sync that ran before the sync tool's own decoder was
  // fixed to strip Tally's "&#4;" numeric character reference.
  const ledger = {
    groups: [{ name: "Misc. Expenses (ASSET)", parent: "&#4; Primary", nature: "Expense" }],
    accounts: [],
    transactions: [],
  } as any;
  const result = backfillGroupParentNames(ledger);
  assert.equal(result.groups?.[0].parent, "Primary");
});

test("backfillGroupParentNames strips the same marker from an account's parent", () => {
  const ledger = {
    groups: [],
    accounts: [{ id: 1, name: "Some Ledger", parent: "&#4; Primary" }],
    transactions: [],
  } as any;
  const result = backfillGroupParentNames(ledger);
  assert.equal(result.accounts[0].parent, "Primary");
});

test("backfillGroupParentNames is a no-op (same reference) when nothing needs cleaning", () => {
  const ledger = {
    groups: [{ name: "Indirect Expenses", parent: "Primary", nature: "Expense" }],
    accounts: [{ id: 1, name: "Some Ledger", parent: "Indirect Expenses" }],
    transactions: [],
  } as any;
  assert.equal(backfillGroupParentNames(ledger), ledger);
});

test("backfillGroupParentNames never double-strips on a second pass", () => {
  const ledger = {
    groups: [{ name: "Purchase Accounts", parent: "&#4; Primary", nature: "Expense" }],
    accounts: [],
    transactions: [],
  } as any;
  const once = backfillGroupParentNames(ledger);
  const twice = backfillGroupParentNames(once);
  assert.equal(twice, once);
  assert.equal(twice.groups?.[0].parent, "Primary");
});
