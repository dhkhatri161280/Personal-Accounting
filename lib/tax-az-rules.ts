/** Arizona individual income tax rules. Brackets verified against ARS 43-1011 (the statutory
 * table enacted for tax years beginning after 2018, before the 2021+ flat-tax phase-in) --
 * unlike CA/federal, these AZ brackets weren't inflation-indexed year to year, so 2019 and 2020
 * share the same thresholds. AZ conformed to the federal standard deduction starting the 2019
 * tax year (and dropped personal/dependent exemptions), so `standardDeduction` here matches the
 * federal amount for each year. */

import type { UsBracket, UsFilingStatus } from "./tax-usa-rules";

export interface AzTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  brackets: UsBracket[];
  standardDeduction: number;
}

const AZ_BRACKETS: Record<UsFilingStatus, UsBracket[]> = {
  single: [
    { upTo: 26_500, rate: 0.0259 }, { upTo: 53_000, rate: 0.0334 },
    { upTo: 159_000, rate: 0.0417 }, { upTo: null, rate: 0.045 },
  ],
  mfj: [
    { upTo: 53_000, rate: 0.0259 }, { upTo: 106_000, rate: 0.0334 },
    { upTo: 318_000, rate: 0.0417 }, { upTo: null, rate: 0.045 },
  ],
};

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, AzTaxRules>> = {
  "2019": {
    single: {
      taxYear: "2019", ruleVersion: "AZ DOR 2019 single (ARS 43-1011, published)", filingStatus: "single",
      brackets: AZ_BRACKETS.single, standardDeduction: 12_200,
    },
    mfj: {
      taxYear: "2019", ruleVersion: "AZ DOR 2019 MFJ (ARS 43-1011, published)", filingStatus: "mfj",
      brackets: AZ_BRACKETS.mfj, standardDeduction: 24_400,
    },
  },
  "2020": {
    single: {
      taxYear: "2020", ruleVersion: "AZ DOR 2020 single (ARS 43-1011, published)", filingStatus: "single",
      brackets: AZ_BRACKETS.single, standardDeduction: 12_400,
    },
    mfj: {
      taxYear: "2020", ruleVersion: "AZ DOR 2020 MFJ (ARS 43-1011, published)", filingStatus: "mfj",
      brackets: AZ_BRACKETS.mfj, standardDeduction: 24_800,
    },
  },
};

export function listAzTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveAzTaxRules(taxYear: string, filingStatus: UsFilingStatus): AzTaxRules {
  const key = taxYear.trim();
  const yearTable = RULES_BY_YEAR[key] ?? RULES_BY_YEAR[listAzTaxYears()[0]!]!;
  return yearTable[filingStatus];
}
