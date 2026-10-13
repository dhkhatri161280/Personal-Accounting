import assert from "node:assert/strict";
import test from "node:test";
import {
  addMonthsIso,
  computeCostcoRewardWindow,
  isQualifyingCostcoNarration,
  computeCostcoRewardEstimate,
  COSTCO_REWARD_CAP,
} from "../lib/costco-reward.ts";
import type { Tx } from "../lib/vault-types.ts";

function tx(id: number, date: string, narration: string, amount: number, type = "Payment"): Tx {
  return {
    id,
    guid: `v${id}`,
    date,
    number: String(id),
    type,
    narration,
    historical: false,
    entries: [
      { accountId: 1, accountName: "House Hold Exps - X", amount: -amount },
      { accountId: 2, accountName: "AMEX Credit Card", amount },
    ],
  };
}

test("addMonthsIso: real member case -- Aug 31 minus 3 months lands on May 31", () => {
  assert.equal(addMonthsIso("2027-08-31", -3), "2027-05-31");
});

test("addMonthsIso: clamps an overflowing day to the target month's real last day", () => {
  // Mar 31 minus 1 month would be "Feb 31", which doesn't exist -- must clamp to Feb 28/29.
  assert.equal(addMonthsIso("2027-03-31", -1), "2027-02-28");
});

test("computeCostcoRewardWindow: matches the real renewal-notice case (renews 08-31, no year needed)", () => {
  // Before the cutoff (*-05-31): still accruing toward the window ending there.
  const before = computeCostcoRewardWindow("08-31", "2027-01-15");
  assert.deepEqual(before, { start: "2026-05-31", end: "2027-05-31", cutoffDate: "2027-05-31" });

  // On/after the cutoff: already into the NEXT cycle, accruing toward next year's reward.
  const after = computeCostcoRewardWindow("08-31", "2027-06-15");
  assert.deepEqual(after, { start: "2027-05-31", end: "2028-05-31", cutoffDate: "2028-05-31" });

  // Same renewal month/day, a year later -- must keep working with no field update at all.
  const yearLater = computeCostcoRewardWindow("08-31", "2028-01-15");
  assert.deepEqual(yearLater, { start: "2027-05-31", end: "2028-05-31", cutoffDate: "2028-05-31" });
});

test("isQualifyingCostcoNarration: excludes Costco Gas, includes everything else Costco", () => {
  assert.equal(isQualifyingCostcoNarration("Shopping @ Costco"), true);
  assert.equal(isQualifyingCostcoNarration("Costco Gas"), false);
  assert.equal(isQualifyingCostcoNarration("Costco Fuel Station"), false);
  assert.equal(isQualifyingCostcoNarration("Gas at Costco"), false);
  assert.equal(isQualifyingCostcoNarration("Safeway"), false);
});

test("computeCostcoRewardEstimate: sums qualifying spend, excludes gas, subtracts refunds, caps at $1,250", () => {
  const transactions: Tx[] = [
    tx(1, "2026-06-01", "Shopping @ Costco", 1000), // qualifies
    tx(2, "2026-06-15", "Costco Gas", 80), // excluded (gas)
    tx(3, "2026-07-01", "Shopping @ Costco", 200, "Receipt"), // refund -- subtracts
    tx(4, "2026-12-01", "Safeway", 300), // unrelated merchant, excluded
    tx(5, "2025-01-01", "Shopping @ Costco", 5000), // outside the window
  ];
  const result = computeCostcoRewardEstimate(transactions, "2026-05-31", "2027-05-31");
  assert.equal(result.qualifyingSpend, 800); // 1000 - 200 refund
  assert.equal(result.estimatedReward, 16); // 2% of 800
  assert.equal(result.capped, false);
  assert.equal(result.voucherCount, 2); // the purchase + the refund, not the gas/unrelated/out-of-window ones
});

test("computeCostcoRewardEstimate: caps the estimate at $1,250 even when 2% of spend exceeds it", () => {
  const transactions: Tx[] = [tx(1, "2026-06-01", "Shopping @ Costco", 100_000)];
  const result = computeCostcoRewardEstimate(transactions, "2026-05-31", "2027-05-31");
  assert.equal(result.estimatedReward, COSTCO_REWARD_CAP);
  assert.equal(result.capped, true);
});
