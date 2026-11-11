/** Arizona individual income tax rules. 2019-2021 brackets verified against ARS 43-1011 (the
 * statutory table enacted for tax years beginning after 2018, before the 2021+ flat-tax
 * phase-in) -- unlike CA/federal, these AZ brackets weren't inflation-indexed year to year, so
 * 2019-2021 share the same thresholds. SB 1828 (2021) then compressed the four brackets to two
 * for tax year 2022 (2.55% / 2.98%, thresholds confirmed via the bill's own legislative summary),
 * before the flat-tax trigger in that same bill took effect: ADOR/JLBC confirmed in Sept 2022 that
 * the state revenue threshold was met, so tax year 2023 and every year after uses a single flat
 * 2.5% rate (ARS 43-1011, confirmed). AZ conformed to the federal standard deduction starting the
 * 2019 tax year (and dropped personal/dependent exemptions), so `standardDeduction` here matches
 * the federal amount for each year -- copied from lib/tax-usa-rules.ts's own figures for the same
 * year so the two stay in sync.
 *
 * NOT modeled: the 2021-tax-year-only 3.5% Proposition 208 "education surcharge" on income above
 * $250,000 single / $500,000 MFJ. Its legal status for TY2021 filings is genuinely contested
 * (struck down by the AZ Supreme Court in 2022, but the retroactive effect on already-filed 2021
 * returns isn't something this app's research could confirm one way or the other) -- a high
 * earner's actual 2021 AZ liability may differ from this estimate for that reason. */

import type { UsBracket, UsFilingStatus } from "./tax-usa-rules";

export interface AzTaxRules {
  taxYear: string;
  ruleVersion: string;
  filingStatus: UsFilingStatus;
  brackets: UsBracket[];
  standardDeduction: number;
}

const AZ_BRACKETS_2019_2021: Record<UsFilingStatus, UsBracket[]> = {
  single: [
    { upTo: 26_500, rate: 0.0259 }, { upTo: 53_000, rate: 0.0334 },
    { upTo: 159_000, rate: 0.0417 }, { upTo: null, rate: 0.045 },
  ],
  mfj: [
    { upTo: 53_000, rate: 0.0259 }, { upTo: 106_000, rate: 0.0334 },
    { upTo: 318_000, rate: 0.0417 }, { upTo: null, rate: 0.045 },
  ],
};
// SB 1828's two-bracket transition year (tax year 2022 only).
const AZ_BRACKETS_2022: Record<UsFilingStatus, UsBracket[]> = {
  single: [{ upTo: 27_272, rate: 0.0255 }, { upTo: null, rate: 0.0298 }],
  mfj: [{ upTo: 54_544, rate: 0.0255 }, { upTo: null, rate: 0.0298 }],
};
// Flat 2.5%, tax year 2023 onward.
const AZ_BRACKETS_FLAT: Record<UsFilingStatus, UsBracket[]> = {
  single: [{ upTo: null, rate: 0.025 }],
  mfj: [{ upTo: null, rate: 0.025 }],
};

function azYear(
  year: string,
  label: string,
  brackets: Record<UsFilingStatus, UsBracket[]>,
  stdDedSingle: number,
  stdDedMfj: number
): Record<UsFilingStatus, AzTaxRules> {
  return {
    single: {
      taxYear: year, ruleVersion: `AZ DOR ${year} single (${label})`, filingStatus: "single",
      brackets: brackets.single, standardDeduction: stdDedSingle,
    },
    mfj: {
      taxYear: year, ruleVersion: `AZ DOR ${year} MFJ (${label})`, filingStatus: "mfj",
      brackets: brackets.mfj, standardDeduction: stdDedMfj,
    },
  };
}

const RULES_BY_YEAR: Record<string, Record<UsFilingStatus, AzTaxRules>> = {
  "2019": azYear("2019", "ARS 43-1011, published", AZ_BRACKETS_2019_2021, 12_200, 24_400),
  "2020": azYear("2020", "ARS 43-1011, published", AZ_BRACKETS_2019_2021, 12_400, 24_800),
  "2021": azYear("2021", "ARS 43-1011, published -- excludes Prop 208 surcharge, see file comment", AZ_BRACKETS_2019_2021, 12_550, 25_100),
  "2022": azYear("2022", "SB 1828 two-bracket transition, published", AZ_BRACKETS_2022, 12_950, 25_900),
  "2023": azYear("2023", "flat 2.5% (ADOR/JLBC revenue-trigger notice, confirmed)", AZ_BRACKETS_FLAT, 13_850, 27_700),
  "2024": azYear("2024", "flat 2.5% (ARS 43-1011, confirmed)", AZ_BRACKETS_FLAT, 14_600, 29_200),
  "2025": azYear("2025", "flat 2.5% (ARS 43-1011, confirmed); std. deduction is federal estimate", AZ_BRACKETS_FLAT, 15_000, 30_000),
  "2026": azYear("2026", "flat 2.5% (ARS 43-1011, confirmed)", AZ_BRACKETS_FLAT, 16_100, 32_200),
};

export function listAzTaxYears(): string[] {
  return Object.keys(RULES_BY_YEAR).sort().reverse();
}

export function resolveAzTaxRules(taxYear: string, filingStatus: UsFilingStatus): AzTaxRules {
  const key = taxYear.trim();
  const exact = RULES_BY_YEAR[key];
  if (exact) return exact[filingStatus];
  // No table for this year at all -- fall back to the newest year we do have, but say so plainly
  // in ruleVersion (surfaced directly in TaxReport.tsx's UI) rather than silently returning that
  // fallback year's own normal label as if it matched the year actually requested.
  const fallbackYear = listAzTaxYears()[0]!;
  const fallback = RULES_BY_YEAR[fallbackYear]![filingStatus];
  return {
    ...fallback,
    taxYear: key,
    ruleVersion: `AZ: no rules modeled for ${key} -- showing ${fallbackYear} figures (unverified for ${key})`,
  };
}
