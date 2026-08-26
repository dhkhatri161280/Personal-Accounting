// Historical Indian individual income-tax slabs, by Assessment Year, for a resident individual
// below 60 (the "male"/general slab in years that still distinguished by sex/age -- women and
// senior citizens had a slightly higher exemption threshold pre-AY2013-14, not modeled here).
// This is an ESTIMATE for cross-checking a filed return, not a substitute for it: real returns
// can include surcharge tiers, other-head income, TDS credit nuances, and rounding rules beyond
// what's modeled here. Only Assessment Years actually covered by this app's data are included --
// unlisted years return null rather than silently guessing.

interface SlabBracket {
  upTo: number; // slab ceiling (Infinity for the top bracket)
  rate: number; // 0.1 = 10%
}

interface AySlabConfig {
  brackets: SlabBracket[];
  cessRate: number; // education + secondary/higher-education cess, applied to tax after rebate
  rebate87A?: { maxIncome: number; maxRebate: number };
  surchargeThreshold?: number; // total income above which a surcharge applies to the base tax
  surchargeRate?: number;
}

const SLABS: Record<string, AySlabConfig> = {
  "2006-07": { // FY2005-06
    brackets: [
      { upTo: 100000, rate: 0 },
      { upTo: 150000, rate: 0.1 },
      { upTo: 250000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.02,
  },
  "2007-08": { // FY2006-07
    brackets: [
      { upTo: 100000, rate: 0 },
      { upTo: 150000, rate: 0.1 },
      { upTo: 250000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.02,
  },
  "2008-09": { // FY2007-08
    brackets: [
      { upTo: 110000, rate: 0 },
      { upTo: 150000, rate: 0.1 },
      { upTo: 250000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2009-10": { // FY2008-09
    brackets: [
      { upTo: 150000, rate: 0 },
      { upTo: 300000, rate: 0.1 },
      { upTo: 500000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2010-11": { // FY2009-10
    brackets: [
      { upTo: 160000, rate: 0 },
      { upTo: 300000, rate: 0.1 },
      { upTo: 500000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2011-12": { // FY2010-11
    brackets: [
      { upTo: 160000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 800000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2012-13": { // FY2011-12
    brackets: [
      { upTo: 180000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 800000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2013-14": { // FY2012-13
    brackets: [
      { upTo: 200000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
  },
  "2014-15": { // FY2013-14
    brackets: [
      { upTo: 200000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
    rebate87A: { maxIncome: 500000, maxRebate: 2000 },
  },
  "2015-16": { // FY2014-15
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
    rebate87A: { maxIncome: 500000, maxRebate: 2000 },
  },
  "2016-17": { // FY2015-16
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
    rebate87A: { maxIncome: 500000, maxRebate: 2000 },
  },
  "2017-18": { // FY2016-17
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.1 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03,
    rebate87A: { maxIncome: 350000, maxRebate: 5000 },
  },
};

function applyBrackets(income: number, brackets: SlabBracket[]): number {
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (income <= prev) break;
    const upper = Math.min(income, b.upTo);
    if (upper > prev) tax += (upper - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

/** Estimated tax payable (incl. cess, rebate, and a simple >10L surcharge where applicable) on
 * a given taxable income for an Assessment Year -- null if that AY's slabs aren't modeled here,
 * so callers can fall back to "no estimate available" rather than a silently wrong number. */
export function estimateIndiaTax(assessmentYear: string, taxableIncome: number): number | null {
  const config = SLABS[assessmentYear];
  if (!config || taxableIncome <= 0) return config ? 0 : null;
  let tax = applyBrackets(taxableIncome, config.brackets);
  if (config.rebate87A && taxableIncome <= config.rebate87A.maxIncome) {
    tax = Math.max(0, tax - config.rebate87A.maxRebate);
  }
  if (config.surchargeThreshold && taxableIncome > config.surchargeThreshold) {
    tax *= 1 + (config.surchargeRate ?? 0.1);
  }
  return Math.round(tax * (1 + config.cessRate));
}

export function hasIndiaTaxSlabsFor(assessmentYear: string): boolean {
  return assessmentYear in SLABS;
}

/** Exposes the same per-AY cess rate the slab estimate uses, for other calculators (e.g. capital
 * gains special-rate tax) that need to apply the identical cess without duplicating this table --
 * null for an AY not modeled here, same "don't silently guess" convention as estimateIndiaTax. */
export function cessRateFor(assessmentYear: string): number | null {
  return SLABS[assessmentYear]?.cessRate ?? null;
}

/** Section 80C's combined cap (LIC, NSC, PPF, ELSS, PF, etc. all count against ONE limit, not
 * one each) -- raised from Rs 1,00,000 to Rs 1,50,000 starting FY2014-15 (AY2015-16). */
export function section80CCap(assessmentYear: string): number {
  const startYear = Number(assessmentYear.slice(0, 4));
  return Number.isFinite(startYear) && startYear >= 2015 ? 150000 : 100000;
}

/** Section 80D's real limit depends on age and whether the premium covers self/family vs
 * parents (self & family: Rs 15,000 pre-AY2016-17, Rs 25,000 from AY2016-17, Rs 25,000/50,000
 * more for parents depending on senior-citizen status) -- modeling every combination isn't
 * practical here, so this is one flat umbrella cap across all years, per what was asked for. */
export const SECTION_80D_CAP = 50000;

/** Section 24(b)'s self-occupied home loan interest deduction cap -- Rs 1,50,000 through
 * AY2014-15, raised to Rs 2,00,000 from AY2015-16 (FY2014-15) onward via Finance Act 2014.
 * Assumes a self-occupied property (the common case); a let-out property has no cap at all,
 * which isn't modeled here. */
export function section24bHomeLoanInterestCap(assessmentYear: string): number {
  const startYear = Number(assessmentYear.slice(0, 4));
  return Number.isFinite(startYear) && startYear >= 2015 ? 200000 : 150000;
}
