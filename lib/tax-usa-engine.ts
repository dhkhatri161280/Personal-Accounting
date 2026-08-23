import { resolveUsTaxRules, type UsBracket, type UsFilingStatus, type UsTaxRules } from "./tax-usa-rules";

/** Progressive bracket math — ported from the reference implementation. */
export function applyBrackets(income: number, brackets: UsBracket[]): number {
  let remaining = Math.max(0, income);
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const top = b.upTo ?? Number.POSITIVE_INFINITY;
    const width = Math.max(0, Math.min(remaining, top - prev));
    tax += width * b.rate;
    remaining -= width;
    prev = top;
    if (remaining <= 0) break;
  }
  return tax;
}

export interface TaxEstimateInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  /** W-2 wages, already includes RSU-vest and ESPP-discount ordinary income (both are taxed
   * as wages at vest/purchase time, not as capital gains). */
  wages: number;
  federalWithheld: number;
  /** Short-term capital gain that survived Schedule D-style netting (>= 0) — taxed as
   * ordinary income. */
  shortTermGainTaxable: number;
  /** Long-term capital gain that survived netting (>= 0) — taxed at preferential LTCG rates. */
  longTermGainTaxable: number;
  /** Up to $3,000/year of a net overall capital LOSS, deductible against ordinary income
   * (from CapitalGainSummary.ordinaryLossDeduction). */
  capitalLossDeduction?: number;
  /** Itemized deduction total, if computed — the engine uses whichever of standard or
   * itemized is larger, same as real tax law. Omit to use the standard deduction only. */
  itemizedDeduction?: number;
}

export interface TaxEstimateResult {
  rules: UsTaxRules;
  ordinaryIncome: number;
  agi: number;
  deductionUsed: number;
  usedItemized: boolean;
  taxableOrdinary: number;
  ordinaryTax: number;
  longTermGain: number;
  ltcgTax: number;
  capitalLossDeduction: number;
  estimatedTax: number;
  federalWithheld: number;
  balanceDue: number;
  refund: number;
}

/** Federal-only estimate: ordinary income (wages + short-term gains, which are taxed as
 * ordinary income, less any $3,000 capital-loss deduction) stacked with the larger of
 * standard or itemized deduction, plus long-term gains taxed separately under preferential
 * LTCG brackets. No AMT or NIIT. */
export function estimateUsFederalTax(input: TaxEstimateInput): TaxEstimateResult {
  const rules = resolveUsTaxRules(input.taxYear, input.filingStatus);
  const shortTermGain = Math.max(0, input.shortTermGainTaxable);
  const longTermGain = Math.max(0, input.longTermGainTaxable);
  const capitalLossDeduction = Math.max(0, input.capitalLossDeduction ?? 0);

  const ordinaryIncome = Math.max(0, input.wages + shortTermGain - capitalLossDeduction);
  const agi = ordinaryIncome + longTermGain;
  const itemized = Math.max(0, input.itemizedDeduction ?? 0);
  const usedItemized = itemized > rules.standardDeduction;
  const deductionUsed = usedItemized ? itemized : rules.standardDeduction;
  const taxableOrdinary = Math.max(0, ordinaryIncome - deductionUsed);
  const ordinaryTax = applyBrackets(taxableOrdinary, rules.federalBrackets);
  const ltcgTax = applyBrackets(longTermGain, rules.longTermCapGainBrackets);
  const estimatedTax = round2(ordinaryTax + ltcgTax);
  const balance = round2(estimatedTax - input.federalWithheld);

  return {
    rules,
    ordinaryIncome: round2(ordinaryIncome),
    agi: round2(agi),
    deductionUsed: round2(deductionUsed),
    usedItemized,
    taxableOrdinary: round2(taxableOrdinary),
    ordinaryTax: round2(ordinaryTax),
    longTermGain: round2(longTermGain),
    ltcgTax: round2(ltcgTax),
    capitalLossDeduction: round2(capitalLossDeduction),
    estimatedTax,
    federalWithheld: round2(input.federalWithheld),
    balanceDue: balance > 0 ? balance : 0,
    refund: balance < 0 ? Math.abs(balance) : 0,
  };
}

export interface ItemizedInputs {
  medicalExpenses: number;
  propertyTax: number;
  stateIncomeTaxPaid: number;
  mortgageInterest: number;
  charitable: number;
}

export interface ItemizedResult {
  medicalDeductible: number;
  saltPaid: number;
  saltCap: number;
  saltDeductible: number;
  mortgageInterestDeductible: number;
  charitableDeductible: number;
  total: number;
}

const SALT_CAP_BASE = 40_000; // 2025+ under the One Big Beautiful Bill Act; was $10,000 pre-2025
const SALT_PHASEOUT_START_MAGI = 500_000;
const SALT_PHASEOUT_RATE = 0.30;
const SALT_CAP_FLOOR = 10_000;
const MEDICAL_AGI_FLOOR_PCT = 0.075;
const CHARITABLE_AGI_CAP_PCT = 0.60;

/** Federal itemized deduction total, computed against the AGI-dependent floors/caps that
 * actually apply: medical only above 7.5% of AGI, SALT (property + state income tax) capped
 * and phased down for high earners, charitable capped at 60% of AGI. Mortgage interest isn't
 * capped here (the $750k acquisition-debt limit isn't checkable from ledger data alone). */
export function computeItemizedDeduction(agi: number, inputs: ItemizedInputs): ItemizedResult {
  const medicalDeductible = Math.max(0, inputs.medicalExpenses - agi * MEDICAL_AGI_FLOOR_PCT);
  const saltPaid = inputs.propertyTax + inputs.stateIncomeTaxPaid;
  const saltCap = Math.max(SALT_CAP_FLOOR, SALT_CAP_BASE - Math.max(0, agi - SALT_PHASEOUT_START_MAGI) * SALT_PHASEOUT_RATE);
  const saltDeductible = Math.min(saltPaid, saltCap);
  const mortgageInterestDeductible = Math.max(0, inputs.mortgageInterest);
  const charitableDeductible = Math.min(Math.max(0, inputs.charitable), agi * CHARITABLE_AGI_CAP_PCT);
  return {
    medicalDeductible: round2(medicalDeductible),
    saltPaid: round2(saltPaid),
    saltCap: round2(saltCap),
    saltDeductible: round2(saltDeductible),
    mortgageInterestDeductible: round2(mortgageInterestDeductible),
    charitableDeductible: round2(charitableDeductible),
    total: round2(medicalDeductible + saltDeductible + mortgageInterestDeductible + charitableDeductible),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
