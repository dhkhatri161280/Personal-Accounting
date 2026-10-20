import assert from "node:assert/strict";
import test from "node:test";
import { detectRecurringCandidates, templateFromCandidate, diagnoseLedger, type DetectTx, type DetectAccount } from "../lib/recurring-detect.ts";
import type { RecurringTemplate } from "../lib/vault-types.ts";

const accounts: DetectAccount[] = [
  { id: 1, name: "Bank Of America" },
  { id: 2, name: "Netflix Subscription" },
  { id: 3, name: "Car EMI" },
  { id: 4, name: "Groceries" },
  { id: 5, name: "PG&E Electric" },
  { id: 6, name: "DMV Registration" },
  { id: 7, name: "Citi Credit Card" },
  { id: 8, name: "House Hold Exps - Apr 26" },
  { id: 9, name: "House Hold Exps - May 26" },
];

const none = new Set<string>();

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
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
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
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-20");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "quarterly");
});

test("detectRecurringCandidates requires at least 2 occurrences", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1")];
  assert.equal(detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates accepts 2 occurrences when the single gap tightly matches a standard cadence (e.g. yearly)", () => {
  const txs: DetectTx[] = [
    { guid: "d1", date: "2025-03-10", type: "Payment", narration: "DMV", entries: [{ accountId: 6, amount: -62 }, { accountId: 1, amount: 62 }] },
    { guid: "d2", date: "2026-03-18", type: "Payment", narration: "DMV", entries: [{ accountId: 6, amount: -65 }, { accountId: 1, amount: 65 }] },
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "yearly");
  assert.equal(candidates[0].suggestedAnchorMonth, "2026-03", "yearly now gets its real due month, not undefined");
});

test("templateFromCandidate carries the due month through for a yearly candidate, so it isn't flagged due all year", () => {
  const txs: DetectTx[] = [
    { guid: "d1", date: "2024-12-10", type: "Payment", narration: "Home Insurance", entries: [{ accountId: 6, amount: -1050 }, { accountId: 1, amount: 1050 }] },
    { guid: "d2", date: "2025-12-14", type: "Payment", narration: "Home Insurance", entries: [{ accountId: 6, amount: -1050 }, { accountId: 1, amount: 1050 }] },
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
  const template = templateFromCandidate(candidates[0], "2026-07-10");
  assert.equal(template.frequency, "yearly");
  assert.equal(template.anchorMonth, "2025-12");
});

test("detectRecurringCandidates rejects 2 occurrences whose gap doesn't land on a standard cadence", () => {
  // ~50 days apart -- not close enough to monthly (30) or bimonthly (60) with only one gap to go on.
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), { ...monthlyTx("2026-05-25", "g2") }];
  assert.equal(detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates skips an account pair that already has a template", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), monthlyTx("2026-05-05", "g2"), monthlyTx("2026-06-05", "g3")];
  const existing: RecurringTemplate[] = [
    {
      id: "t1", label: "Netflix", active: true, frequency: "monthly", voucherType: "Payment",
      narrationTemplate: "{month} Netflix", entries: [{ accountId: 2, amount: -15.99 }, { accountId: 1, amount: 15.99 }], postings: [],
    },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, existing, none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates skips an account pair the user already dismissed", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), monthlyTx("2026-05-05", "g2"), monthlyTx("2026-06-05", "g3")];
  assert.equal(detectRecurringCandidates(txs, accounts, [], new Set(["id:2"]), 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates tolerates large usage-based amount swings as long as the interval is regular", () => {
  // A PG&E-style bill that roughly doubles between winter and summer -- amount should NOT gate it out.
  const txs: DetectTx[] = [
    { guid: "p1", date: "2026-01-10", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -180 }, { accountId: 1, amount: 180 }] },
    { guid: "p2", date: "2026-02-09", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -95 }, { accountId: 1, amount: 95 }] },
    { guid: "p3", date: "2026-03-11", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -40 }, { accountId: 1, amount: 40 }] },
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "monthly");
});

test("detectRecurringCandidates still recognizes a bill paid from a DIFFERENT card some months as the same recurring bill", () => {
  // Same bill ledger (PG&E), different payment-source accounts across occurrences -- this is
  // exactly the case that used to silently split into under-threshold groups and never surface.
  const txs: DetectTx[] = [
    { guid: "e1", date: "2026-01-10", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -90 }, { accountId: 1, amount: 90 }] },
    { guid: "e2", date: "2026-02-09", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -110 }, { accountId: 7, amount: 110 }] },
    { guid: "e3", date: "2026-03-11", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -95 }, { accountId: 7, amount: 95 }] },
  ];
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].debitAccountId, 5);
  assert.equal(candidates[0].occurrences.length, 3);
  assert.equal(candidates[0].suggestedFrequency, "monthly");
  // Credit side defaults to the MOST RECENT occurrence's actual payment source.
  assert.equal(candidates[0].creditAccountId, 7);
});

test("detectRecurringCandidates excludes the House Hold Exps family entirely, even though it rotates to a new ledger each month", () => {
  const txs: DetectTx[] = [
    { guid: "h1", date: "2026-04-03", type: "Payment", narration: "Groceries", entries: [{ accountId: 8, amount: -60 }, { accountId: 1, amount: 60 }] },
    { guid: "h2", date: "2026-04-10", type: "Payment", narration: "Groceries", entries: [{ accountId: 8, amount: -55 }, { accountId: 1, amount: 55 }] },
    { guid: "h3", date: "2026-04-17", type: "Payment", narration: "Groceries", entries: [{ accountId: 8, amount: -58 }, { accountId: 1, amount: 58 }] },
    { guid: "h4", date: "2026-05-04", type: "Payment", narration: "Groceries", entries: [{ accountId: 9, amount: -60 }, { accountId: 1, amount: 60 }] },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates de-dups against an existing template by bill identity, not the exact stored pair -- a template paid from a different card still counts as already set up", () => {
  const txs: DetectTx[] = [
    { guid: "e1", date: "2026-01-10", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -90 }, { accountId: 7, amount: 90 }] },
    { guid: "e2", date: "2026-02-09", type: "Payment", narration: "PG&E", entries: [{ accountId: 5, amount: -110 }, { accountId: 7, amount: 110 }] },
  ];
  const existing: RecurringTemplate[] = [
    {
      id: "t1", label: "PG&E", active: true, frequency: "monthly", voucherType: "Payment",
      narrationTemplate: "{month} PG&E", entries: [{ accountId: 5, amount: -100 }, { accountId: 1, amount: 100 }], postings: [],
    },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, existing, none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates ignores a genuinely irregular, non-recurring pattern even with wide gap tolerance", () => {
  const txs: DetectTx[] = [
    { guid: "r1", date: "2026-01-03", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -52 }, { accountId: 1, amount: 52 }] },
    { guid: "r2", date: "2026-01-08", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -48 }, { accountId: 1, amount: 48 }] },
    { guid: "r3", date: "2026-04-21", type: "Payment", narration: "Groceries", entries: [{ accountId: 4, amount: -61 }, { accountId: 1, amount: 61 }] },
  ];
  assert.equal(detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10").length, 0);
});

test("detectRecurringCandidates excludes transactions older than the lookback window", () => {
  const txs: DetectTx[] = [monthlyTx("2020-01-05", "g1"), monthlyTx("2020-02-05", "g2"), monthlyTx("2020-03-05", "g3")];
  assert.equal(detectRecurringCandidates(txs, accounts, [], none, 12, "2026-07-10").length, 0);
});

test("templateFromCandidate pre-links the current period's own matching occurrence so it doesn't immediately show as due", () => {
  const txs: DetectTx[] = [monthlyTx("2026-05-05", "g1"), monthlyTx("2026-06-05", "g2"), monthlyTx("2026-07-05", "g3")];
  const candidates = detectRecurringCandidates(txs, accounts, [], none, 60, "2026-07-10");
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

test("diagnoseLedger reports 'accepted' with the real computed gap stats for a clean monthly pattern", () => {
  const txs: DetectTx[] = [monthlyTx("2026-04-05", "g1"), monthlyTx("2026-05-05", "g2"), monthlyTx("2026-06-06", "g3"), monthlyTx("2026-07-05", "g4")];
  const results = diagnoseLedger(txs, accounts, [], none, 60, "2026-07-10", "Netflix");
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, "accepted");
  assert.equal(results[0].occurrences.length, 4);
  assert.ok(results[0].avgGapDays !== null && results[0].avgGapDays > 29 && results[0].avgGapDays < 31);
});

test("diagnoseLedger explains a rejection with the actual gap numbers, not just 'no'", () => {
  const txs: DetectTx[] = [monthlyTx("2026-01-03", "g1"), monthlyTx("2026-01-08", "g2"), monthlyTx("2026-04-21", "g3")];
  const results = diagnoseLedger(txs, accounts, [], none, 60, "2026-07-10", "Netflix");
  assert.equal(results.length, 1);
  assert.match(results[0].verdict, /rejected/);
  assert.match(results[0].reason, /\d/); // contains the actual numbers, not a vague message
});

test("diagnoseLedger reports why a multi-leg (3+ entries) voucher never gets considered", () => {
  const txs: DetectTx[] = [
    { guid: "s1", date: "2026-04-05", type: "Payment", narration: "Netflix+tax", entries: [{ accountId: 2, amount: -15 }, { accountId: 4, amount: -0.99 }, { accountId: 1, amount: 15.99 }] },
  ];
  const results = diagnoseLedger(txs, accounts, [], none, 60, "2026-07-10", "Netflix");
  assert.equal(results.length, 1);
  assert.match(results[0].verdict, /not a simple 2-leg voucher/);
});

test("diagnoseLedger reports why House Hold Exps is excluded", () => {
  const txs: DetectTx[] = [
    { guid: "h1", date: "2026-04-03", entries: [{ accountId: 8, amount: -60 }, { accountId: 1, amount: 60 }] },
    { guid: "h2", date: "2026-04-10", entries: [{ accountId: 8, amount: -55 }, { accountId: 1, amount: 55 }] },
  ];
  const results = diagnoseLedger(txs, accounts, [], none, 60, "2026-07-10", "House Hold");
  assert.equal(results.length, 1);
  assert.match(results[0].verdict, /House Hold Exps/);
});

test("diagnoseLedger returns nothing for an empty query", () => {
  assert.deepEqual(diagnoseLedger([monthlyTx("2026-04-05", "g1")], accounts, [], none, 60, "2026-07-10", ""), []);
});

// Real-world shape: a bill with an irregular stretch years ago (missed payment, provider change)
// followed by a long, perfectly regular recent run -- regularity should be judged from the recent
// occurrences, not dragged down by old history. Mirrors the real Waste Management/Electric & Gas
// case confirmed live: both had a rough patch long ago but have been clean for 2+ years since.
function quarterlyTx(date: string, guid: string, amount = 147.42): DetectTx {
  return { guid, date, type: "Payment", narration: "Republic Services", entries: [{ accountId: 10, amount: -amount }, { accountId: 7, amount }] };
}
const accountsWithWaste: DetectAccount[] = [...accounts, { id: 10, name: "Waste Management" }];

test("detectRecurringCandidates judges regularity from RECENT occurrences, not dragged down by an old irregular stretch", () => {
  const txs: DetectTx[] = [
    // An irregular early stretch, including one big ~192-day gap.
    quarterlyTx("2023-02-15", "w1"),
    quarterlyTx("2023-04-10", "w2"),
    quarterlyTx("2023-07-03", "w3"),
    quarterlyTx("2023-10-06", "w4"),
    quarterlyTx("2024-04-15", "w5"), // ~192 days after w4 -- a real gap in payment history
    // Then a long, perfectly regular quarterly run.
    quarterlyTx("2024-07-18", "w6"),
    quarterlyTx("2024-10-18", "w7"),
    quarterlyTx("2025-01-17", "w8"),
    quarterlyTx("2025-04-17", "w9"),
    quarterlyTx("2025-07-18", "w10"),
    quarterlyTx("2025-10-18", "w11"),
    quarterlyTx("2026-01-17", "w12"),
    quarterlyTx("2026-04-17", "w13"),
    quarterlyTx("2026-07-17", "w14"),
    quarterlyTx("2026-10-18", "w15"),
  ];
  const candidates = detectRecurringCandidates(txs, accountsWithWaste, [], none, 60, "2026-10-20");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].suggestedFrequency, "quarterly");
  assert.equal(candidates[0].occurrences.length, 15, "still reports the FULL occurrence history, not just the recent window");
});

test("diagnoseLedger accepts the same old-irregular/recently-clean pattern and notes it used a recent window", () => {
  const txs: DetectTx[] = [
    quarterlyTx("2023-02-15", "w1"), quarterlyTx("2023-04-10", "w2"), quarterlyTx("2023-07-03", "w3"), quarterlyTx("2023-10-06", "w4"),
    quarterlyTx("2024-04-15", "w5"), quarterlyTx("2024-07-18", "w6"), quarterlyTx("2024-10-18", "w7"), quarterlyTx("2025-01-17", "w8"),
    quarterlyTx("2025-04-17", "w9"), quarterlyTx("2025-07-18", "w10"), quarterlyTx("2025-10-18", "w11"), quarterlyTx("2026-01-17", "w12"),
    quarterlyTx("2026-04-17", "w13"), quarterlyTx("2026-07-17", "w14"), quarterlyTx("2026-10-18", "w15"),
  ];
  const results = diagnoseLedger(txs, accountsWithWaste, [], none, 60, "2026-10-20", "Waste Management");
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, "accepted");
  assert.match(results[0].reason, /recent 8 of 15 occurrences/);
});
