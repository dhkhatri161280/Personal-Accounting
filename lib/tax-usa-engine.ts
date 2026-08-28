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

// Additional Medicare Tax (Form 8959) and NIIT (Form 8960) share the same threshold table.
const ADDITIONAL_MEDICARE_THRESHOLD: Record<UsFilingStatus, number> = { mfj: 250_000, single: 200_000 };
const ADDITIONAL_MEDICARE_RATE = 0.009;
const NIIT_THRESHOLD: Record<UsFilingStatus, number> = { mfj: 250_000, single: 200_000 };
const NIIT_RATE = 0.038;
const REGULAR_MEDICARE_RATE = 0.0145;

export interface TaxEstimateInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  /** W-2 wages, already includes RSU-vest and ESPP-discount ordinary income (both are taxed
   * as wages at vest/purchase time, not as capital gains). */
  wages: number;
  federalWithheld: number;
  /** Box 5 Medicare wages — unlike `wages` above, NOT reduced by a traditional 401(k)
   * deferral (401(k) contributions are still subject to Medicare/FICA tax). Used only for
   * Additional Medicare Tax. Defaults to `wages` if omitted. */
  medicareWages?: number;
  /** Total Medicare tax withheld (W-2 Box 6) — combines the regular 1.45% and whatever
   * Additional Medicare Tax the employer already withheld above the threshold, same as Form
   * 8959 Part V. Used to credit Additional Medicare Tax already withheld; omit for 0. */
  medicareWithheld?: number;
  /** Short-term capital gain that survived Schedule D-style netting (>= 0) — taxed as
   * ordinary income. */
  shortTermGainTaxable: number;
  /** Long-term capital gain that survived netting (>= 0) — taxed at preferential LTCG rates. */
  longTermGainTaxable: number;
  /** Up to $3,000/year of a net overall capital LOSS, deductible against ordinary income
   * (from CapitalGainSummary.ordinaryLossDeduction). */
  capitalLossDeduction?: number;
  /** Above-the-line deductions (Schedule 1 adjustments to income) — e.g. a personal HSA
   * contribution (Form 8889). Reduces AGI directly, before the standard/itemized deduction
   * is applied. Not the same as itemizedDeduction, which only reduces taxable income if it
   * beats the standard deduction. */
  aboveLineDeduction?: number;
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
  aboveLineDeduction: number;
  additionalMedicareTax: number;
  netInvestmentIncome: number;
  niit: number;
  estimatedTax: number;
  federalWithheld: number;
  additionalMedicareWithheld: number;
  balanceDue: number;
  refund: number;
}

/** Federal-only estimate: ordinary income (wages + short-term gains, which are taxed as
 * ordinary income, less any $3,000 capital-loss deduction) stacked with the larger of
 * standard or itemized deduction, plus long-term gains taxed separately under preferential
 * LTCG brackets, plus Additional Medicare Tax and NIIT. No AMT (didn't apply in the reference
 * return checked against this engine, despite a large SALT addback -- not modeled, watch for
 * it changing at materially higher income or different deduction mix). */
export function estimateUsFederalTax(input: TaxEstimateInput): TaxEstimateResult {
  const rules = resolveUsTaxRules(input.taxYear, input.filingStatus);
  const shortTermGain = Math.max(0, input.shortTermGainTaxable);
  const longTermGain = Math.max(0, input.longTermGainTaxable);
  const capitalLossDeduction = Math.max(0, input.capitalLossDeduction ?? 0);
  const aboveLineDeduction = Math.max(0, input.aboveLineDeduction ?? 0);

  const ordinaryIncome = Math.max(0, input.wages + shortTermGain - capitalLossDeduction - aboveLineDeduction);
  const agi = ordinaryIncome + longTermGain;
  const itemized = Math.max(0, input.itemizedDeduction ?? 0);
  const usedItemized = itemized > rules.standardDeduction;
  const deductionUsed = usedItemized ? itemized : rules.standardDeduction;
  const taxableOrdinary = Math.max(0, ordinaryIncome - deductionUsed);
  const ordinaryTax = applyBrackets(taxableOrdinary, rules.federalBrackets);
  // LTCG brackets apply on top of ordinary taxable income, not from $0 -- e.g. at $370k
  // ordinary income, a $100k gain is taxed entirely at 15%, not partly at the 0% bracket the
  // gain would see if it were the household's only income. Stack-then-subtract gives the tax
  // on just the gain slice sitting above taxableOrdinary in the LTCG bracket table.
  const ltcgTax = Math.max(
    0,
    applyBrackets(taxableOrdinary + longTermGain, rules.longTermCapGainBrackets) -
      applyBrackets(taxableOrdinary, rules.longTermCapGainBrackets)
  );

  const medicareWages = input.medicareWages ?? input.wages;
  const additionalMedicareTax = round2(
    Math.max(0, medicareWages - ADDITIONAL_MEDICARE_THRESHOLD[input.filingStatus]) * ADDITIONAL_MEDICARE_RATE
  );
  const medicareWithheld = input.medicareWithheld ?? 0;
  const regularMedicareWithheld = medicareWages * REGULAR_MEDICARE_RATE;
  const additionalMedicareWithheld = round2(Math.max(0, medicareWithheld - regularMedicareWithheld));

  // Form 8960 line 5a treats ALL realized capital gains (short- and long-term alike) as
  // investment income, unlike the federal bracket split above which taxes short-term gains
  // as ordinary income. Interest/dividends aren't tracked by this app, so this understates
  // net investment income for anyone with meaningful interest/dividend income.
  const netInvestmentIncome = Math.max(0, shortTermGain + longTermGain);
  const niit = round2(Math.min(netInvestmentIncome, Math.max(0, agi - NIIT_THRESHOLD[input.filingStatus])) * NIIT_RATE);

  const estimatedTax = round2(ordinaryTax + ltcgTax + additionalMedicareTax + niit);
  const totalCredits = input.federalWithheld + additionalMedicareWithheld;
  const balance = round2(estimatedTax - totalCredits);

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
    aboveLineDeduction: round2(aboveLineDeduction),
    additionalMedicareTax,
    netInvestmentIncome: round2(netInvestmentIncome),
    niit,
    estimatedTax,
    federalWithheld: round2(input.federalWithheld),
    additionalMedicareWithheld,
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

const SALT_CAP_BASE = 40_000; // 2025+ under the One Big Beautiful Bill Act; was $10,000 2018-2024
const SALT_PHASEOUT_START_MAGI = 500_000;
const SALT_PHASEOUT_RATE = 0.30;
const SALT_CAP_FLOOR = 10_000;
const MEDICAL_AGI_FLOOR_PCT = 0.075;
const CHARITABLE_AGI_CAP_PCT = 0.60;

/** SALT (state/local tax) cap by year: uncapped pre-TCJA (through 2017), a flat $10,000
 * 2018-2024, and the OBBBA's $40,000 cap (phased down for high earners) from 2025 on. */
function saltCapForYear(taxYear: string, agi: number, saltPaid: number): number {
  const year = parseInt(taxYear, 10);
  if (!Number.isFinite(year) || year < 2018) return saltPaid; // no cap -- deductible in full
  if (year < 2025) return SALT_CAP_FLOOR;
  return Math.max(SALT_CAP_FLOOR, SALT_CAP_BASE - Math.max(0, agi - SALT_PHASEOUT_START_MAGI) * SALT_PHASEOUT_RATE);
}

/** Federal itemized deduction total, computed against the AGI-dependent floors/caps that
 * actually apply for the given tax year: medical only above 7.5% of AGI, SALT (property +
 * state income tax) capped per `saltCapForYear`, charitable capped at 60% of AGI. Mortgage
 * interest isn't capped here (the $750k acquisition-debt limit isn't checkable from ledger
 * data alone). */
export function computeItemizedDeduction(taxYear: string, agi: number, inputs: ItemizedInputs): ItemizedResult {
  const medicalDeductible = Math.max(0, inputs.medicalExpenses - agi * MEDICAL_AGI_FLOOR_PCT);
  const saltPaid = inputs.propertyTax + inputs.stateIncomeTaxPaid;
  const saltCap = saltCapForYear(taxYear, agi, saltPaid);
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

export type HsaCoverage = "self-only" | "family";

// IRS annual HSA contribution limits (Rev. Proc.) — 2025 figures validated against a real
// Form 8889 (family limit matched exactly); 2026 figures per Rev. Proc. 2025-19; 2016-2024
// figures are the published historical Rev. Proc. limits for each year.
const HSA_LIMITS: Record<string, Record<HsaCoverage, number>> = {
  "2016": { "self-only": 3_350, family: 6_750 },
  "2017": { "self-only": 3_400, family: 6_750 },
  "2018": { "self-only": 3_450, family: 6_900 },
  "2019": { "self-only": 3_500, family: 7_000 },
  "2020": { "self-only": 3_550, family: 7_100 },
  "2021": { "self-only": 3_600, family: 7_200 },
  "2022": { "self-only": 3_650, family: 7_300 },
  "2023": { "self-only": 3_850, family: 7_750 },
  "2024": { "self-only": 4_150, family: 8_300 },
  "2025": { "self-only": 4_300, family: 8_550 },
  "2026": { "self-only": 4_400, family: 8_750 },
};

/** Elective-deferral limit for the annual room calc in tax-planning.ts -- doesn't include the
 * age-50+ catch-up ($7,500 for 2024/2025), same "not modeled" omission as the HSA table above.
 * 2024/2025 are the published IRS figures; 2026 is a projection (not yet announced at the time
 * this was written), matching the "projected" convention used for the 2026 bracket tables. */
const RETIREMENT_401K_LIMITS: Record<string, number> = {
  "2016": 18_000, "2017": 18_000, "2018": 18_500, "2019": 19_000, "2020": 19_500,
  "2021": 19_500, "2022": 20_500, "2023": 22_500, "2024": 23_000, "2025": 23_500, "2026": 24_500,
};

export function getHsaLimit(taxYear: string, coverage: HsaCoverage): number {
  const limits = HSA_LIMITS[taxYear] ?? HSA_LIMITS["2026"];
  return limits[coverage];
}

export function get401kLimit(taxYear: string): number {
  return RETIREMENT_401K_LIMITS[taxYear] ?? RETIREMENT_401K_LIMITS["2026"];
}

/** Federal above-the-line HSA deduction (Form 8889) — the personal (non-payroll) contribution
 * amount, capped at the IRS annual limit for the coverage tier. California does NOT conform
 * to federal HSA treatment: contributions aren't deductible on the CA return, so this must be
 * added back when computing CA AGI, not carried through like a normal federal deduction. */
export function computeHsaDeduction(taxYear: string, coverage: HsaCoverage, contributions: number): number {
  const limits = HSA_LIMITS[taxYear] ?? HSA_LIMITS["2026"];
  return round2(Math.min(Math.max(0, contributions), limits[coverage]));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
