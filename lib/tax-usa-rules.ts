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
  "2026": {
    single: {
      taxYear: "2026",
      ruleVersion: "US Federal 2026 single (projected)",
      filingStatus: "single",
      federalBrackets: [
        { upTo: 12_400, rate: 0.10 },
        { upTo: 50_400, rate: 0.12 },
        { upTo: 105_700, rate: 0.22 },
        { upTo: 201_050, rate: 0.24 },
        { upTo: 255_000, rate: 0.32 },
        { upTo: 640_600, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 15_750,
      longTermCapGainBrackets: [
        { upTo: 49_450, rate: 0 },
        { upTo: 545_500, rate: 0.15 },
        { upTo: null, rate: 0.20 },
      ],
      longTermHoldingDays: 365,
    },
    mfj: {
      taxYear: "2026",
      ruleVersion: "US Federal 2026 MFJ (projected)",
      filingStatus: "mfj",
      federalBrackets: [
        { upTo: 24_800, rate: 0.10 },
        { upTo: 100_800, rate: 0.12 },
        { upTo: 211_400, rate: 0.22 },
        { upTo: 402_100, rate: 0.24 },
        { upTo: 510_000, rate: 0.32 },
        { upTo: 768_700, rate: 0.35 },
        { upTo: null, rate: 0.37 },
      ],
      standardDeduction: 31_500,
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
