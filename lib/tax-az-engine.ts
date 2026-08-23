import { applyBrackets, round2 } from "./tax-usa-engine";
import { resolveAzTaxRules, type AzTaxRules } from "./tax-az-rules";
import type { UsFilingStatus } from "./tax-usa-rules";

export interface AzItemizedInputs {
  medicalExpenses: number;
  propertyTax: number;
  mortgageInterest: number;
  charitable: number;
}

const AZ_MEDICAL_AGI_FLOOR_PCT = 0.075;
const AZ_CHARITABLE_AGI_CAP_PCT = 0.60;
const AZ_SALT_CAP = 10_000;

/** AZ itemized deductions generally follow the federal post-TCJA rules (AZ conformed starting
 * the 2019 tax year), including the federal $10,000 SALT cap -- simplified here to property tax
 * alone (the SALT-relevant figure this app tracks; no state income tax paid figure applies since
 * AZ doesn't allow deducting AZ tax against itself). */
export function computeAzItemizedDeduction(agi: number, inputs: AzItemizedInputs): number {
  const medicalDeductible = Math.max(0, inputs.medicalExpenses - agi * AZ_MEDICAL_AGI_FLOOR_PCT);
  const propertyTaxDeductible = Math.min(Math.max(0, inputs.propertyTax), AZ_SALT_CAP);
  const mortgageInterestDeductible = Math.max(0, inputs.mortgageInterest);
  const charitableDeductible = Math.min(Math.max(0, inputs.charitable), agi * AZ_CHARITABLE_AGI_CAP_PCT);
  return round2(medicalDeductible + propertyTaxDeductible + mortgageInterestDeductible + charitableDeductible);
}

export interface AzTaxEstimateInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  /** Federal AGI used as a proxy for AZ gross income -- AZ conforms closely to federal AGI. */
  agi: number;
  itemizedDeduction?: number;
  stateWithheld: number;
}

export interface AzTaxEstimateResult {
  rules: AzTaxRules;
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

export function estimateAzStateTax(input: AzTaxEstimateInput): AzTaxEstimateResult {
  const rules = resolveAzTaxRules(input.taxYear, input.filingStatus);
  const itemized = Math.max(0, input.itemizedDeduction ?? 0);
  const usedItemized = itemized > rules.standardDeduction;
  const deductionUsed = usedItemized ? itemized : rules.standardDeduction;
  const taxableIncome = Math.max(0, input.agi - deductionUsed);
  const bracketTax = applyBrackets(taxableIncome, rules.brackets);
  const estimatedTax = round2(bracketTax);
  const balance = round2(estimatedTax - input.stateWithheld);

  return {
    rules,
    deductionUsed: round2(deductionUsed),
    usedItemized,
    taxableIncome: round2(taxableIncome),
    bracketTax: round2(bracketTax),
    mentalHealthTax: 0,
    estimatedTax,
    stateWithheld: round2(input.stateWithheld),
    balanceDue: balance > 0 ? balance : 0,
    refund: balance < 0 ? Math.abs(balance) : 0,
  };
}
