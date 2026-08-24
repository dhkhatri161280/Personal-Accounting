import { section24bHomeLoanInterestCap } from "./india-tax-slabs";

export interface HousePropertyResult {
  isLetOut: boolean;
  standardDeduction: number; // 30% of rent under Section 24(a) -- 0 for a self-occupied property
  interestDeduction: number; // amount of home loan interest actually deductible
  interestCapped: boolean; // true if a self-occupied cap reduced the raw interest entered
  netIncome: number; // rent - standard deduction - interest -- can be negative (a house property loss)
  allowedAgainstOtherIncome: number; // netIncome after the year-aware loss set-off cap
  lossCarriedForward: number; // any loss beyond what could be set off this year
}

/** "Income from House Property" under Indian income tax, year-aware:
 * - Self-occupied (no rent): home loan interest is deductible under Section 24(b) up to the
 *   statutory cap (Rs 1,50,000 through AY2014-15, Rs 2,00,000 from AY2015-16).
 * - Let-out (any rent received): a flat 30% standard deduction applies to the rent under
 *   Section 24(a), and the home loan interest deduction under 24(b) is UNCAPPED -- the
 *   self-occupied ceiling only applies when there's no rental income.
 * - A resulting loss can be set off against other income heads (salary, etc.) without limit for
 *   years through AY2017-18; from AY2018-19 onward (Finance Act 2017, Section 71(3A)) that
 *   set-off is capped at Rs 2,00,000/year, with any excess carried forward to later years
 *   (carry-forward isn't tracked here, just reported so it isn't silently dropped). */
export function computeHouseProperty(assessmentYear: string, rentIncome: number, homeLoanInterestRaw: number): HousePropertyResult {
  const isLetOut = rentIncome > 0;
  const standardDeduction = isLetOut ? Math.round(rentIncome * 0.3) : 0;
  const cap = section24bHomeLoanInterestCap(assessmentYear);
  const interestDeduction = isLetOut ? homeLoanInterestRaw : Math.min(homeLoanInterestRaw, cap);
  const interestCapped = !isLetOut && homeLoanInterestRaw > cap;
  const netIncome = rentIncome - standardDeduction - interestDeduction;

  const startYear = Number(assessmentYear.slice(0, 4));
  const setOffCap = Number.isFinite(startYear) && startYear >= 2018 ? 200000 : Infinity;
  let allowedAgainstOtherIncome = netIncome;
  let lossCarriedForward = 0;
  if (netIncome < 0 && Number.isFinite(setOffCap) && -netIncome > setOffCap) {
    allowedAgainstOtherIncome = -setOffCap;
    lossCarriedForward = -netIncome - setOffCap;
  }

  return { isLetOut, standardDeduction, interestDeduction, interestCapped, netIncome, allowedAgainstOtherIncome, lossCarriedForward };
}
