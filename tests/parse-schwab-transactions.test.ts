import assert from "node:assert/strict";
import test from "node:test";
import { findUnpairedPositiveJournalActivities } from "../lib/parse-schwab-transactions.ts";
import type { SchwabActivity } from "../lib/parse-schwab-transactions.ts";

function activity(overrides: Partial<SchwabActivity> & { activityId: number }): SchwabActivity {
  return {
    time: "2026-09-03T00:00:00Z",
    accountNumber: "acc1",
    type: "JOURNAL",
    netAmount: 0,
    transferItems: [],
    ...overrides,
  };
}

test("a real dividend is NOT canceled by an unrelated same-amount sweep pair (the actual bug from this session)", () => {
  const activities = [
    activity({ activityId: 1, description: "BANK SWEEP FR BROKERAGE", netAmount: 82.7 }),
    activity({ activityId: 2, description: "BROKERAGE SWEEP TO BANK", netAmount: -82.7 }),
    activity({ activityId: 3, description: "JOURNAL FRM 85009790", netAmount: 82.7 }),
  ];
  const result = findUnpairedPositiveJournalActivities(activities);
  assert.equal(result.length, 1);
  assert.equal(result[0].activityId, 3);
});

test("a genuine sweep pair (equal and opposite, same day) is fully excluded", () => {
  const activities = [
    activity({ activityId: 1, netAmount: 50 }),
    activity({ activityId: 2, netAmount: -50 }),
  ];
  assert.deepEqual(findUnpairedPositiveJournalActivities(activities), []);
});

test("non-JOURNAL activities are ignored even if they'd otherwise look unpaired", () => {
  const activities = [activity({ activityId: 1, type: "TRADE", netAmount: 100 })];
  assert.deepEqual(findUnpairedPositiveJournalActivities(activities), []);
});

test("a negative on a different day cannot pair with a positive (same-day requirement)", () => {
  const activities = [
    activity({ activityId: 1, netAmount: 30, time: "2026-09-03T00:00:00Z" }),
    activity({ activityId: 2, netAmount: -30, time: "2026-09-04T00:00:00Z" }),
  ];
  const result = findUnpairedPositiveJournalActivities(activities);
  assert.equal(result.length, 1);
  assert.equal(result[0].activityId, 1);
});

test("each negative can only consume one positive, even with three same-day/same-amount candidates", () => {
  const activities = [
    activity({ activityId: 1, netAmount: 10 }),
    activity({ activityId: 2, netAmount: 10 }),
    activity({ activityId: 3, netAmount: -10 }),
  ];
  const result = findUnpairedPositiveJournalActivities(activities);
  assert.equal(result.length, 1); // one positive gets paired off, the other stays unpaired/flagged
});
