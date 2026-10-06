import assert from "node:assert/strict";
import test from "node:test";
import { computeTaxPlanningScenarios, type TaxPlanningInput } from "../lib/tax-planning.ts";

function baseInput(overrides: Partial<TaxPlanningInput> = {}): TaxPlanningInput {
  return {
    taxYear: "2025",
    filingStatus: "mfj",
    stateCode: "CA",
    stateName: "California",
    longTermHoldingDays: 365,
    taxableWages: 0,
    totalGross: 0,
    totalFederal: 0,
    totalMedicare: 0,
    interestDividendIncome: 0,
    shortTermGainTaxable: 0,
    longTermGainTaxable: 0,
    capitalLossDeduction: 0,
    federalItemizedTotal: 0,
    hsaContributionTotal: 0,
    hsaCoverage: "family",
    totalK401: 0,
    totalStateWH: 0,
    stateItemizedTotal: 0,
    stateHsaConforms: false,
    baselineFederalStandardDeduction: 31_500,
    totalEsppYtd: 0,
    lastPeriod: null,
    grants: [],
    esppPurchases: [],
    livePrice: null,
    todayIso: "2025-10-05",
    ...overrides,
  };
}

test("backdoor-roth scenario surfaces once projected income is above the Roth MAGI ceiling (MFJ)", () => {
  // Real 2025 filed-return figures -- same household used for the golden-return tests.
  const { scenarios } = computeTaxPlanningScenarios(
    baseInput({
      taxableWages: 956_552,
      totalGross: 974_318,
      totalFederal: 193_169,
      totalMedicare: 21_096,
      interestDividendIncome: 393,
      shortTermGainTaxable: 17_544,
      federalItemizedTotal: 32_036,
      hsaContributionTotal: 5_170,
      totalK401: 17_767,
      totalStateWH: 105_175,
      stateItemizedTotal: 11_517,
    })
  );
  const roth = scenarios.find((s) => s.id === "backdoor-roth");
  assert.ok(roth, "expected a backdoor-roth scenario at this income level");
  assert.equal(roth!.actionable, true);
  assert.equal(roth!.hypothetical, true);
  assert.equal(roth!.totalSavings, 0, "no current-year deduction -- this is a future-growth play, not a tax cut");
  assert.match(roth!.title, /\$14,000/, "MFJ: $7,000 x 2 spouses");
  assert.match(roth!.caveat ?? "", /pro-rata/i, "must warn about the pro-rata rule pitfall");
});

test("backdoor-roth scenario does NOT appear for a household under the Roth MAGI ceiling", () => {
  const { scenarios } = computeTaxPlanningScenarios(
    baseInput({
      taxableWages: 150_000,
      totalGross: 150_000,
      totalFederal: 20_000,
      totalMedicare: 2_175,
      totalK401: 10_000,
      baselineFederalStandardDeduction: 31_500,
    })
  );
  assert.equal(scenarios.find((s) => s.id === "backdoor-roth"), undefined, "under the ceiling, a direct Roth contribution works -- no backdoor needed");
});
