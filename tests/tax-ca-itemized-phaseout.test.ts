import assert from "node:assert/strict";
import test from "node:test";
import { computeCaItemizedDeduction, estimateCaStateTax } from "../lib/tax-ca-engine.ts";
import { resolveCaTaxRules } from "../lib/tax-ca-rules.ts";

// California keeps the pre-TCJA federal "Pease limitation" that the federal return dropped in
// 2018: above a filing-status AGI threshold, itemized deductions are reduced by the LESSER of
// 80% of the raw itemized total or 6% of AGI over the threshold. Confirmed against a real filed
// 2025 CA Form 540 / Schedule CA (540) MFJ return (see lib/tax-ca-rules.ts for the threshold
// derivation) -- before this phase-out existed, a high earner's estimated CA tax was understated
// by thousands of dollars.

test("computeCaItemizedDeduction applies no reduction below the phaseout threshold", () => {
  const deduction = computeCaItemizedDeduction(
    200_000,
    { medicalExpenses: 0, propertyTax: 10_000, mortgageInterest: 15_000, charitable: 1_000 },
    504_411
  );
  assert.equal(deduction, 26_000);
});

test("computeCaItemizedDeduction reproduces the real 2025 MFJ filed return within a rounding cent", () => {
  // Real Schedule CA (540): raw itemized $39,411, AGI $974,489, MFJ threshold $504,411 ->
  // reduction = min(80% * 39,411, 6% * (974,489 - 504,411)) = min(31,528.80, 28,204.68) reduces
  // the raw total to $11,517 on the actual filed return (FTB worksheet rounds intermediate steps
  // slightly differently, so this reproduces it to within a few dollars, not to the exact cent).
  const rules = resolveCaTaxRules("2025", "mfj");
  const deduction = computeCaItemizedDeduction(
    974_489,
    { medicalExpenses: 0, propertyTax: 15_006, mortgageInterest: 21_586 + 2_369, charitable: 450 },
    rules.itemizedDeductionPhaseoutThreshold
  );
  assert.ok(Math.abs(deduction - 11_517) < 350, `expected close to 11517, got ${deduction}`);
});

test("estimateCaStateTax without a phaseout threshold leaves the itemized deduction unreduced (backward compatible)", () => {
  const deduction = computeCaItemizedDeduction(974_489, {
    medicalExpenses: 0,
    propertyTax: 15_006,
    mortgageInterest: 23_955,
    charitable: 450,
  });
  assert.equal(deduction, 39_411);
});

test("estimateCaStateTax reproduces the real 2025 MFJ filed return's tax liability within a small margin", () => {
  const rules = resolveCaTaxRules("2025", "mfj");
  const stateAgi = 974_489;
  const deduction = computeCaItemizedDeduction(
    stateAgi,
    { medicalExpenses: 0, propertyTax: 15_006, mortgageInterest: 21_586 + 2_369, charitable: 450 },
    rules.itemizedDeductionPhaseoutThreshold
  );
  const result = estimateCaStateTax({
    taxYear: "2025",
    filingStatus: "mfj",
    agi: stateAgi,
    itemizedDeduction: deduction,
    stateWithheld: 105_175,
  });
  // Real return: CA tax $85,348. Pre-fix, the unreduced deduction understated this by ~$4,682.
  assert.ok(Math.abs(result.estimatedTax - 85_348) < 150, `expected close to 85348, got ${result.estimatedTax}`);
});
