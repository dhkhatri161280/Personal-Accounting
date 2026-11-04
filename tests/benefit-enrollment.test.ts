import assert from "node:assert/strict";
import test from "node:test";
import { mergeBenefitEnrollmentYear, removeBenefitEnrollmentYear, costPerMonth, costPerYear, DEFAULT_PAY_PERIODS_PER_YEAR } from "../lib/benefit-enrollment.ts";
import type { BenefitEnrollmentYear } from "../lib/vault-types.ts";

function year(overrides: Partial<BenefitEnrollmentYear> = {}): BenefitEnrollmentYear {
  return {
    year: 2027,
    payPeriodsPerYear: DEFAULT_PAY_PERIODS_PER_YEAR,
    totalCostPerPayPeriod: 208,
    categories: [{ category: "Medical", planName: "Kaiser CA HMO", costPerPayPeriod: 158 }],
    uploadedAt: "2026-11-04T00:00:00Z",
    source: "parsed",
    ...overrides,
  };
}

test("mergeBenefitEnrollmentYear: a new year is added, sorted newest first", () => {
  const merged = mergeBenefitEnrollmentYear([year({ year: 2026 })], year({ year: 2027 }));
  assert.deepEqual(merged.map((y) => y.year), [2027, 2026]);
});

test("mergeBenefitEnrollmentYear: re-saving the same year replaces it, not appends", () => {
  const existing = [year({ year: 2027, totalCostPerPayPeriod: 100 })];
  const merged = mergeBenefitEnrollmentYear(existing, year({ year: 2027, totalCostPerPayPeriod: 208 }));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].totalCostPerPayPeriod, 208);
});

test("removeBenefitEnrollmentYear: removes only the targeted year", () => {
  const existing = [year({ year: 2026 }), year({ year: 2027 })];
  const result = removeBenefitEnrollmentYear(existing, 2026);
  assert.deepEqual(result.map((y) => y.year), [2027]);
});

test("costPerMonth/costPerYear: derives from costPerPayPeriod * payPeriodsPerYear", () => {
  const y = year({ payPeriodsPerYear: 24 });
  assert.equal(costPerYear(y, 158), 158 * 24);
  assert.equal(costPerMonth(y, 158), (158 * 24) / 12);
});
