/** California state tax rules. 2024 figures are the last officially published brackets at
 * the time this was written; 2025/2026 are extrapolated with a ~3%/year inflation estimate
 * (FTB publishes the actual inflation-adjusted brackets each fall) -- treat these two years
 * as rougher estimates than the federal ones. Unlike federal, CA doubles every bracket
 * (not just the lower/middle ones) for MFJ vs single. */

import type { UsBracket, UsFilingStatus } from "./tax-usa-rules";

export interface CaTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  brackets: UsBracket[];
  standardDeduction: number;
  mentalHealthTaxThreshold: number;
  mentalHealthTaxRate: number;
}

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, CaTaxRules>> = {
  "2024": {
    single: {
      taxYear: "2024", ruleVersion: "CA FTB 2024 single (published)", filingStatus: "single",
      brackets: [
        { upTo: 10_412, rate: 0.01 }, { upTo: 24_684, rate: 0.02 }, { upTo: 38_959, rate: 0.04 },
        { upTo: 54_081, rate: 0.06 }, { upTo: 68_350, rate: 0.08 }, { upTo: 349_137, rate: 0.093 },
        { upTo: 418_961, rate: 0.103 }, { upTo: 698_271, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_363, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2024", ruleVersion: "CA FTB 2024 MFJ (published)", filingStatus: "mfj",
      brackets: [
        { upTo: 20_824, rate: 0.01 }, { upTo: 49_368, rate: 0.02 }, { upTo: 77_918, rate: 0.04 },
        { upTo: 108_162, rate: 0.06 }, { upTo: 136_700, rate: 0.08 }, { upTo: 698_274, rate: 0.093 },
        { upTo: 837_922, rate: 0.103 }, { upTo: 1_396_542, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 10_726, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2025": {
    single: {
      taxYear: "2025", ruleVersion: "CA FTB 2025 single (estimate, ~3% inflation growth from 2024)", filingStatus: "single",
      brackets: [
        { upTo: 10_724, rate: 0.01 }, { upTo: 25_425, rate: 0.02 }, { upTo: 40_128, rate: 0.04 },
        { upTo: 55_703, rate: 0.06 }, { upTo: 70_401, rate: 0.08 }, { upTo: 359_611, rate: 0.093 },
        { upTo: 431_530, rate: 0.103 }, { upTo: 719_219, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_540, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2025", ruleVersion: "CA FTB 2025 MFJ (estimate, ~3% inflation growth from 2024)", filingStatus: "mfj",
      brackets: [
        { upTo: 21_448, rate: 0.01 }, { upTo: 50_850, rate: 0.02 }, { upTo: 80_256, rate: 0.04 },
        { upTo: 111_406, rate: 0.06 }, { upTo: 140_802, rate: 0.08 }, { upTo: 719_222, rate: 0.093 },
        { upTo: 863_060, rate: 0.103 }, { upTo: 1_438_438, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 11_080, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2026": {
    single: {
      taxYear: "2026", ruleVersion: "CA FTB 2026 single (projected, ~3% inflation growth from 2025 estimate)", filingStatus: "single",
      brackets: [
        { upTo: 11_046, rate: 0.01 }, { upTo: 26_188, rate: 0.02 }, { upTo: 41_332, rate: 0.04 },
        { upTo: 57_374, rate: 0.06 }, { upTo: 72_513, rate: 0.08 }, { upTo: 370_399, rate: 0.093 },
        { upTo: 444_476, rate: 0.103 }, { upTo: 740_796, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_706, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2026", ruleVersion: "CA FTB 2026 MFJ (projected, ~3% inflation growth from 2025 estimate)", filingStatus: "mfj",
      brackets: [
        { upTo: 22_092, rate: 0.01 }, { upTo: 52_376, rate: 0.02 }, { upTo: 82_664, rate: 0.04 },
        { upTo: 114_748, rate: 0.06 }, { upTo: 145_026, rate: 0.08 }, { upTo: 740_798, rate: 0.093 },
        { upTo: 888_952, rate: 0.103 }, { upTo: 1_481_592, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 11_412, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
};

export function listCaTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveCaTaxRules(taxYear: string, filingStatus: UsFilingStatus): CaTaxRules {
  const key = taxYear.trim();
  const yearTable = RULES_BY_YEAR[key] ?? RULES_BY_YEAR[listCaTaxYears()[0]!]!;
  return yearTable[filingStatus];
}
