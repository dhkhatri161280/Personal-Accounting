import { estimateUsFederalTax, computeHsaDeduction, get401kLimit, getHsaLimit, type HsaCoverage } from "./tax-usa-engine";
import { type UsFilingStatus } from "./tax-usa-rules";
import { estimateCaStateTax } from "./tax-ca-engine";
import { estimateNjStateTax } from "./tax-nj-engine";
import { estimateAzStateTax } from "./tax-az-engine";
import type { StateCode } from "./tax-state-residency";
import type { RsuGrant, EsppPurchase } from "./vault-types";

/** Estimated-tax-only "what if" scenarios computed by this app's own deterministic tax engines
 * -- no external AI/LLM call, no data leaves the app. Every number here is a projection built
 * on the same rate tables and formulas as the rest of the Tax report, not personalized advice
 * from a licensed preparer; every scenario should stay framed as an estimate, not a directive.
 *
 * Every scenario is computed against a PROJECTED full tax year, not just year-to-date actuals:
 * remaining semi-monthly paychecks are estimated from the average of the paychecks received so
 * far, and any shares still scheduled to vest before year-end are added at today's live price.
 * See computeFullYearProjection() below. */

export interface TaxPlanningScenario {
  id: string;
  category: "Contribution Room" | "Equity Timing" | "Deduction Strategy" | "Withholding" | "Informational";
  title: string;
  description: string;
  fedSavings: number; // >= 0, estimated dollars
  stateSavings: number; // >= 0, estimated dollars (0 if the state doesn't allow the deduction)
  totalSavings: number;
  deadline?: string; // ISO date, if action has a natural cutoff
  caveat?: string; // shown as fine print under the card
  actionable: boolean; // false = informational-only card (already maxed out, already itemizing, etc.)
  hypothetical?: boolean; // true = contingent on a decision the user hasn't indicated they'll make (e.g. selling shares) -- rendered without the urgent "up to $X" styling
}

export interface FullYearProjection {
  periodsPerYear: number;
  periodsElapsed: number;
  periodsRemaining: number;
  regularGrossYtd: number; // totalGross minus this year's already-vested RSU/ESPP value
  avgRegularGrossPerPeriod: number;
  projectedRemainingGross: number;
  futureVestShares: number;
  futureVestValue: number; // shares still scheduled to vest this year x today's live price
  livePriceUsed: number | null;
  fullYearGross: number;
  fullYearFederalWithheld: number;
  fullYearStateWithheld: number;
  fullYearMedicareWages: number;
  fullYearMedicareWithheld: number;
  fullYearK401: number;
  projectedFederalTax: number;
  projectedStateTax: number;
  projectedFederalBalanceDue: number;
}

export interface TaxPlanningInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  stateCode: StateCode;
  stateName: string;
  longTermHoldingDays: number;

  // Year-to-date actuals -- same figures TaxReport.tsx already computes for its own display.
  taxableWages: number; // totalGross - totalK401 (YTD)
  totalGross: number;
  totalFederal: number;
  totalMedicare: number;
  shortTermGainTaxable: number;
  longTermGainTaxable: number;
  capitalLossDeduction: number;
  federalItemizedTotal: number;
  hsaContributionTotal: number;
  hsaCoverage: HsaCoverage;
  totalK401: number;

  // State inputs.
  totalStateWH: number;
  stateItemizedTotal: number;
  stateHsaConforms: boolean; // AZ conforms; CA/NJ don't (HSA added back to state AGI)

  baselineFederalStandardDeduction: number;

  // Equity data for the full-year projection and the RSU/ESPP hold-timing scan.
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
  livePrice: number | null;
  todayIso: string;
}

export interface TaxPlanningResult {
  scenarios: TaxPlanningScenario[];
  projection: FullYearProjection;
}

function estimateState(
  stateCode: StateCode,
  taxYear: string,
  filingStatus: UsFilingStatus,
  agi: number,
  itemizedOrPropertyTax: number,
  stateWithheld: number
): number {
  if (stateCode === "NJ") {
    return estimateNjStateTax({ taxYear, filingStatus, agi, propertyTax: itemizedOrPropertyTax, stateWithheld }).estimatedTax;
  }
  if (stateCode === "AZ") {
    return estimateAzStateTax({ taxYear, filingStatus, agi, itemizedDeduction: itemizedOrPropertyTax, stateWithheld }).estimatedTax;
  }
  return estimateCaStateTax({ taxYear, filingStatus, agi, itemizedDeduction: itemizedOrPropertyTax, stateWithheld }).estimatedTax;
}

function daysBetween(isoDate: string, todayIso: string): number {
  return Math.round((new Date(todayIso).getTime() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

// Semi-monthly (paid on the 1st-15th and 16th-end of every month) -- this app's payroll import
// always uses this cadence (see PayrollYear.periodLabels), i.e. 24 paychecks/year.
const PERIODS_PER_YEAR = 24;

function semiMonthlyPeriodsElapsed(taxYear: string, todayIso: string): number {
  const yearNum = Number(taxYear);
  const today = new Date(todayIso + "T00:00:00Z");
  if (today.getUTCFullYear() > yearNum) return PERIODS_PER_YEAR;
  if (today.getUTCFullYear() < yearNum) return 0;
  const half = today.getUTCDate() <= 15 ? 1 : 2;
  return today.getUTCMonth() * 2 + half; // 1..24
}

/** Projects the rest of the tax year forward from what's already happened: remaining paychecks
 * are estimated from the average of the paychecks received so far (excluding RSU/ESPP vest
 * value, which is projected separately from the actual vesting schedule, not averaged), and
 * shares still scheduled to vest before year-end are added at today's live price. */
export function computeFullYearProjection(input: TaxPlanningInput): FullYearProjection {
  const {
    taxYear, filingStatus, stateCode, totalGross, totalFederal, totalMedicare, totalStateWH, totalK401,
    shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction, federalItemizedTotal,
    hsaContributionTotal, hsaCoverage, stateHsaConforms, stateItemizedTotal, grants, livePrice, todayIso,
  } = input;

  const periodsElapsed = semiMonthlyPeriodsElapsed(taxYear, todayIso);
  const periodsRemaining = Math.max(0, PERIODS_PER_YEAR - periodsElapsed);

  const allVests = grants.flatMap((g) => g.vests.map((v) => ({ grant: g, vest: v })));
  const historicalVestValueThisYear = allVests
    .filter(({ vest }) => !vest.pending && vest.vestDate.startsWith(taxYear))
    .reduce((s, { vest }) => s + vest.shares * vest.vestPrice, 0);
  const futureVests = allVests.filter(({ vest }) => vest.pending && vest.vestDate.startsWith(taxYear));
  const futureVestShares = futureVests.reduce((s, { vest }) => s + vest.shares, 0);
  const futureVestValue = livePrice && livePrice > 0 ? futureVestShares * livePrice : 0;

  const regularGrossYtd = Math.max(0, totalGross - historicalVestValueThisYear);
  const avgRegularGrossPerPeriod = periodsElapsed > 0 ? regularGrossYtd / periodsElapsed : 0;
  const projectedRemainingGross = avgRegularGrossPerPeriod * periodsRemaining;

  const avgFederalPerPeriod = periodsElapsed > 0 ? totalFederal / periodsElapsed : 0;
  const avgStateWHPerPeriod = periodsElapsed > 0 ? totalStateWH / periodsElapsed : 0;
  const avgMedicarePerPeriod = periodsElapsed > 0 ? totalMedicare / periodsElapsed : 0;
  const avgK401PerPeriod = periodsElapsed > 0 ? totalK401 / periodsElapsed : 0;

  const fullYearGross = totalGross + projectedRemainingGross + futureVestValue;
  const fullYearFederalWithheld = totalFederal + avgFederalPerPeriod * periodsRemaining;
  const fullYearStateWithheld = totalStateWH + avgStateWHPerPeriod * periodsRemaining;
  const fullYearMedicareWages = fullYearGross;
  const fullYearMedicareWithheld = totalMedicare + avgMedicarePerPeriod * periodsRemaining;
  const fullYearK401 = Math.min(totalK401 + avgK401PerPeriod * periodsRemaining, get401kLimit(taxYear));

  const projTaxableWages = Math.max(0, fullYearGross - fullYearK401);
  const hsaDeduction = computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal);
  const fed = estimateUsFederalTax({
    taxYear, filingStatus, wages: projTaxableWages, federalWithheld: fullYearFederalWithheld,
    medicareWages: fullYearMedicareWages, medicareWithheld: fullYearMedicareWithheld,
    shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
    aboveLineDeduction: hsaDeduction, itemizedDeduction: federalItemizedTotal,
  });
  const stateAgi = stateHsaConforms ? fed.agi : fed.agi + fed.aboveLineDeduction;
  const projectedStateTax = estimateState(stateCode, taxYear, filingStatus, stateAgi, stateItemizedTotal, fullYearStateWithheld);

  return {
    periodsPerYear: PERIODS_PER_YEAR, periodsElapsed, periodsRemaining,
    regularGrossYtd, avgRegularGrossPerPeriod, projectedRemainingGross,
    futureVestShares, futureVestValue, livePriceUsed: livePrice ?? null,
    fullYearGross, fullYearFederalWithheld, fullYearStateWithheld,
    fullYearMedicareWages, fullYearMedicareWithheld, fullYearK401,
    projectedFederalTax: fed.estimatedTax, projectedStateTax, projectedFederalBalanceDue: fed.balanceDue,
  };
}

export function computeTaxPlanningScenarios(input: TaxPlanningInput): TaxPlanningResult {
  const scenarios: TaxPlanningScenario[] = [];
  const {
    taxYear, filingStatus, stateCode, stateName, longTermHoldingDays,
    shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
    federalItemizedTotal, hsaContributionTotal, hsaCoverage,
    stateItemizedTotal, stateHsaConforms, baselineFederalStandardDeduction,
    grants, esppPurchases, livePrice, todayIso,
  } = input;

  const projection = computeFullYearProjection(input);
  const { fullYearGross, fullYearFederalWithheld, fullYearMedicareWages, fullYearMedicareWithheld, fullYearK401 } = projection;
  const taxableWages = Math.max(0, fullYearGross - fullYearK401);
  const totalGross = fullYearGross;
  const totalFederal = fullYearFederalWithheld;
  const totalMedicare = fullYearMedicareWithheld;
  const totalK401 = fullYearK401;
  const baselineFederalTax = projection.projectedFederalTax;
  const baselineStateTax = projection.projectedStateTax;
  const baselineFederalBalanceDue = projection.projectedFederalBalanceDue;

  function stateAgiFor(federalAgi: number, aboveLineDeduction: number): number {
    return stateHsaConforms ? federalAgi : federalAgi + aboveLineDeduction;
  }

  // ── 1. Additional traditional 401(k) contribution ─────────────────────────────────────
  {
    const limit = get401kLimit(taxYear);
    const room = Math.max(0, Math.round(limit - totalK401));
    if (room > 0) {
      const newTaxableWages = Math.max(0, taxableWages - room);
      const newFed = estimateUsFederalTax({
        taxYear, filingStatus, wages: newTaxableWages, federalWithheld: totalFederal,
        medicareWages: fullYearMedicareWages, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal),
        itemizedDeduction: federalItemizedTotal,
      });
      const fedSavings = Math.max(0, baselineFederalTax - newFed.estimatedTax);
      const newStateAgi = stateAgiFor(newFed.agi, newFed.aboveLineDeduction);
      const newStateTax = estimateState(stateCode, taxYear, filingStatus, newStateAgi, stateItemizedTotal, projection.fullYearStateWithheld);
      const stateSavings = Math.max(0, baselineStateTax - newStateTax);
      scenarios.push({
        id: "401k-room",
        category: "Contribution Room",
        title: `Contribute the remaining $${room.toLocaleString()} of 401(k) room`,
        description: `Projecting your pay through the end of ${taxYear} (remaining paychecks plus any shares still scheduled to vest), you're on track to contribute about $${Math.round(totalK401).toLocaleString()} of the $${limit.toLocaleString()} traditional 401(k) limit. If you don't change anything, your projected federal tax for the year is about $${Math.round(baselineFederalTax).toLocaleString()}. Contributing the remaining $${room.toLocaleString()} pretax instead (e.g. bumping up the percentage on your remaining paychecks) would bring that down to about $${Math.round(newFed.estimatedTax).toLocaleString()}.`,
        fedSavings, stateSavings, totalSavings: fedSavings + stateSavings,
        deadline: `${taxYear}-12-31`,
        caveat: "Assumes a traditional (not Roth) 401(k) and holds your other deductions constant. Doesn't model the age-50+ catch-up limit. In practice you can only raise your contribution rate on paychecks you haven't been paid yet, so how much of this $" + room.toLocaleString() + " you can actually reach depends on how many pay periods are left when you make the change.",
        actionable: true,
      });
    } else {
      scenarios.push({
        id: "401k-room",
        category: "Contribution Room",
        title: "401(k) already on track to be maxed out",
        description: `Projecting your pay through the end of ${taxYear}, you're on track to contribute about $${Math.round(totalK401).toLocaleString()} of the $${limit.toLocaleString()} limit — no additional pretax room expected this year.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  // ── 2. Traditional vs. Roth mix (informational -- no dollar figure fabricated) ─────────
  scenarios.push({
    id: "401k-roth-mix",
    category: "Informational",
    title: "Traditional vs. Roth 401(k): which kind of contribution?",
    description: "Traditional 401(k) money comes out of your paycheck before tax, which is the savings modeled above — it lowers this year's tax bill, but you'll pay tax on it (and its growth) when you withdraw it in retirement. Roth 401(k) money is taxed now (no savings today) but comes out completely tax-free in retirement, including all its growth. Rule of thumb: if you expect to be in a lower tax bracket in retirement than you are now, traditional tends to come out ahead; if you expect a similar or higher bracket later, Roth tends to come out ahead. This app has no way to know your future tax bracket, so it can't put a dollar figure on this one — it's a judgment call for you (and maybe your CPA), not a calculation.",
    fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
  });

  // ── 3. HSA max-out ──────────────────────────────────────────────────────────────────────
  {
    const limit = getHsaLimit(taxYear, hsaCoverage);
    const room = Math.max(0, Math.round(limit - hsaContributionTotal));
    if (room > 0) {
      const newHsaDeduction = computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal + room);
      const newFed = estimateUsFederalTax({
        taxYear, filingStatus, wages: taxableWages, federalWithheld: totalFederal,
        medicareWages: fullYearMedicareWages, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: newHsaDeduction,
        itemizedDeduction: federalItemizedTotal,
      });
      const fedSavings = Math.max(0, baselineFederalTax - newFed.estimatedTax);
      const newStateAgi = stateAgiFor(newFed.agi, newFed.aboveLineDeduction);
      const newStateTax = estimateState(stateCode, taxYear, filingStatus, newStateAgi, stateItemizedTotal, projection.fullYearStateWithheld);
      const stateSavings = Math.max(0, baselineStateTax - newStateTax);
      scenarios.push({
        id: "hsa-room",
        category: "Contribution Room",
        title: `Contribute the remaining $${room.toLocaleString()} of HSA room`,
        description: `You've put in $${Math.round(hsaContributionTotal).toLocaleString()} so far this year of the $${limit.toLocaleString()} ${taxYear} HSA limit (${hsaCoverage === "family" ? "family" : "self-only"} coverage). HSA contributions are a direct, dollar-for-dollar deduction — unlike 401(k), they don't depend on how many paychecks are left, since you can also contribute a lump sum directly to the HSA yourself. Putting in the remaining $${room.toLocaleString()} would lower your projected federal tax for the year from about $${Math.round(baselineFederalTax).toLocaleString()} to about $${Math.round(newFed.estimatedTax).toLocaleString()}.`,
        fedSavings, stateSavings, totalSavings: fedSavings + stateSavings,
        deadline: `${Number(taxYear) + 1}-04-15`,
        caveat: stateHsaConforms
          ? "Doesn't model the age-55+ catch-up. Assumes you're still HSA-eligible (enrolled in a qualifying high-deductible plan) for the full year."
          : `${stateName} doesn't conform to federal HSA treatment, so this contribution has no ${stateName} tax benefit — the $0 state savings above is correct, not a bug. Doesn't model the age-55+ catch-up.`,
        actionable: true,
      });
    } else {
      scenarios.push({
        id: "hsa-room",
        category: "Contribution Room",
        title: "HSA already maxed out",
        description: `You've contributed $${Math.round(hsaContributionTotal).toLocaleString()} of the $${limit.toLocaleString()} ${taxYear} limit — no additional room this year.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  // ── 4/5. RSU + ESPP hold-timing scan -- one pass over every currently-held lot. These are
  // purely informational unless/until you actually decide to sell -- there's no action to take
  // today just because a lot shows up here. ─────────────────────────────────────────────────
  if (livePrice && livePrice > 0) {
    for (const grant of grants) {
      for (const vest of grant.vests) {
        if (vest.pending || vest.sharesHeld <= 0) continue;
        const heldDays = daysBetween(vest.vestDate, todayIso);
        const currentValue = vest.sharesHeld * livePrice;
        const costBasis = vest.sharesHeld * vest.vestPrice;
        const unrealizedGain = currentValue - costBasis;
        const id = `rsu-${vest.id}`;
        if (unrealizedGain < 0) {
          scenarios.push({
            id, category: "Equity Timing",
            title: `FYI — ${grant.ticker} shares vested ${vest.vestDate} are currently at a loss`,
            description: `You're not currently planning to sell, so there's nothing to do here — this is just for awareness. ${vest.sharesHeld.toLocaleString()} held shares are worth an estimated $${Math.round(currentValue).toLocaleString()} at today's $${livePrice.toFixed(2)}, vs. a cost basis of $${Math.round(costBasis).toLocaleString()} — an unrealized loss of about $${Math.round(Math.abs(unrealizedGain)).toLocaleString()}. If you ever did sell, that loss could offset other capital gains dollar-for-dollar, or up to $3,000/year against ordinary income.`,
            fedSavings: 0, stateSavings: 0, totalSavings: 0,
            caveat: "Not a $ estimate — the benefit depends on what other gains/income it offsets, and only applies if you actually sell. Watch the wash-sale rule if you'd buy back the same stock within 30 days.",
            actionable: false, hypothetical: true,
          });
        } else if (heldDays < longTermHoldingDays) {
          const ltcgDate = new Date(vest.vestDate);
          ltcgDate.setDate(ltcgDate.getDate() + longTermHoldingDays);
          const ltcgDateIso = ltcgDate.toISOString().slice(0, 10);
          const stNow = estimateUsFederalTax({
            taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: fullYearMedicareWages,
            shortTermGainTaxable: shortTermGainTaxable + unrealizedGain, longTermGainTaxable, capitalLossDeduction,
            itemizedDeduction: federalItemizedTotal,
          });
          const ltNow = estimateUsFederalTax({
            taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: fullYearMedicareWages,
            shortTermGainTaxable, longTermGainTaxable: longTermGainTaxable + unrealizedGain, capitalLossDeduction,
            itemizedDeduction: federalItemizedTotal,
          });
          const fedSavings = Math.max(0, stNow.estimatedTax - ltNow.estimatedTax);
          scenarios.push({
            id, category: "Equity Timing",
            title: `FYI — ${grant.ticker} shares vested ${vest.vestDate}: selling now vs. waiting until ${ltcgDateIso}`,
            description: `You're not currently planning to sell any shares, so there's no action needed here — this only matters if/when you do decide to sell. For reference: ${vest.sharesHeld.toLocaleString()} of these shares vested ${heldDays} days ago. Selling them today would tax the ~$${Math.round(unrealizedGain).toLocaleString()} gain as short-term (the same rate as your salary); waiting until ${ltcgDateIso} — one year after they vested — would let that gain qualify for the lower long-term capital-gains rate instead, worth roughly $${Math.round(fedSavings).toLocaleString()} less federal tax on just this batch of shares, at today's price.`,
            fedSavings, stateSavings: 0, totalSavings: fedSavings,
            deadline: ltcgDateIso,
            caveat: "Assumes the stock price on the long-term-qualifying date equals today's price — the actual price, and therefore the actual gain and tax, will differ. State savings not modeled (long-term rates aren't preferential at the state level here).",
            actionable: false, hypothetical: true,
          });
        }
      }
    }
    for (const p of esppPurchases) {
      if (p.sharesHeld <= 0) continue;
      const heldDays = daysBetween(p.purchaseDate, todayIso);
      const currentValue = p.sharesHeld * livePrice;
      const costBasis = p.sharesHeld * p.purchasePrice;
      const unrealizedGain = currentValue - costBasis;
      const id = `espp-${p.id}`;
      if (unrealizedGain < 0) {
        scenarios.push({
          id, category: "Equity Timing",
          title: `FYI — ${p.ticker} ESPP shares purchased ${p.purchaseDate} are currently at a loss`,
          description: `You're not currently planning to sell, so there's nothing to do here — this is just for awareness. ${p.sharesHeld.toLocaleString()} held shares are worth an estimated $${Math.round(currentValue).toLocaleString()} at today's $${livePrice.toFixed(2)}, vs. a cost basis of $${Math.round(costBasis).toLocaleString()} — an unrealized loss of about $${Math.round(Math.abs(unrealizedGain)).toLocaleString()}.`,
          fedSavings: 0, stateSavings: 0, totalSavings: 0,
          caveat: "Not a $ estimate — the benefit depends on what other gains/income it offsets, and only applies if you actually sell. Watch the wash-sale rule.",
          actionable: false, hypothetical: true,
        });
      } else if (heldDays < longTermHoldingDays) {
        const ltcgDate = new Date(p.purchaseDate);
        ltcgDate.setDate(ltcgDate.getDate() + longTermHoldingDays);
        const ltcgDateIso = ltcgDate.toISOString().slice(0, 10);
        const stNow = estimateUsFederalTax({
          taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: fullYearMedicareWages,
          shortTermGainTaxable: shortTermGainTaxable + unrealizedGain, longTermGainTaxable, capitalLossDeduction,
          itemizedDeduction: federalItemizedTotal,
        });
        const ltNow = estimateUsFederalTax({
          taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: fullYearMedicareWages,
          shortTermGainTaxable, longTermGainTaxable: longTermGainTaxable + unrealizedGain, capitalLossDeduction,
          itemizedDeduction: federalItemizedTotal,
        });
        const fedSavings = Math.max(0, stNow.estimatedTax - ltNow.estimatedTax);
        scenarios.push({
          id, category: "Equity Timing",
          title: `FYI — ${p.ticker} ESPP purchased ${p.purchaseDate}: selling now vs. waiting until ${ltcgDateIso}`,
          description: `You're not currently planning to sell, so there's no action needed — this only matters if/when you do. This app tracks ESPP gains as a simple capital gain by holding period, the same simplified approach used elsewhere in this report (not the full qualifying-disposition rule). ${p.sharesHeld.toLocaleString()} shares were purchased ${heldDays} days ago; selling now would tax the ~$${Math.round(unrealizedGain).toLocaleString()} gain as short-term, while waiting until ${ltcgDateIso} would qualify it as long-term, worth roughly $${Math.round(fedSavings).toLocaleString()} less federal tax at today's price.`,
          fedSavings, stateSavings: 0, totalSavings: fedSavings,
          deadline: ltcgDateIso,
          caveat: "Simplified model (see description) — real ESPP qualifying-disposition rules also depend on the offering date and split part of the gain into ordinary income, which isn't modeled here or elsewhere in this app's ESPP sale tracking. Assumes today's price holds until the long-term-qualifying date.",
          actionable: false, hypothetical: true,
        });
      }
    }
  }

  // ── 6. Itemized vs. standard / bunching ─────────────────────────────────────────────────
  {
    // Matching the standard deduction exactly doesn't help -- itemizing only wins once it's
    // STRICTLY greater (see estimateUsFederalTax's `usedItemized = itemized > standardDeduction`),
    // so the amount to actually bunch is the gap plus a small margin, not the gap itself.
    const gap = baselineFederalStandardDeduction - federalItemizedTotal;
    const bunchTarget = gap + 100;
    if (gap > 0 && gap < 15_000) {
      const bumped = estimateUsFederalTax({
        taxYear, filingStatus, wages: taxableWages, federalWithheld: totalFederal,
        medicareWages: fullYearMedicareWages, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal),
        itemizedDeduction: federalItemizedTotal + bunchTarget,
      });
      const fedSavings = Math.max(0, baselineFederalTax - bumped.estimatedTax);
      scenarios.push({
        id: "itemize-bunch",
        category: "Deduction Strategy",
        title: `You're about $${Math.round(gap).toLocaleString()} short of itemizing paying off`,
        description: `Right now your itemized deductions ($${Math.round(federalItemizedTotal).toLocaleString()}) are close to, but just under, the standard deduction ($${Math.round(baselineFederalStandardDeduction).toLocaleString()}) — so you're taking the standard deduction, and the itemized total isn't helping you at all. "Bunching" means deliberately pulling some deductible spending into this year that you'd otherwise pay next year — e.g. prepaying next year's property tax bill this December, or donating two years' worth of charity in one year (often through a donor-advised fund). If you bunched about $${Math.round(bunchTarget).toLocaleString()} of extra deductions into ${taxYear}, your itemized total would just clear the standard deduction, and your projected federal tax would drop from about $${Math.round(baselineFederalTax).toLocaleString()} to about $${Math.round(bumped.estimatedTax).toLocaleString()}.`,
        fedSavings, stateSavings: 0,
        totalSavings: fedSavings,
        deadline: `${taxYear}-12-31`,
        caveat: `The $${Math.round(bunchTarget).toLocaleString()} figure is the exact gap plus a small margin — matching the standard deduction to the penny doesn't help, you have to exceed it. State itemized rules differ (see the Tax report's own state section) and aren't included in this figure.`,
        actionable: true,
      });
    } else if (gap <= 0) {
      scenarios.push({
        id: "itemize-bunch",
        category: "Deduction Strategy",
        title: "Already itemizing",
        description: `Your itemized deductions ($${Math.round(federalItemizedTotal).toLocaleString()}) already beat the standard deduction ($${Math.round(baselineFederalStandardDeduction).toLocaleString()}) by $${Math.round(-gap).toLocaleString()}.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  // ── 7. Withholding / underpayment check ─────────────────────────────────────────────────
  {
    const UNDERPAYMENT_FLAG_THRESHOLD = 1_000; // IRS's own rule-of-thumb threshold for a penalty
    if (baselineFederalBalanceDue > UNDERPAYMENT_FLAG_THRESHOLD) {
      scenarios.push({
        id: "withholding-check",
        category: "Withholding",
        title: `Projected to owe about $${Math.round(baselineFederalBalanceDue).toLocaleString()} at filing`,
        description: `Based on your pay so far plus what's projected for the rest of ${taxYear} (remaining paychecks and any shares still scheduled to vest), you're on track to owe roughly $${Math.round(baselineFederalBalanceDue).toLocaleString()} in federal tax beyond what's being withheld. The IRS can charge an underpayment penalty if you owe more than $1,000 at filing and didn't pay enough in during the year. Increasing your W-4 withholding for your remaining paychecks, or making an estimated tax payment before year-end, can close this gap.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0,
        deadline: `${taxYear}-12-31`,
        caveat: "This isn't the full IRS safe-harbor rule (90% of this year's tax or 110% of last year's, whichever is smaller) — this app doesn't have your prior-year filed tax on hand to check that precisely. Treat this as a heads-up, not a penalty calculation.",
        actionable: true,
      });
    } else {
      scenarios.push({
        id: "withholding-check",
        category: "Withholding",
        title: "Withholding looks on track",
        description: `Based on your pay so far plus what's projected for the rest of ${taxYear}, your projected federal balance due is about $${Math.round(Math.max(0, baselineFederalBalanceDue)).toLocaleString()}, under the $1,000 rule-of-thumb threshold for an underpayment penalty.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  return { scenarios, projection };
}
