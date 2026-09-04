/** US federal tax rules — rates live here, not in UI. Estimate only, federal only, not tax
 * advice. Single-filer figures and 2025/2026 bracket structure ported from a reference
 * implementation; MFJ figures added from published/projected IRS figures since this app's
 * user files jointly. IRS numbers for a given year aren't published until the prior Q4, so
 * "2026" here is the projected table, not yet finalized at the time this was written. */

export interface UsBracket {
  upTo: number | null;
  rate: number;
}

export type UsFilingStatus = "single" | "mfj";

export interface UsTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  federalBrackets: UsBracket[];
  standardDeduction: number;
  longTermCapGainBrackets: UsBracket[];
  longTermHoldingDays: number;
}

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, UsTaxRules>> = {
  "2016": {
    single: {
      taxYear: "2016", ruleVersion: "US Federal 2016 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_275, rate: 0.10 }, { upTo: 37_650, rate: 0.15 }, { upTo: 91_150, rate: 0.25 },
        { upTo: 190_150, rate: 0.28 }, { upTo: 413_350, rate: 0.33 }, { upTo: 415_050, rate: 0.35 },
        { upTo: null, rate: 0.396 },
      ],
      standardDeduction: 6_300,
      // Pre-TCJA: LTCG rate tracked the ordinary bracket the gain fell in (0% for the two
      // lowest brackets, 15% through the 35% bracket, 20% only in the top 39.6% bracket).
      longTermCapGainBrackets: [{ upTo: 37_650, rate: 0 }, { upTo: 415_050, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2016", ruleVersion: "US Federal 2016 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 18_550, rate: 0.10 }, { upTo: 75_300, rate: 0.15 }, { upTo: 151_900, rate: 0.25 },
        { upTo: 231_450, rate: 0.28 }, { upTo: 413_350, rate: 0.33 }, { upTo: 466_950, rate: 0.35 },
        { upTo: null, rate: 0.396 },
      ],
      standardDeduction: 12_600,
      longTermCapGainBrackets: [{ upTo: 75_300, rate: 0 }, { upTo: 466_950, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2017": {
    single: {
      taxYear: "2017", ruleVersion: "US Federal 2017 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_325, rate: 0.10 }, { upTo: 37_950, rate: 0.15 }, { upTo: 91_900, rate: 0.25 },
        { upTo: 191_650, rate: 0.28 }, { upTo: 416_700, rate: 0.33 }, { upTo: 418_400, rate: 0.35 },
        { upTo: null, rate: 0.396 },
      ],
      standardDeduction: 6_350,
      longTermCapGainBrackets: [{ upTo: 37_950, rate: 0 }, { upTo: 418_400, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2017", ruleVersion: "US Federal 2017 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 18_650, rate: 0.10 }, { upTo: 75_900, rate: 0.15 }, { upTo: 153_100, rate: 0.25 },
        { upTo: 233_350, rate: 0.28 }, { upTo: 416_700, rate: 0.33 }, { upTo: 470_700, rate: 0.35 },
        { upTo: null, rate: 0.396 },
      ],
      standardDeduction: 12_700,
      longTermCapGainBrackets: [{ upTo: 75_900, rate: 0 }, { upTo: 470_700, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2018": {
    single: {
      taxYear: "2018", ruleVersion: "US Federal 2018 single (published, TCJA)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_525, rate: 0.10 }, { upTo: 38_700, rate: 0.12 }, { upTo: 82_500, rate: 0.22 },
        { upTo: 157_500, rate: 0.24 }, { upTo: 200_000, rate: 0.32 }, { upTo: 500_000, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 12_000,
      longTermCapGainBrackets: [{ upTo: 38_600, rate: 0 }, { upTo: 425_800, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2018", ruleVersion: "US Federal 2018 MFJ (published, TCJA)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 19_050, rate: 0.10 }, { upTo: 77_400, rate: 0.12 }, { upTo: 165_000, rate: 0.22 },
        { upTo: 315_000, rate: 0.24 }, { upTo: 400_000, rate: 0.32 }, { upTo: 600_000, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 24_000,
      longTermCapGainBrackets: [{ upTo: 77_200, rate: 0 }, { upTo: 479_000, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2019": {
    single: {
      taxYear: "2019", ruleVersion: "US Federal 2019 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_700, rate: 0.10 }, { upTo: 39_475, rate: 0.12 }, { upTo: 84_200, rate: 0.22 },
        { upTo: 160_725, rate: 0.24 }, { upTo: 204_100, rate: 0.32 }, { upTo: 510_300, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 12_200,
      longTermCapGainBrackets: [{ upTo: 39_375, rate: 0 }, { upTo: 434_550, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2019", ruleVersion: "US Federal 2019 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 19_400, rate: 0.10 }, { upTo: 78_950, rate: 0.12 }, { upTo: 168_400, rate: 0.22 },
        { upTo: 321_450, rate: 0.24 }, { upTo: 408_200, rate: 0.32 }, { upTo: 612_350, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 24_400,
      longTermCapGainBrackets: [{ upTo: 78_750, rate: 0 }, { upTo: 488_850, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2020": {
    single: {
      taxYear: "2020", ruleVersion: "US Federal 2020 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_875, rate: 0.10 }, { upTo: 40_125, rate: 0.12 }, { upTo: 85_525, rate: 0.22 },
        { upTo: 163_300, rate: 0.24 }, { upTo: 207_350, rate: 0.32 }, { upTo: 518_400, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 12_400,
      longTermCapGainBrackets: [{ upTo: 40_000, rate: 0 }, { upTo: 441_450, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2020", ruleVersion: "US Federal 2020 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 19_750, rate: 0.10 }, { upTo: 80_250, rate: 0.12 }, { upTo: 171_050, rate: 0.22 },
        { upTo: 326_600, rate: 0.24 }, { upTo: 414_700, rate: 0.32 }, { upTo: 622_050, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 24_800,
      longTermCapGainBrackets: [{ upTo: 80_000, rate: 0 }, { upTo: 496_600, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2021": {
    single: {
      taxYear: "2021", ruleVersion: "US Federal 2021 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 9_950, rate: 0.10 }, { upTo: 40_525, rate: 0.12 }, { upTo: 86_375, rate: 0.22 },
        { upTo: 164_925, rate: 0.24 }, { upTo: 209_425, rate: 0.32 }, { upTo: 523_600, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 12_550,
      longTermCapGainBrackets: [{ upTo: 40_400, rate: 0 }, { upTo: 445_850, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2021", ruleVersion: "US Federal 2021 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 19_900, rate: 0.10 }, { upTo: 81_050, rate: 0.12 }, { upTo: 172_750, rate: 0.22 },
        { upTo: 329_850, rate: 0.24 }, { upTo: 418_850, rate: 0.32 }, { upTo: 628_300, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 25_100,
      longTermCapGainBrackets: [{ upTo: 80_800, rate: 0 }, { upTo: 501_600, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2022": {
    single: {
      taxYear: "2022", ruleVersion: "US Federal 2022 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 10_275, rate: 0.10 }, { upTo: 41_775, rate: 0.12 }, { upTo: 89_075, rate: 0.22 },
        { upTo: 170_050, rate: 0.24 }, { upTo: 215_950, rate: 0.32 }, { upTo: 539_900, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 12_950,
      longTermCapGainBrackets: [{ upTo: 41_675, rate: 0 }, { upTo: 459_750, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2022", ruleVersion: "US Federal 2022 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 20_550, rate: 0.10 }, { upTo: 83_550, rate: 0.12 }, { upTo: 178_150, rate: 0.22 },
        { upTo: 340_100, rate: 0.24 }, { upTo: 431_900, rate: 0.32 }, { upTo: 647_850, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 25_900,
      longTermCapGainBrackets: [{ upTo: 83_350, rate: 0 }, { upTo: 517_200, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2023": {
    single: {
      taxYear: "2023", ruleVersion: "US Federal 2023 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 11_000, rate: 0.10 }, { upTo: 44_725, rate: 0.12 }, { upTo: 95_375, rate: 0.22 },
        { upTo: 182_100, rate: 0.24 }, { upTo: 231_250, rate: 0.32 }, { upTo: 578_125, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 13_850,
      longTermCapGainBrackets: [{ upTo: 44_625, rate: 0 }, { upTo: 492_300, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2023", ruleVersion: "US Federal 2023 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 22_000, rate: 0.10 }, { upTo: 89_450, rate: 0.12 }, { upTo: 190_750, rate: 0.22 },
        { upTo: 364_200, rate: 0.24 }, { upTo: 462_500, rate: 0.32 }, { upTo: 693_750, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 27_700,
      longTermCapGainBrackets: [{ upTo: 89_250, rate: 0 }, { upTo: 553_850, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2024": {
    single: {
      taxYear: "2024", ruleVersion: "US Federal 2024 single (published)", filingStatus: "single",
      federalBrackets: [
        { upTo: 11_600, rate: 0.10 }, { upTo: 47_150, rate: 0.12 }, { upTo: 100_525, rate: 0.22 },
        { upTo: 191_950, rate: 0.24 }, { upTo: 243_725, rate: 0.32 }, { upTo: 609_350, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 14_600,
      longTermCapGainBrackets: [{ upTo: 47_025, rate: 0 }, { upTo: 518_900, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2024", ruleVersion: "US Federal 2024 MFJ (published)", filingStatus: "mfj",
      federalBrackets: [
        { upTo: 23_200, rate: 0.10 }, { upTo: 94_300, rate: 0.12 }, { upTo: 201_050, rate: 0.22 },
        { upTo: 383_900, rate: 0.24 }, { upTo: 487_450, rate: 0.32 }, { upTo: 731_200, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 29_200,
      longTermCapGainBrackets: [{ upTo: 94_050, rate: 0 }, { upTo: 583_750, rate: 0.15 }, { upTo: null, rate: 0.20 }],
      longTermHoldingDays: 365,
    },
  },
  "2025": {
    single: {
      taxYear: "2025",
      ruleVersion: "US Federal 2025 single (estimate)",
      filingStatus: "single",
      federalBrackets: [
        { upTo: 11_925, rate: 0.10 },
        { upTo: 48_475, rate: 0.12 },
        { upTo: 103_350, rate: 0.22 },
        { upTo: 197_300, rate: 0.24 },
        { upTo: 250_525, rate: 0.32 },
        { upTo: 626_350, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 15_000,
      longTermCapGainBrackets: [
        { upTo: 48_350, rate: 0 },
        { upTo: 533_400, rate: 0.15 },
        { upTo: null, rate: 0.20 },
      ],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2025",
      ruleVersion: "US Federal 2025 MFJ (estimate)",
      filingStatus: "mfj",
      federalBrackets: [
        { upTo: 23_850, rate: 0.10 },
        { upTo: 96_950, rate: 0.12 },
        { upTo: 206_700, rate: 0.22 },
        { upTo: 394_600, rate: 0.24 },
        { upTo: 501_050, rate: 0.32 },
        { upTo: 751_600, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 30_000,
      longTermCapGainBrackets: [
        { upTo: 96_700, rate: 0 },
        { upTo: 600_050, rate: 0.15 },
        { upTo: null, rate: 0.20 },
      ],
      longTermHoldingDays: 365,
    },
  },
  // Confirmed against the IRS's own published 2026 inflation adjustments (Rev. Proc. 2025-32,
  // reflecting One Big Beautiful Bill Act amendments), fetched directly from irs.gov on
  // 2026-09-04 -- these replace an earlier pre-release "projected" estimate that undershot the
  // real numbers (OBBBA's adjustment came in higher than a standard inflation projection would
  // predict). Long-term capital-gains brackets are NOT part of that IRS press release and remain
  // this file's own projection -- update those separately if/when a confirmed source is found.
  "2026": {
    single: {
      taxYear: "2026",
      ruleVersion: "US Federal 2026 single (IRS Rev. Proc. 2025-32, confirmed)",
      filingStatus: "single",
      federalBrackets: [
        { upTo: 12_400, rate: 0.10 },
        { upTo: 50_400, rate: 0.12 },
        { upTo: 105_700, rate: 0.22 },
        { upTo: 201_775, rate: 0.24 },
        { upTo: 256_225, rate: 0.32 },
        { upTo: 640_600, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 16_100,
      longTermCapGainBrackets: [
        { upTo: 49_450, rate: 0 },
        { upTo: 545_500, rate: 0.15 },
        { upTo: null, rate: 0.20 },
      ],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2026",
      ruleVersion: "US Federal 2026 MFJ (IRS Rev. Proc. 2025-32, confirmed)",
      filingStatus: "mfj",
      federalBrackets: [
        { upTo: 24_800, rate: 0.10 },
        { upTo: 100_800, rate: 0.12 },
        { upTo: 211_400, rate: 0.22 },
        { upTo: 403_550, rate: 0.24 },
        { upTo: 512_450, rate: 0.32 },
        { upTo: 768_700, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 32_200,
      longTermCapGainBrackets: [
        { upTo: 98_900, rate: 0 },
        { upTo: 613_700, rate: 0.15 },
        { upTo: null, rate: 0.20 },
      ],
      longTermHoldingDays: 365,
    },
  },
};

export function listUsTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveUsTaxRules(taxYear: string, filingStatus: UsFilingStatus): UsTaxRules {
  const key = taxYear.trim();
  const yearTable = RULES_BY_YEAR[key] ?? RULES_BY_YEAR[listUsTaxYears()[0]!]!;
  return yearTable[filingStatus];
}
