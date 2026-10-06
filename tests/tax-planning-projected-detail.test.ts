import assert from "node:assert/strict";
import test from "node:test";
import { computeFullYearProjection, type TaxPlanningInput } from "../lib/tax-planning.ts";

// Validates the fields TaxReport.tsx's "1040 & [state] Preview (Projected Full Year)" modal
// reads off FullYearProjection -- projectedDeductionUsed/projectedUsedItemized/
// projectedTaxableOrdinary/projectedOrdinaryTax/projectedLtcgTax/projectedNiit/
// projectedAdditionalMedicareTax/projectedState. Uses a todayIso AFTER the tax year ends, so
// periodsRemaining is 0 and the "projection" has nothing left to extrapolate -- it should
// collapse to exactly the same numbers as the real filed 2025 return (same golden figures as
// tests/tax-federal-golden-return.test.ts and tests/tax-ca-itemized-phaseout.test.ts).

test("FullYearProjection's detail fields reconcile with the real 2025 filed return once the year is over", () => {
  const input: TaxPlanningInput = {
    taxYear: "2025",
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
    todayIso: "2026-04-01", // well after 2025-12-31 -- nothing left to project
  };

  const proj = computeFullYearProjection(input);

  assert.equal(proj.periodsRemaining, 0);
  // $1 of real-world slop: the test's totalGross input matches the real W-2 box 5 (Medicare
  // wages), which isn't exactly box 1 + 401(k) on NVIDIA's own payroll statement either.
  assert.ok(Math.abs(proj.projectedTaxableWages - 956_552) < 2);
  assert.ok(Math.abs(proj.projectedAgi - 969_319) < 2); // real Form 1040 line 11a/11b
  assert.equal(proj.projectedUsedItemized, true);
  assert.equal(proj.projectedDeductionUsed, 32_036); // real Schedule A line 17
  assert.ok(Math.abs(proj.projectedTaxableOrdinary + proj.projectedLongTermGain - 937_283) < 2); // real line 15
  assert.ok(Math.abs(proj.projectedOrdinaryTax + proj.projectedLtcgTax - 270_791) < 150); // real line 16
  assert.ok(Math.abs(proj.projectedNiit - 682) < 1); // real Form 8960 line 17
  assert.ok(Math.abs(proj.projectedAdditionalMedicareTax - 6_519) < 1); // real Form 8959 line 18
  assert.ok(Math.abs(proj.projectedFederalTax - 277_992) < 150); // real Form 1040 line 24

  // CA side -- real Schedule CA (540) / Form 540.
  assert.equal(proj.projectedState.usedItemized, true);
  assert.ok(Math.abs(proj.projectedState.deductionUsed - 11_517) < 350); // real line 18 (phased down)
  assert.ok(Math.abs(proj.projectedState.taxableIncome - 962_972) < 350); // real line 19
  assert.ok(Math.abs(proj.projectedState.estimatedTax - 85_348) < 150); // real line 64
});
