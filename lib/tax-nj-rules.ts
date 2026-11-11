/** New Jersey gross income tax rules. NJ doesn't have a federal-style standard deduction --
 * `standardDeduction` here models the NJ personal exemption ($1,000/exemption: self + spouse
 * for MFJ), which NJ allows on top of (not instead of) other allowable deductions.
 *
 * NJ brackets below $500,000 haven't changed since well before 2016 and NJ doesn't inflation-index
 * them, so only the TOP of the schedule actually varies by year -- modeled below as three brackets
 * "eras" reused across the years they applied, rather than a full table repeated per year:
 *   2016-2017: flat 8.97% on everything above $500,000 (no higher bracket existed yet).
 *   2018-2019: the original "millionaires tax" added a 10.75% bracket, but only above $5,000,000
 *     (P.L. 2018, c. 48) -- $500,000-$5,000,000 stayed at 8.97%.
 *   2020-2026: the 10.75% bracket's threshold was lowered to $1,000,000 (P.L. 2020, c. 94, often
 *     called "S2021") and has not changed since -- $500,000-$1,000,000 stays at 8.97%, 10.75%
 *     applies above $1,000,000. No source found reporting any further change through 2026.
 * The personal exemption amount is similarly a fixed NJ statutory figure, not inflation-indexed --
 * unchanged across all years below. These brackets/exemption are reconstructed from NJ Division of
 * Taxation guidance and the legislative history above, not individually verified against every
 * year's own NJ-1040 instructions -- same "estimate, not line-by-line verified" caveat
 * lib/tax-ca-rules.ts already uses for its own backward-extrapolated years. */

import type { UsBracket, UsFilingStatus } from "./tax-usa-rules";

export interface NjTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  brackets: UsBracket[];
  standardDeduction: number;
}

const NJ_LOWER_SINGLE: UsBracket[] = [
  { upTo: 20_000, rate: 0.014 }, { upTo: 35_000, rate: 0.0175 }, { upTo: 40_000, rate: 0.035 },
  { upTo: 75_000, rate: 0.05525 },
];
const NJ_LOWER_MFJ: UsBracket[] = [
  { upTo: 20_000, rate: 0.014 }, { upTo: 50_000, rate: 0.0175 }, { upTo: 70_000, rate: 0.0245 },
  { upTo: 80_000, rate: 0.035 }, { upTo: 150_000, rate: 0.05525 },
];

// Top-of-schedule "eras" -- see the file comment above for what changed and when.
const NJ_TOP_2016_2017: UsBracket[] = [{ upTo: 500_000, rate: 0.0637 }, { upTo: null, rate: 0.0897 }];
const NJ_TOP_2018_2019: UsBracket[] = [
  { upTo: 500_000, rate: 0.0637 }, { upTo: 5_000_000, rate: 0.0897 }, { upTo: null, rate: 0.1075 },
];
const NJ_TOP_2020_PLUS: UsBracket[] = [
  { upTo: 500_000, rate: 0.0637 }, { upTo: 1_000_000, rate: 0.0897 }, { upTo: null, rate: 0.1075 },
];

function njYear(year: string, label: string, top: UsBracket[]): Record<UsFilingStatus, NjTaxRules> {
  return {
    single: {
      taxYear: year, ruleVersion: `NJ Treasury ${year} single (${label})`, filingStatus: "single",
      brackets: [...NJ_LOWER_SINGLE, ...top], standardDeduction: 1_000,
    },
    mfj: {
      taxYear: year, ruleVersion: `NJ Treasury ${year} MFJ (${label})`, filingStatus: "mfj",
      brackets: [...NJ_LOWER_MFJ, ...top], standardDeduction: 2_000,
    },
  };
}

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, NjTaxRules>> = {
  "2016": njYear("2016", "published", NJ_TOP_2016_2017),
  "2017": njYear("2017", "reconstructed, no bracket change from 2016", NJ_TOP_2016_2017),
  "2018": njYear("2018", "reconstructed -- P.L. 2018 c.48 added the 10.75% bracket above $5M", NJ_TOP_2018_2019),
  "2019": njYear("2019", "reconstructed, no bracket change from 2018", NJ_TOP_2018_2019),
  "2020": njYear("2020", "reconstructed -- P.L. 2020 c.94 lowered the 10.75% threshold to $1M", NJ_TOP_2020_PLUS),
  "2021": njYear("2021", "reconstructed, no bracket change from 2020", NJ_TOP_2020_PLUS),
  "2022": njYear("2022", "reconstructed, no bracket change reported", NJ_TOP_2020_PLUS),
  "2023": njYear("2023", "reconstructed, no bracket change reported", NJ_TOP_2020_PLUS),
  "2024": njYear("2024", "reconstructed, no bracket change reported", NJ_TOP_2020_PLUS),
  "2025": njYear("2025", "reconstructed, no bracket change reported", NJ_TOP_2020_PLUS),
  "2026": njYear("2026", "reconstructed, no bracket change reported", NJ_TOP_2020_PLUS),
};

export function listNjTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveNjTaxRules(taxYear: string, filingStatus: UsFilingStatus): NjTaxRules {
  const key = taxYear.trim();
  const exact = RULES_BY_YEAR[key];
  if (exact) return exact[filingStatus];
  // No table for this year at all -- fall back to the newest year we do have, but say so plainly
  // in ruleVersion (surfaced directly in TaxReport.tsx's UI) instead of silently returning that
  // fallback year's own normal label as if it were an exact match for the year the user actually
  // asked for. Same "don't silently guess" instinct lib/india-tax-slabs.ts already follows for an
  // unmodeled Assessment Year.
  const fallbackYear = listNjTaxYears()[0]!;
  const fallback = RULES_BY_YEAR[fallbackYear]![filingStatus];
  return {
    ...fallback,
    taxYear: key,
    ruleVersion: `NJ: no rules modeled for ${key} -- showing ${fallbackYear} figures (unverified for ${key})`,
  };
}
