import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  pendingDepreciationMonths,
  depreciationStartDate,
  round2,
} from "../lib/fixed-assets.ts";
import type { FixedAsset } from "../lib/vault-types.ts";

function asset(overrides: Partial<FixedAsset> = {}): FixedAsset {
  return {
    id: "a1",
    name: "Laptop",
    accountId: 1,
    purchaseDate: "2026-01-15",
    cost: 1200,
    salvageValue: 0,
    usefulLifeMonths: 12,
    ...overrides,
  };
}

test("monthlyDepreciation: straight-line over useful life, net of salvage", () => {
  assert.equal(monthlyDepreciation(asset()), 100);
  assert.equal(monthlyDepreciation(asset({ cost: 1300, salvageValue: 100, usefulLifeMonths: 12 })), 100);
});

test("monthlyDepreciation: non-depreciable (usefulLifeMonths 0) returns 0, no divide-by-zero", () => {
  assert.equal(monthlyDepreciation(asset({ usefulLifeMonths: 0 })), 0);
});

test("accumulatedDepreciation: counts only fully-elapsed months, caps at useful life", () => {
  assert.equal(accumulatedDepreciation(asset(), "2026-03-15"), 200); // Jan+Feb fully elapsed
  assert.equal(accumulatedDepreciation(asset(), "2027-06-01"), 1200); // well past 12 months, capped
});

test("depreciationStartDate: falls back to purchaseDate when inServiceDate isn't set", () => {
  assert.equal(depreciationStartDate(asset()), "2026-01-15");
});

test("depreciationStartDate: prefers inServiceDate when set (e.g. a home's EMD predates possession)", () => {
  assert.equal(depreciationStartDate(asset({ inServiceDate: "2022-12-28" })), "2022-12-28");
});

test("accumulatedDepreciation: uses inServiceDate, not purchaseDate, as the depreciation start when set", () => {
  const a = asset({ purchaseDate: "2021-10-27", inServiceDate: "2022-12-28", usefulLifeMonths: 60, cost: 6000 });
  // As of the in-service date itself: 0 months elapsed, nothing accrued yet -- even though
  // purchaseDate was over a year earlier.
  assert.equal(accumulatedDepreciation(a, "2022-12-28"), 0);
  // One full month after in-service (Jan 28 2023): exactly one month's depreciation.
  assert.equal(accumulatedDepreciation(a, "2023-01-28"), 100);
});

test("accumulatedDepreciation: caps at disposal date, not asOfDate, when disposed", () => {
  const disposedAsset = asset({ disposed: { date: "2026-04-10", proceeds: 500 } });
  // asOfDate is much later, but accumulation should stop at the disposal month
  assert.equal(accumulatedDepreciation(disposedAsset, "2027-01-01"), 300); // Jan+Feb+Mar
});

test("accumulatedDepreciation: fully-elapsed asset lands on the exact depreciable base, not a rounding-residue undershoot", () => {
  // 7000/36 = 194.4444... -> monthly rounds to 194.44, and 194.44 * 36 = 6999.84, 16 cents short of
  // 7000 -- accumulatedDepreciation must still report the full 7000 once every month has elapsed,
  // the same way a real last-period depreciation voucher absorbs that residue.
  const a = asset({ cost: 7000, salvageValue: 0, usefulLifeMonths: 36 });
  assert.equal(monthlyDepreciation(a), 194.44);
  assert.equal(accumulatedDepreciation(a, "2030-01-15"), 7000);
  assert.equal(bookValue(a, "2030-01-15"), 0);
});

test("bookValue: cost minus accumulated depreciation", () => {
  assert.equal(bookValue(asset(), "2026-03-15"), 1000);
});

test("pendingDepreciationMonths: first run posts all fully-elapsed months since purchase", () => {
  const pending = pendingDepreciationMonths(asset(), "2026-03-15");
  assert.deepEqual(pending, [
    { yearMonth: "2026-01", amount: 100 },
    { yearMonth: "2026-02", amount: 100 },
  ]);
});

test("pendingDepreciationMonths: incremental run only posts new months, matches accumulatedDepreciation", () => {
  const a = asset({ lastDepreciatedThrough: "2026-02" });
  const pending = pendingDepreciationMonths(a, "2026-04-10");
  assert.deepEqual(pending, [{ yearMonth: "2026-03", amount: 100 }]);
  assert.equal(pending.reduce((s, p) => s + p.amount, 0), accumulatedDepreciation(a, "2026-04-10") - 200);
});

test("pendingDepreciationMonths: nothing pending in the same month as last run", () => {
  const a = asset({ lastDepreciatedThrough: "2026-02" });
  assert.deepEqual(pendingDepreciationMonths(a, "2026-03-05"), []);
});

test("pendingDepreciationMonths: stops at useful life even if throughDate is much later", () => {
  const a = asset({ usefulLifeMonths: 2 });
  const pending = pendingDepreciationMonths(a, "2027-01-01");
  assert.equal(pending.length, 2);
  assert.equal(pending.reduce((s, p) => s + p.amount, 0), 1200);
});

test("pendingDepreciationMonths: a one-shot catch-up spanning the whole useful life posts the exact depreciable base, not a rounding-residue shortfall", () => {
  // 446000/60 = 7433.3333... -> monthly rounds to 7433.33, and 60 * 7433.33 = 445999.80, 20 cents
  // short of 446000 -- the final month must absorb that residue so the total posted matches
  // accumulatedDepreciation exactly (the real bug reported live: report showed accum. dep. of
  // 446000 exactly, but the one-shot catch-up run's preview totaled 445999.80).
  const a = asset({ cost: 446000, salvageValue: 0, usefulLifeMonths: 60, purchaseDate: "2014-04-13" });
  const pending = pendingDepreciationMonths(a, "2026-09-09");
  assert.equal(pending.length, 60);
  const total = round2(pending.reduce((s, p) => s + p.amount, 0));
  assert.equal(total, 446000);
  assert.equal(total, accumulatedDepreciation(a, "2026-09-09"));
});

test("pendingDepreciationMonths: nothing pending once fully depreciated and re-run later", () => {
  const a = asset({ usefulLifeMonths: 2, lastDepreciatedThrough: "2026-02" });
  assert.deepEqual(pendingDepreciationMonths(a, "2027-01-01"), []);
});
