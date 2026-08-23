/** New Jersey gross income tax rules. NJ doesn't have a federal-style standard deduction --
 * `standardDeduction` here models the NJ personal exemption ($1,000/exemption: self + spouse
 * for MFJ), which NJ allows on top of (not instead of) other allowable deductions. */

import type { UsBracket, UsFilingStatus } from "./tax-usa-rules";

export interface NjTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  brackets: UsBracket[];
  standardDeduction: number;
}

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, NjTaxRules>> = {
  "2016": {
    single: {
      taxYear: "2016", ruleVersion: "NJ Treasury 2016 single (published)", filingStatus: "single",
      brackets: [
        { upTo: 20_000, rate: 0.014 }, { upTo: 35_000, rate: 0.0175 }, { upTo: 40_000, rate: 0.035 },
        { upTo: 75_000, rate: 0.05525 }, { upTo: 500_000, rate: 0.0637 }, { upTo: null, rate: 0.0897 },
      ],
      standardDeduction: 1_000,
    },
    mfj: {
      taxYear: "2016", ruleVersion: "NJ Treasury 2016 MFJ (published)", filingStatus: "mfj",
      brackets: [
        { upTo: 20_000, rate: 0.014 }, { upTo: 50_000, rate: 0.0175 }, { upTo: 70_000, rate: 0.0245 },
        { upTo: 80_000, rate: 0.035 }, { upTo: 150_000, rate: 0.05525 }, { upTo: 500_000, rate: 0.0637 },
        { upTo: null, rate: 0.0897 },
      ],
      standardDeduction: 2_000,
    },
  },
};

export function listNjTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveNjTaxRules(taxYear: string, filingStatus: UsFilingStatus): NjTaxRules {
  const key = taxYear.trim();
  const yearTable = RULES_BY_YEAR[key] ?? RULES_BY_YEAR[listNjTaxYears()[0]!]!;
  return yearTable[filingStatus];
}
