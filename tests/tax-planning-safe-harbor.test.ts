import assert from "node:assert/strict";
import test from "node:test";
import { computeTaxPlanningScenarios, type TaxPlanningInput } from "../lib/tax-planning.ts";

// Real 2025 filed-return income figures (same household as the golden-return tests) projected
// forward onto a 2026 taxYear, so FEDERAL_PRIOR_YEAR_RETURNS["2025"]/CA_PRIOR_YEAR_RETURNS["2025"]
// (the real filed 2025 return) apply as "last year" for the safe-harbor test -- todayIso is set
// past year-end so periodsRemaining is 0 and fullYear*Withheld equals the totalFederal/totalStateWH
// inputs exactly, not a projection.
function baseInput(overrides: Partial<TaxPlanningInput> = {}): TaxPlanningInput {
  return {
    taxYear: "2026",
    filingStatus: "mfj",
    stateCode: "CA",
    stateName: "California",
    longTermHoldingDays: 365,
    taxableWages: 956_552,
    totalGross: 974_318,
    totalFederal: 193_169,
    totalMedicare: 21_096,
    interestDividendIncome: 393,
    shortTermGainTaxable: 17_544,
    longTermGainTaxable: 0,
    capitalLossDeduction: 0,
    federalItemizedTotal: 32_036,
    hsaContributionTotal: 5_170,
    hsaCoverage: "family",
    totalK401: 17_767,
    totalStateWH: 105_175,
    stateItemizedTotal: 11_517,
    stateHsaConforms: false,
    baselineFederalStandardDeduction: 31_500,
    totalEsppYtd: 0,
    lastPeriod: null,
    grants: [],
    esppPurchases: [],
    livePrice: null,
    todayIso: "2026-12-31",
    ...overrides,
  };
}

test("federal safe-harbor check flags the same shortfall shape that caused the real 2025 $473.78 penalty", () => {
  // totalFederal here (193,169) is the real 2025 W-2 federal withholding -- the same figure that,
  // in reality, fell short of the safe-harbor requirement and triggered a real underpayment
  // penalty on the actual filed return.
  const { scenarios } = computeTaxPlanningScenarios(baseInput());
  const check = scenarios.find((s) => s.id === "withholding-check");
  assert.ok(check);
  assert.equal(check!.actionable, true);
  assert.match(check!.title, /underpayment penalty/i);
  assert.match(check!.description, /safe-harbor/i);
  assert.match(check!.description, /110%/, "prior-year AGI ($969,319) is above the $150,000 threshold");
  assert.match(check!.caveat || "", /IRC §6654/);
});

test("federal safe-harbor check clears once withholding covers the real safe-harbor amount", () => {
  // 90% of a ~$278k projected tax is roughly $250k -- $260k withheld comfortably clears it.
  const { scenarios } = computeTaxPlanningScenarios(baseInput({ totalFederal: 260_000 }));
  const check = scenarios.find((s) => s.id === "withholding-check");
  assert.ok(check);
  assert.equal(check!.actionable, false);
  assert.match(check!.title, /on track/i);
});

test("CA safe-harbor check flags a shortfall using the real 2025 filed CA return", () => {
  const { scenarios } = computeTaxPlanningScenarios(baseInput({ totalStateWH: 50_000 }));
  const check = scenarios.find((s) => s.id === "state-withholding-check");
  assert.ok(check);
  assert.equal(check!.actionable, true);
  assert.match(check!.title, /underpayment penalty/i);
  assert.match(check!.caveat || "", /FTB Form 5805/);
});

test("falls back to the flat-dollar rule-of-thumb for a tax year with no prior-year actual on hand", () => {
  // 2024 has no 2023 entry in FEDERAL_PRIOR_YEAR_RETURNS -- must fall back, not silently compute
  // a wrong real safe-harbor number from missing data.
  const { scenarios } = computeTaxPlanningScenarios(
    baseInput({ taxYear: "2024", todayIso: "2024-12-31", totalFederal: 50_000 })
  );
  const check = scenarios.find((s) => s.id === "withholding-check");
  assert.ok(check);
  assert.match(check!.caveat || "", /doesn't yet have 2023's filed tax/);
});
