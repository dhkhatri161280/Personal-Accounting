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
  /** Net short-term capital gain (losses already netted against gains, floored at 0). */
  shortTermGain: number;
  /** Net long-term capital gain (losses already netted against gains, floored at 0). */
  longTermGain: number;
}

export interface TaxEstimateResult {
  rules: UsTaxRules;
  ordinaryIncome: number;
  agi: number;
  taxableOrdinary: number;
  ordinaryTax: number;
  longTermGain: number;
  ltcgTax: number;
  estimatedTax: number;
  federalWithheld: number;
  balanceDue: number;
  refund: number;
}

/** Federal-only estimate: ordinary income (wages + short-term gains, which are taxed as
 * ordinary income) stacked with standard deduction, plus long-term gains taxed separately
 * under preferential LTCG brackets. No itemized deductions, AMT, NIIT, or state tax. */
export function estimateUsFederalTax(input: TaxEstimateInput): TaxEstimateResult {
  const rules = resolveUsTaxRules(input.taxYear, input.filingStatus);
  const shortTermGain = Math.max(0, input.shortTermGain);
  const longTermGain = Math.max(0, input.longTermGain);

  const ordinaryIncome = input.wages + shortTermGain;
  const agi = ordinaryIncome + longTermGain;
  const taxableOrdinary = Math.max(0, ordinaryIncome - rules.standardDeduction);
  const ordinaryTax = applyBrackets(taxableOrdinary, rules.federalBrackets);
  const ltcgTax = applyBrackets(longTermGain, rules.longTermCapGainBrackets);
  const estimatedTax = round2(ordinaryTax + ltcgTax);
  const balance = round2(estimatedTax - input.federalWithheld);

  return {
    rules,
    ordinaryIncome: round2(ordinaryIncome),
    agi: round2(agi),
    taxableOrdinary: round2(taxableOrdinary),
    ordinaryTax: round2(ordinaryTax),
    longTermGain: round2(longTermGain),
    ltcgTax: round2(ltcgTax),
    estimatedTax,
    federalWithheld: round2(input.federalWithheld),
    balanceDue: balance > 0 ? balance : 0,
    refund: balance < 0 ? Math.abs(balance) : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
