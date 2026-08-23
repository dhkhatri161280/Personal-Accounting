import { applyBrackets, round2 } from "./tax-usa-engine";
import { resolveNjTaxRules, type NjTaxRules } from "./tax-nj-rules";
import type { UsFilingStatus } from "./tax-usa-rules";

const NJ_PROPERTY_TAX_DEDUCTION_CAP = 15_000;

/** NJ doesn't have a federal-style itemized-vs-standard choice -- property tax paid (capped
 * at $15,000) is deductible alongside the personal exemption, not instead of it. Medical,
 * mortgage interest, and charitable giving aren't NJ gross-income-tax deductions. */
export function computeNjPropertyTaxDeduction(propertyTax: number): number {
  return round2(Math.min(Math.max(0, propertyTax), NJ_PROPERTY_TAX_DEDUCTION_CAP));
}

export interface NjTaxEstimateInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  /** Federal AGI used as a proxy for NJ gross income -- a reasonable approximation absent
   * NJ-specific addback/subtraction data. */
  agi: number;
  propertyTax: number;
  stateWithheld: number;
}

export interface NjTaxEstimateResult {
  rules: NjTaxRules;
  deductionUsed: number;
  usedItemized: boolean;
  taxableIncome: number;
  bracketTax: number;
  mentalHealthTax: number;
  estimatedTax: number;
  stateWithheld: number;
  balanceDue: number;
  refund: number;
}

export function estimateNjStateTax(input: NjTaxEstimateInput): NjTaxEstimateResult {
  const rules = resolveNjTaxRules(input.taxYear, input.filingStatus);
  const propertyTaxDeductible = computeNjPropertyTaxDeduction(input.propertyTax);
  const deductionUsed = rules.standardDeduction + propertyTaxDeductible;
  const taxableIncome = Math.max(0, input.agi - deductionUsed);
  const bracketTax = applyBrackets(taxableIncome, rules.brackets);
  const estimatedTax = round2(bracketTax);
  const balance = round2(estimatedTax - input.stateWithheld);

  return {
    rules,
    deductionUsed: round2(deductionUsed),
    usedItemized: propertyTaxDeductible > 0,
    taxableIncome: round2(taxableIncome),
    bracketTax: round2(bracketTax),
    mentalHealthTax: 0,
    estimatedTax,
    stateWithheld: round2(input.stateWithheld),
    balanceDue: balance > 0 ? balance : 0,
    refund: balance < 0 ? Math.abs(balance) : 0,
  };
}
