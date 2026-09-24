import assert from "node:assert/strict";
import test from "node:test";
import { periodBoundariesForRange } from "../lib/columnar-report.ts";

test("periodBoundariesForRange yearly: one period per fiscal year (Apr-start), spanning a multi-year range", () => {
  const periods = periodBoundariesForRange("2023-06-15", "2026-09-23", "yearly");
  // 2023-06 falls in FY2023 (Apr23-Mar24); 2026-09 falls in FY2026 (Apr26-Mar27) -- 4 FYs total.
  assert.deepEqual(periods.map((p) => p.key), ["2023", "2024", "2025", "2026"]);
  assert.deepEqual(periods.map((p) => p.label), ["FY23-24", "FY24-25", "FY25-26", "FY26-27"]);
});

test("periodBoundariesForRange yearly: a January date belongs to the FY that STARTED the previous April, not the calendar year", () => {
  // Jan 2026 is in FY2025 (Apr 2025 - Mar 2026), not FY2026.
  const periods = periodBoundariesForRange("2026-01-10", "2026-01-20", "yearly");
  assert.equal(periods.length, 1);
  assert.equal(periods[0].key, "2025");
  assert.equal(periods[0].label, "FY25-26");
});

test("periodBoundariesForRange yearly: partial first/last years use the real range edges, not the full FY bounds", () => {
  const periods = periodBoundariesForRange("2025-06-10", "2026-08-20", "yearly");
  assert.equal(periods.length, 2);
  // First FY (2025) is clipped to the actual range start, not backdated to 2025-04-01.
  assert.equal(periods[0].start, "2025-06-01");
  assert.equal(periods[0].end, "2026-03-31");
  // Last FY (2026) is clipped to the actual range end, not extended to 2027-03-31.
  assert.equal(periods[1].start, "2026-04-01");
  assert.equal(periods[1].end, "2026-08-31");
});

test("periodBoundariesForRange yearly: a range fully inside one fiscal year produces exactly one period", () => {
  const periods = periodBoundariesForRange("2026-05-01", "2026-11-30", "yearly");
  assert.equal(periods.length, 1);
  assert.equal(periods[0].label, "FY26-27");
});

// Regression guard: yearly must not disturb the already-relied-on monthly/quarterly behavior.
test("periodBoundariesForRange: monthly and quarterly still behave as before", () => {
  const monthly = periodBoundariesForRange("2026-04-01", "2026-06-30", "monthly");
  assert.deepEqual(monthly.map((p) => p.key), ["2026-04", "2026-05", "2026-06"]);
  const quarterly = periodBoundariesForRange("2026-04-01", "2026-09-30", "quarterly");
  assert.deepEqual(quarterly.map((p) => p.key), ["2026-Q1", "2026-Q2"]);
});
