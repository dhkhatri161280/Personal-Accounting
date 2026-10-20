import assert from "node:assert/strict";
import test from "node:test";
import { detectRecurringCandidates, templateFromCandidate, type DetectTx, type DetectAccount } from "../lib/recurring-detect.ts";
import type { RecurringTemplate } from "../lib/vault-types.ts";

const accounts: DetectAccount[] = [
  { id: 1, name: "Bank Of America" },
  { id: 2, name: "Netflix Subscription" },
  { id: 3, name: "Car EMI" },
  { id: 4, name: "Groceries" },
];

function monthlyTx(date: string, guid: string): DetectTx {
  return {
    guid,
    date,
    type: "Payment",
    narration: "Netflix",
    entries: [
      { accountId: 2, amount: -15.99 },
      { accountId: 1, amount: 15.99 },
    ],
  };
}

test("detectRecurringCandidates finds a monthly bill repeating on ~30 day gaps", () => {
  const txs: DetectTx[] = [
    monthlyTx("2026-04-05", "g1"),
    monthlyTx("2026-05-05", "g2"),
    monthlyTx("2026-06-06", "g3"),
    monthlyTx("2026-07-05", "g4"),
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], 60, "2026-07-10");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "monthly");
  assert.equal(candidates[0].debitAccountId, 2);
  assert.equal(candidates[0].creditAccountId, 1);
  assert.equal(candidates[0].suggestedLabel, "Netflix Subscription");
  assert.equal(candidates[0].occurrences.length, 4);
});

test("detectRecurringCandidates finds a quarterly pattern (~90 day gaps)", () => {
  const txs: DetectTx[] = [
    { guid: "q1", date: "2026-01-15", type: "Payment", narration: "Car EMI", entries: [{ accountId: 3, amount: -500 }, { accountId: 1, amount: 500 }] },
    { guid: "q2", date: "2026-04-15", type: "Payment", narration: "Car EMI", entries: [{ accountId: 3, amount: -500 }, { accountId: 1, amount: 500 }] },
    { guid: "q3", date: "2026-07-16", type: "Payment", narration: "Car EMI", entries: [{ accountId: 3, amount: -500 }, { accountId: 1, amount: 500 }] },
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], 60, "2026-07-20");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "quarterly");
});

test("detectRecurringCandidates requires at least 3 occurrences", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), monthlyTx("2026-05-05", "g2")];
  assert.equal(detectRecurringCandidates(txs, accounts, [], 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates skips an account pair that already has a template", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), monthlyTx("2026-05-05", "g2"), monthlyTx("2026-06-05", "g3")];
  const existing: RecurringTemplate[] = [
    {
      id: "t1", label: "Netflix", active: true, frequency: "monthly", voucherType: "Payment",
      narrationTemplate: "{month} Netflix", entries: [{ accountId: 2, amount: -15.99 }, { accountId: 1, amount: 15.99 }], postings: [],
    },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, existing, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates ignores an irregular, non-recurring pattern", () => {
  const txs: DetectTx[] = [
    { guid: "r1", date: "2026-01-03", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -52 }, { accountId: 1, amount: 52 }] },
    { guid: "r2", date: "2026-01-19", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -48 }, { accountId: 1, amount: 48 }] },
    { guid: "r3", date: "2026-02-28", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -61 }, { accountId: 1, amount: 61 }] },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, [], 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates excludes transactions older than the lookback window", () => {
  const txs: DetectTx[] = [monthlyTx("2020-01-05", "g1"), monthlyTx("2020-02-05", "g2"), monthlyTx("2020-03-05", "g3")];
  assert.equal(detectRecurringCandidates(txs, accounts, [], 12, "2026-07-10").length, 0);
});

test("templateFromCandidate pre-links the current period's own matching occurrence so it doesn't immediately show as due", () => {
  const txs: DetectTx[] = [monthlyTx("2026-05-05", "g1"), monthlyTx("2026-06-05", "g2"), monthlyTx("2026-07-05", "g3")];
  const candidates = detectRecurringCandidates(txs, accounts, [], 60, "2026-07-10");
  const template = templateFromCandidate(candidates[0], "2026-07-10");
  assert.equal(template.postings.length, 1);
  assert.equal(template.postings[0].periodKey, "2026-07");
  assert.equal(template.postings[0].txGuid, "g3");
  assert.equal(template.frequency, "monthly");
  assert.equal(template.label, "Netflix Subscription");
  assert.deepEqual(template.entries, [
    { accountId: 2, amount: -15.99 },
    { accountId: 1, amount: 15.99 },
  ]);
});
