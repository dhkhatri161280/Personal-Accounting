import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  pendingDepreciationMonths,
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

test("accumulatedDepreciation: caps at disposal date, not asOfDate, when disposed", () => {
  const disposedAsset = asset({ disposed: { date: "2026-04-10", proceeds: 500 } });
  // asOfDate is much later, but accumulation should stop at the disposal month
  assert.equal(accumulatedDepreciation(disposedAsset, "2027-01-01"), 300); // Jan+Feb+Mar
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

test("pendingDepreciationMonths: nothing pending once fully depreciated and re-run later", () => {
  const a = asset({ usefulLifeMonths: 2, lastDepreciatedThrough: "2026-02" });
  assert.deepEqual(pendingDepreciationMonths(a, "2027-01-01"), []);
});
