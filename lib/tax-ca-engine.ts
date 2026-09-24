import { applyBrackets, round2 } from "./tax-usa-engine.ts";
import { resolveCaTaxRules, type CaTaxRules } from "./tax-ca-rules.ts";
import type { UsFilingStatus } from "./tax-usa-rules.ts";

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
 * paid) counts here, alongside mortgage interest and charitable giving.
 *
 * `phaseoutThreshold` (see CaTaxRules.itemizedDeductionPhaseoutThreshold in tax-ca-rules.ts):
 * California kept the old federal "Pease limitation" TCJA repealed federally in 2018 -- above
 * this AGI threshold, the reduction is the LESSER of 80% of the raw itemized total or 6% of the
 * AGI over the threshold. Omitting this entirely (as this function used to) overstates a high
 * earner's CA itemized deduction -- confirmed live against a real filed return: raw $39,411
 * should reduce to $11,517, not pass through unreduced. Optional so an existing caller that
 * doesn't have a threshold handy still gets the un-reduced (pre-fix) total, not a thrown error. */
export function computeCaItemizedDeduction(agi: number, inputs: CaItemizedInputs, phaseoutThreshold?: number): number {
  const medicalDeductible = Math.max(0, inputs.medicalExpenses - agi * CA_MEDICAL_AGI_FLOOR_PCT);
  const propertyTaxDeductible = Math.max(0, inputs.propertyTax);
  const mortgageInterestDeductible = Math.max(0, inputs.mortgageInterest);
  const charitableDeductible = Math.min(Math.max(0, inputs.charitable), agi * CA_CHARITABLE_AGI_CAP_PCT);
  const raw = medicalDeductible + propertyTaxDeductible + mortgageInterestDeductible + charitableDeductible;
  const reduction =
    phaseoutThreshold !== undefined && agi > phaseoutThreshold
      ? Math.min(0.8 * raw, 0.06 * (agi - phaseoutThreshold))
      : 0;
  return round2(Math.max(0, raw - reduction));
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
