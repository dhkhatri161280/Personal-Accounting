import assert from "node:assert/strict";
import test from "node:test";
import { estimateUsFederalTax, computeItemizedDeduction } from "../lib/tax-usa-engine.ts";

// Golden-return test: every input below is a real figure off the taxpayer's actual filed 2025
// Form 1040 (MFJ) -- W-2 box 1 wages, Schedule B interest/dividends, Schedule D short-term gain,
// Form 8889 HSA deduction, Schedule A itemized components, Form 8959/8960 wage/withholding
// figures. Complements tests/tax-ca-itemized-phaseout.test.ts, which already validates the CA
// side against this same return -- this is the federal side's counterpart, not previously tested
// end-to-end against a real return.
//
// One known, deliberate gap: the real return's $391 of qualified dividends got the preferential
// LTCG rate via the Qualified Dividends and Capital Gain Tax Worksheet (Schedule D line 22 =
// "Yes"). This engine's `interestDividendIncome` input doesn't split out the qualified portion --
// it taxes all $393 of interest+dividends as ordinary income, slightly overstating tax by roughly
// (393 * (marginal ordinary rate - 15% LTCG rate)), on the order of tens of dollars at this
// income level. The tolerance below accounts for exactly that, not a bug to chase further.

test("estimateUsFederalTax + computeItemizedDeduction reproduce the real 2025 MFJ filed return", () => {
  const taxYear = "2025";
  const filingStatus = "mfj" as const;

  // Real Schedule A inputs (medical $4,144 fully absorbed by the 7.5%-of-AGI floor; SALT
  // $107,875 state income tax + $15,006 property tax, capped by the OBBBA phase-down to the
  // $10,000 floor at this income; mortgage interest $21,586; charity $100 cash + $350 non-cash).
  const preliminaryAgi = 969_319; // real Form 1040 line 11a/11b
  const itemized = computeItemizedDeduction(taxYear, preliminaryAgi, {
    medicalExpenses: 4_144,
    propertyTax: 15_006,
    stateIncomeTaxPaid: 107_875,
    mortgageInterest: 21_586,
    charitable: 450,
  });
  // Real Schedule A line 17 total.
  assert.equal(itemized.total, 32_036);
  assert.equal(itemized.saltDeductible, 10_000, "SALT phased all the way down to the $10,000 floor at this AGI");

  const result = estimateUsFederalTax({
    taxYear,
    filingStatus,
    wages: 956_552, // W-2 box 1
    federalWithheld: 193_169, // W-2 box 2 (NOT the Additional Medicare Tax withholding -- see medicareWithheld below)
    medicareWages: 974_318, // W-2 box 5
    medicareWithheld: 21_096, // W-2 box 6
    interestDividendIncome: 2 + 391, // Schedule B: taxable interest + ordinary dividends
    shortTermGainTaxable: 17_544, // Schedule D Part I (RSU/ESPP sales)
    longTermGainTaxable: 0,
    aboveLineDeduction: 5_170, // Form 8889 HSA deduction
    itemizedDeduction: itemized.total,
  });

  // Real Form 1040 line 11a/11b (AGI).
  assert.equal(result.agi, 969_319);
  // Real Form 1040 line 12e (itemized beat the $31,500 MFJ standard deduction).
  assert.equal(result.usedItemized, true);
  assert.equal(result.deductionUsed, 32_036);
  // Real Form 1040 line 15 (taxable income).
  assert.equal(result.taxableOrdinary, 937_283);
  // Real Form 1040 line 16 (tax) -- see the qualified-dividend gap noted above.
  const realTaxLine16 = 270_791;
  assert.ok(
    Math.abs(result.ordinaryTax + result.ltcgTax - realTaxLine16) < 150,
    `expected close to ${realTaxLine16}, got ${result.ordinaryTax + result.ltcgTax}`
  );
  // Real Form 8959 line 18 (Additional Medicare Tax) / Schedule 2 line 11.
  assert.ok(Math.abs(result.additionalMedicareTax - 6_519) < 1);
  // Real Form 8960 line 17 (NIIT) / Schedule 2 line 12.
  assert.ok(Math.abs(result.niit - 682) < 1);
  // Real Form 1040 line 24 (total tax) -- 270,791 + 6,519 + 682 = 277,992.
  const realTotalTax = 277_992;
  assert.ok(
    Math.abs(result.estimatedTax - realTotalTax) < 150,
    `expected close to ${realTotalTax}, got ${result.estimatedTax}`
  );
  // Real Form 1040 line 25d (total withholding, W-2 fed withholding + Additional Medicare Tax
  // withholding reconciled via Form 8959 Part V) -- the engine derives the Additional Medicare
  // Tax withholding itself from medicareWages/medicareWithheld, it isn't a separate input.
  const realTotalWithholding = 200_137;
  assert.ok(Math.abs(result.federalWithheld + result.additionalMedicareWithheld - realTotalWithholding) < 1);
});
