/** California state tax rules. Note: the 2024/2025/2026 tables below were originally entered
 * one year off (mislabeled) -- verified against FTB's published 2024/2025 figures ($5,540 /
 * $5,706 single standard deduction) and corrected: the data previously keyed "2024" is actually
 * 2023, "2025" is actually 2024, and "2026" is actually 2025. A fresh "2026" projection (~3%
 * inflation growth from the now-correct 2025) replaces the old mislabeled one. 2017/2018 are
 * backward-extrapolated estimates (FTB doesn't publish an easily searchable historical table
 * that far back) rather than verified published figures -- treat those two as rougher. Unlike
 * federal, CA doubles every bracket (not just the lower/middle ones) for MFJ vs single. */

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
  "2017": {
    single: {
      taxYear: "2017", ruleVersion: "CA FTB 2017 single (estimate, backward-extrapolated)", filingStatus: "single",
      brackets: [
        { upTo: 8_376, rate: 0.01 }, { upTo: 19_858, rate: 0.02 }, { upTo: 31_342, rate: 0.04 },
        { upTo: 43_507, rate: 0.06 }, { upTo: 54_986, rate: 0.08 }, { upTo: 280_875, rate: 0.093 },
        { upTo: 337_047, rate: 0.103 }, { upTo: 561_745, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 4_315, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2017", ruleVersion: "CA FTB 2017 MFJ (estimate, backward-extrapolated)", filingStatus: "mfj",
      brackets: [
        { upTo: 16_752, rate: 0.01 }, { upTo: 39_716, rate: 0.02 }, { upTo: 62_684, rate: 0.04 },
        { upTo: 87_014, rate: 0.06 }, { upTo: 109_972, rate: 0.08 }, { upTo: 561_750, rate: 0.093 },
        { upTo: 674_094, rate: 0.103 }, { upTo: 1_123_490, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 8_630, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2018": {
    single: {
      taxYear: "2018", ruleVersion: "CA FTB 2018 single (estimate, backward-extrapolated)", filingStatus: "single",
      brackets: [
        { upTo: 8_544, rate: 0.01 }, { upTo: 20_255, rate: 0.02 }, { upTo: 31_969, rate: 0.04 },
        { upTo: 44_377, rate: 0.06 }, { upTo: 56_085, rate: 0.08 }, { upTo: 286_492, rate: 0.093 },
        { upTo: 343_788, rate: 0.103 }, { upTo: 572_980, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 4_401, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2018", ruleVersion: "CA FTB 2018 MFJ (estimate, backward-extrapolated)", filingStatus: "mfj",
      brackets: [
        { upTo: 17_088, rate: 0.01 }, { upTo: 40_510, rate: 0.02 }, { upTo: 63_938, rate: 0.04 },
        { upTo: 88_754, rate: 0.06 }, { upTo: 112_170, rate: 0.08 }, { upTo: 572_984, rate: 0.093 },
        { upTo: 687_576, rate: 0.103 }, { upTo: 1_145_960, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 8_802, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2021": {
    single: {
      taxYear: "2021", ruleVersion: "CA FTB 2021 single (published)", filingStatus: "single",
      brackets: [
        { upTo: 9_325, rate: 0.01 }, { upTo: 22_107, rate: 0.02 }, { upTo: 34_892, rate: 0.04 },
        { upTo: 48_435, rate: 0.06 }, { upTo: 61_214, rate: 0.08 }, { upTo: 312_676, rate: 0.093 },
        { upTo: 375_215, rate: 0.103 }, { upTo: 625_349, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 4_803, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2021", ruleVersion: "CA FTB 2021 MFJ (published)", filingStatus: "mfj",
      brackets: [
        { upTo: 18_650, rate: 0.01 }, { upTo: 44_214, rate: 0.02 }, { upTo: 69_784, rate: 0.04 },
        { upTo: 96_870, rate: 0.06 }, { upTo: 122_428, rate: 0.08 }, { upTo: 625_372, rate: 0.093 },
        { upTo: 750_430, rate: 0.103 }, { upTo: 1_250_738, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 9_606, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2022": {
    single: {
      taxYear: "2022", ruleVersion: "CA FTB 2022 single (published)", filingStatus: "single",
      brackets: [
        { upTo: 10_099, rate: 0.01 }, { upTo: 23_942, rate: 0.02 }, { upTo: 37_788, rate: 0.04 },
        { upTo: 52_455, rate: 0.06 }, { upTo: 66_295, rate: 0.08 }, { upTo: 338_639, rate: 0.093 },
        { upTo: 406_364, rate: 0.103 }, { upTo: 677_275, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_202, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2022", ruleVersion: "CA FTB 2022 MFJ (published)", filingStatus: "mfj",
      brackets: [
        { upTo: 20_198, rate: 0.01 }, { upTo: 47_884, rate: 0.02 }, { upTo: 75_576, rate: 0.04 },
        { upTo: 104_910, rate: 0.06 }, { upTo: 132_590, rate: 0.08 }, { upTo: 677_278, rate: 0.093 },
        { upTo: 812_728, rate: 0.103 }, { upTo: 1_354_550, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 10_404, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2023": {
    single: {
      taxYear: "2023", ruleVersion: "CA FTB 2023 single (published)", filingStatus: "single",
      brackets: [
        { upTo: 10_412, rate: 0.01 }, { upTo: 24_684, rate: 0.02 }, { upTo: 38_959, rate: 0.04 },
        { upTo: 54_081, rate: 0.06 }, { upTo: 68_350, rate: 0.08 }, { upTo: 349_137, rate: 0.093 },
        { upTo: 418_961, rate: 0.103 }, { upTo: 698_271, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_363, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2023", ruleVersion: "CA FTB 2023 MFJ (published)", filingStatus: "mfj",
      brackets: [
        { upTo: 20_824, rate: 0.01 }, { upTo: 49_368, rate: 0.02 }, { upTo: 77_918, rate: 0.04 },
        { upTo: 108_162, rate: 0.06 }, { upTo: 136_700, rate: 0.08 }, { upTo: 698_274, rate: 0.093 },
        { upTo: 837_922, rate: 0.103 }, { upTo: 1_396_542, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 10_726, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2024": {
    single: {
      taxYear: "2024", ruleVersion: "CA FTB 2024 single (published, verified)", filingStatus: "single",
      brackets: [
        { upTo: 10_724, rate: 0.01 }, { upTo: 25_425, rate: 0.02 }, { upTo: 40_128, rate: 0.04 },
        { upTo: 55_703, rate: 0.06 }, { upTo: 70_401, rate: 0.08 }, { upTo: 359_611, rate: 0.093 },
        { upTo: 431_530, rate: 0.103 }, { upTo: 719_219, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_540, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2024", ruleVersion: "CA FTB 2024 MFJ (published, verified)", filingStatus: "mfj",
      brackets: [
        { upTo: 21_448, rate: 0.01 }, { upTo: 50_850, rate: 0.02 }, { upTo: 80_256, rate: 0.04 },
        { upTo: 111_406, rate: 0.06 }, { upTo: 140_802, rate: 0.08 }, { upTo: 719_222, rate: 0.093 },
        { upTo: 863_060, rate: 0.103 }, { upTo: 1_438_438, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 11_080, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2025": {
    single: {
      taxYear: "2025", ruleVersion: "CA FTB 2025 single (published, verified)", filingStatus: "single",
      brackets: [
        { upTo: 11_046, rate: 0.01 }, { upTo: 26_188, rate: 0.02 }, { upTo: 41_332, rate: 0.04 },
        { upTo: 57_374, rate: 0.06 }, { upTo: 72_513, rate: 0.08 }, { upTo: 370_399, rate: 0.093 },
        { upTo: 444_476, rate: 0.103 }, { upTo: 740_796, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_706, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2025", ruleVersion: "CA FTB 2025 MFJ (published, verified)", filingStatus: "mfj",
      brackets: [
        { upTo: 22_092, rate: 0.01 }, { upTo: 52_376, rate: 0.02 }, { upTo: 82_664, rate: 0.04 },
        { upTo: 114_748, rate: 0.06 }, { upTo: 145_026, rate: 0.08 }, { upTo: 740_798, rate: 0.093 },
        { upTo: 888_952, rate: 0.103 }, { upTo: 1_481_592, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 11_412, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
  },
  "2026": {
    single: {
      taxYear: "2026", ruleVersion: "CA FTB 2026 single (projected, ~3% inflation growth from 2025)", filingStatus: "single",
      brackets: [
        { upTo: 11_377, rate: 0.01 }, { upTo: 26_974, rate: 0.02 }, { upTo: 42_572, rate: 0.04 },
        { upTo: 59_095, rate: 0.06 }, { upTo: 74_688, rate: 0.08 }, { upTo: 381_511, rate: 0.093 },
        { upTo: 457_810, rate: 0.103 }, { upTo: 763_020, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 5_877, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
    },
    mfj: {
      taxYear: "2026", ruleVersion: "CA FTB 2026 MFJ (projected, ~3% inflation growth from 2025)", filingStatus: "mfj",
      brackets: [
        { upTo: 22_754, rate: 0.01 }, { upTo: 53_948, rate: 0.02 }, { upTo: 85_144, rate: 0.04 },
        { upTo: 118_190, rate: 0.06 }, { upTo: 149_376, rate: 0.08 }, { upTo: 763_022, rate: 0.093 },
        { upTo: 915_620, rate: 0.103 }, { upTo: 1_526_040, rate: 0.113 }, { upTo: null, rate: 0.123 },
      ],
      standardDeduction: 11_754, mentalHealthTaxThreshold: 1_000_000, mentalHealthTaxRate: 0.01,
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
