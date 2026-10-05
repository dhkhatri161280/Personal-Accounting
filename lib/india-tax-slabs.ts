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
  // Gap (AY2018-19 through AY2023-24) all model the OLD regime -- the only regime that existed
  // through AY2020-21, and still the one actually in effect for AY2021-22 through AY2023-24 when
  // the (then-optional, then-less-favorable-for-most-filers) new regime existed alongside it but
  // wasn't the default. The old-regime bracket structure itself (2.5L/5L/10L cutoffs, 5/20/30%)
  // hasn't changed since AY2018-19 -- only cess and the Section 87A rebate moved during this
  // stretch. New regime for these specific years is NOT modeled here (confirm with 2026-10-04
  // decision: this app models whichever regime the user actually filed under per year, and new
  // regime wasn't the user's choice before AY2024-25).
  "2018-19": { // FY2017-18
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.03, // last year of the old 3% Education Cess, before it became 4% Health & Education Cess
    rebate87A: { maxIncome: 350000, maxRebate: 2500 },
  },
  "2019-20": { // FY2018-19
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 350000, maxRebate: 2500 },
  },
  "2020-21": { // FY2019-20 -- July 2019 interim budget raised the 87A rebate ceiling from 3.5L to
    // 5L and the rebate itself from 2,500 to 12,500 (the "no tax up to 5L" headline); this
    // threshold/amount then held unchanged for the old regime every year since.
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 500000, maxRebate: 12500 },
  },
  "2021-22": { // FY2020-21 -- new (optional) regime introduced this year alongside old; old
    // regime itself unchanged from AY2020-21.
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 500000, maxRebate: 12500 },
  },
  "2022-23": { // FY2021-22
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 500000, maxRebate: 12500 },
  },
  "2023-24": { // FY2022-23
    brackets: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 500000, maxRebate: 12500 },
  },
  // AY2024-25 onward switches to the NEW regime per 2026-10-04 decision -- it became the DEFAULT
  // regime starting this year (Budget 2023), so this is the realistic choice for most filers from
  // here on without an explicit old-regime opt-in. The new regime's own slabs were revised twice
  // more since (Budget 2024, Budget 2025) -- each year below has its own distinct bracket set and
  // rebate, not a shared constant like the old-regime years above.
  "2024-25": { // FY2023-24 -- new regime's post-Budget-2023 slabs; 87A rebate raised to cover
    // taxable income up to 7L (full rebate, up to Rs 25,000) -- the "no tax up to 7L" headline.
    brackets: [
      { upTo: 300000, rate: 0 },
      { upTo: 600000, rate: 0.05 },
      { upTo: 900000, rate: 0.1 },
      { upTo: 1200000, rate: 0.15 },
      { upTo: 1500000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 700000, maxRebate: 25000 },
  },
  "2025-26": { // FY2024-25 -- new regime slabs widened slightly (Budget July 2024, the 6-9L
    // bracket became 7-10L); 87A rebate unchanged from AY2024-25 (still 7L / Rs 25,000).
    brackets: [
      { upTo: 300000, rate: 0 },
      { upTo: 700000, rate: 0.05 },
      { upTo: 1000000, rate: 0.1 },
      { upTo: 1200000, rate: 0.15 },
      { upTo: 1500000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 700000, maxRebate: 25000 },
  },
  "2026-27": { // FY2025-26 -- new regime majorly revised (Budget Feb 2025, "no tax up to 12L"):
    // wider brackets, a new 24L+ top bracket at 30% (25% tier added below it), and the 87A rebate
    // ceiling jumped from 7L to 12L (rebate amount up to Rs 60,000) -- this is the headline change
    // that made income up to 12L (12.75L for salaried, after the unchanged Rs 75,000 standard
    // deduction) effectively tax-free under the new regime.
    brackets: [
      { upTo: 400000, rate: 0 },
      { upTo: 800000, rate: 0.05 },
      { upTo: 1200000, rate: 0.1 },
      { upTo: 1600000, rate: 0.15 },
      { upTo: 2000000, rate: 0.2 },
      { upTo: 2400000, rate: 0.25 },
      { upTo: Infinity, rate: 0.3 },
    ],
    cessRate: 0.04,
    rebate87A: { maxIncome: 1200000, maxRebate: 60000 },
  },
  // AY2027-28 (FY2026-27, the CURRENT ongoing fiscal year as of this comment) is deliberately NOT
  // included -- its slabs depend on Union Budget 2026 (presented ~Feb 2026), which postdates this
  // data's own knowledge with high confidence. Per this file's own "don't silently guess"
  // convention (see the top-of-file comment and hasIndiaTaxSlabsFor), the slab-estimate helper
  // will correctly just not appear for AY2027-28 until a real, verified bracket set is added here
  // -- do not add a guessed entry for it.
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
