import { applyBrackets, round2 } from "./tax-usa-engine";
import { resolveCaTaxRules, type CaTaxRules } from "./tax-ca-rules";
import type { UsFilingStatus } from "./tax-usa-rules";

export interface CaItemizedInputs {
  medicalExpenses: number;
  propertyTax: number;
  mortgageInterest: number;
  charitable: number;
}

const CA_MEDICAL_AGI_FLOOR_PCT = 0.075;
const CA_CHARITABLE_AGI_CAP_PCT = 0.60;

/** CA doesn't conform to the federal SALT cap and, unlike the federal return, doesn't allow
 * deducting CA state income tax against itself — so only property tax (not state income tax
 * paid) counts here, alongside mortgage interest and charitable giving. */
export function computeCaItemizedDeduction(agi: number, inputs: CaItemizedInputs): number {
  const medicalDeductible = Math.max(0, inputs.medicalExpenses - agi * CA_MEDICAL_AGI_FLOOR_PCT);
  const propertyTaxDeductible = Math.max(0, inputs.propertyTax);
  const mortgageInterestDeductible = Math.max(0, inputs.mortgageInterest);
  const charitableDeductible = Math.min(Math.max(0, inputs.charitable), agi * CA_CHARITABLE_AGI_CAP_PCT);
  return round2(medicalDeductible + propertyTaxDeductible + mortgageInterestDeductible + charitableDeductible);
}

export interface CaTaxEstimateInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  /** Federal AGI used as a proxy for CA AGI — a reasonable approximation absent CA-specific
   * addback/subtraction data (e.g. municipal bond interest from other states). */
  agi: number;
  itemizedDeduction?: number;
  stateWithheld: number;
}

export interface CaTaxEstimateResult {
  rules: CaTaxRules;
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

export function estimateCaStateTax(input: CaTaxEstimateInput): CaTaxEstimateResult {
  const rules = resolveCaTaxRules(input.taxYear, input.filingStatus);
  const itemized = Math.max(0, input.itemizedDeduction ?? 0);
  const usedItemized = itemized > rules.standardDeduction;
  const deductionUsed = usedItemized ? itemized : rules.standardDeduction;
  const taxableIncome = Math.max(0, input.agi - deductionUsed);
  const bracketTax = applyBrackets(taxableIncome, rules.brackets);
  const mentalHealthTax = Math.max(0, taxableIncome - rules.mentalHealthTaxThreshold) * rules.mentalHealthTaxRate;
  const estimatedTax = round2(bracketTax + mentalHealthTax);
  const balance = round2(estimatedTax - input.stateWithheld);

  return {
    rules,
    deductionUsed: round2(deductionUsed),
    usedItemized,
    taxableIncome: round2(taxableIncome),
    bracketTax: round2(bracketTax),
    mentalHealthTax: round2(mentalHealthTax),
    estimatedTax,
    stateWithheld: round2(input.stateWithheld),
    balanceDue: balance > 0 ? balance : 0,
    refund: balance < 0 ? Math.abs(balance) : 0,
  };
}
