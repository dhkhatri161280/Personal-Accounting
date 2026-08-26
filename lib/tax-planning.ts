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
 * from a licensed preparer; every scenario should stay framed as an estimate, not a directive. */

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
}

export interface TaxPlanningInput {
  taxYear: string;
  filingStatus: UsFilingStatus;
  stateCode: StateCode;
  stateName: string;
  longTermHoldingDays: number;

  // Federal inputs -- same shape TaxReport.tsx already builds for its own taxEstimate.
  taxableWages: number; // totalGross - totalK401
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

  // Baselines already computed by the caller -- avoid recomputing what TaxReport already has.
  baselineFederalTax: number;
  baselineStateTax: number;
  baselineFederalBalanceDue: number;
  baselineFederalStandardDeduction: number;

  // Equity data for the RSU/ESPP hold-timing scan.
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
  livePrice: number | null;
  todayIso: string;
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

export function computeTaxPlanningScenarios(input: TaxPlanningInput): TaxPlanningScenario[] {
  const scenarios: TaxPlanningScenario[] = [];
  const {
    taxYear, filingStatus, stateCode, stateName, longTermHoldingDays,
    taxableWages, totalGross, totalFederal, totalMedicare,
    shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
    federalItemizedTotal, hsaContributionTotal, hsaCoverage, totalK401,
    totalStateWH, stateItemizedTotal, stateHsaConforms,
    baselineFederalTax, baselineStateTax, baselineFederalBalanceDue, baselineFederalStandardDeduction,
    grants, esppPurchases, livePrice, todayIso,
  } = input;

  // Federal AGI used for state-tax recompute below -- mirrors how TaxReport.tsx derives it
  // (state AGI = federal AGI, with the HSA above-the-line deduction added back for states that
  // don't conform to federal HSA treatment).
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
        medicareWages: totalGross, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal),
        itemizedDeduction: federalItemizedTotal,
      });
      const fedSavings = Math.max(0, baselineFederalTax - newFed.estimatedTax);
      const newStateAgi = stateAgiFor(newFed.agi, newFed.aboveLineDeduction);
      const newStateTax = estimateState(stateCode, taxYear, filingStatus, newStateAgi, stateItemizedTotal, totalStateWH);
      const stateSavings = Math.max(0, baselineStateTax - newStateTax);
      scenarios.push({
        id: "401k-room",
        category: "Contribution Room",
        title: `Contribute the remaining $${room.toLocaleString()} of 401(k) room`,
        description: `You've contributed $${Math.round(totalK401).toLocaleString()} of the $${limit.toLocaleString()} ${taxYear} traditional 401(k) limit. Contributing the remaining $${room.toLocaleString()} (pretax) would reduce taxable wages by that amount.`,
        fedSavings, stateSavings, totalSavings: fedSavings + stateSavings,
        deadline: `${taxYear}-12-31`,
        caveat: "Assumes a traditional (not Roth) 401(k) and holds your other deductions constant. Doesn't model the age-50+ catch-up limit. Practically limited by how many pay periods remain in the year.",
        actionable: true,
      });
    } else {
      scenarios.push({
        id: "401k-room",
        category: "Contribution Room",
        title: "401(k) already maxed out",
        description: `You've contributed $${Math.round(totalK401).toLocaleString()} of the $${limit.toLocaleString()} ${taxYear} limit — no additional pretax room this year.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  // ── 2. Traditional vs. Roth mix (informational -- no dollar figure fabricated) ─────────
  scenarios.push({
    id: "401k-roth-mix",
    category: "Informational",
    title: "Traditional vs. Roth 401(k) mix",
    description: "Traditional contributions reduce this year's taxable wages (the savings modeled above); Roth contributions don't lower this year's tax but grow tax-free and aren't taxed on withdrawal. If you expect a lower tax rate in retirement, traditional tends to win; if you expect a similar or higher rate, Roth tends to win. This app can't predict your future tax bracket, so no dollar estimate is shown here -- it's a genuine judgment call, not a calculation.",
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
        medicareWages: totalGross, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: newHsaDeduction,
        itemizedDeduction: federalItemizedTotal,
      });
      const fedSavings = Math.max(0, baselineFederalTax - newFed.estimatedTax);
      const newStateAgi = stateAgiFor(newFed.agi, newFed.aboveLineDeduction);
      const newStateTax = estimateState(stateCode, taxYear, filingStatus, newStateAgi, stateItemizedTotal, totalStateWH);
      const stateSavings = Math.max(0, baselineStateTax - newStateTax);
      scenarios.push({
        id: "hsa-room",
        category: "Contribution Room",
        title: `Contribute the remaining $${room.toLocaleString()} of HSA room`,
        description: `You've put in $${Math.round(hsaContributionTotal).toLocaleString()} of the $${limit.toLocaleString()} ${taxYear} HSA limit (${hsaCoverage === "family" ? "family" : "self-only"} coverage). The rest is an above-the-line federal deduction.`,
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

  // ── 4/5. RSU + ESPP hold-timing scan -- one pass over every currently-held lot ──────────
  // Each lot is either: not yet long-term (show the LTCG-qualifying date + potential savings
  // from holding, assuming today's price), already long-term (no timing action left), or
  // currently worth less than its cost basis (a loss-harvesting candidate instead).
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
            title: `Loss-harvesting candidate: ${grant.ticker} vested ${vest.vestDate}`,
            description: `${vest.sharesHeld.toLocaleString()} held shares are worth an estimated $${Math.round(currentValue).toLocaleString()} at today's $${livePrice.toFixed(2)}, vs. a cost basis of $${Math.round(costBasis).toLocaleString()} — an unrealized loss of about $${Math.round(Math.abs(unrealizedGain)).toLocaleString()}. Realizing it would offset other capital gains dollar-for-dollar, or up to $3,000/year against ordinary income.`,
            fedSavings: 0, stateSavings: 0, totalSavings: 0,
            caveat: "Not a $ estimate — the benefit depends on what other gains/income it offsets. Watch the wash-sale rule if you plan to buy back the same stock within 30 days.",
            actionable: true,
          });
        } else if (heldDays < longTermHoldingDays) {
          const ltcgDate = new Date(vest.vestDate);
          ltcgDate.setDate(ltcgDate.getDate() + longTermHoldingDays);
          const ltcgDateIso = ltcgDate.toISOString().slice(0, 10);
          // Same starting point either way (baseline gains unchanged) -- only whether this
          // specific lot's gain lands in the short-term or long-term bucket differs, so the
          // savings is simply the tax difference between those two placements.
          const stNow = estimateUsFederalTax({
            taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: totalGross,
            shortTermGainTaxable: shortTermGainTaxable + unrealizedGain, longTermGainTaxable, capitalLossDeduction,
            itemizedDeduction: federalItemizedTotal,
          });
          const ltNow = estimateUsFederalTax({
            taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: totalGross,
            shortTermGainTaxable, longTermGainTaxable: longTermGainTaxable + unrealizedGain, capitalLossDeduction,
            itemizedDeduction: federalItemizedTotal,
          });
          const fedSavings = Math.max(0, stNow.estimatedTax - ltNow.estimatedTax);
          scenarios.push({
            id, category: "Equity Timing",
            title: `Hold ${grant.ticker} vested ${vest.vestDate} until ${ltcgDateIso} for long-term rates`,
            description: `${vest.sharesHeld.toLocaleString()} held shares, vested ${heldDays} days ago. Selling now would tax the ~$${Math.round(unrealizedGain).toLocaleString()} gain as short-term (ordinary rates); waiting until ${ltcgDateIso} (1 year from vest) qualifies it for long-term capital gains rates instead.`,
            fedSavings, stateSavings: 0, totalSavings: fedSavings,
            deadline: ltcgDateIso,
            caveat: "Assumes the stock price on the LTCG date equals today's price — the actual price, and therefore the actual gain and tax, will differ. State savings not modeled (LTCG isn't taxed preferentially at the state level here).",
            actionable: true,
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
          title: `Loss-harvesting candidate: ${p.ticker} ESPP purchased ${p.purchaseDate}`,
          description: `${p.sharesHeld.toLocaleString()} held shares are worth an estimated $${Math.round(currentValue).toLocaleString()} at today's $${livePrice.toFixed(2)}, vs. a cost basis of $${Math.round(costBasis).toLocaleString()} — an unrealized loss of about $${Math.round(Math.abs(unrealizedGain)).toLocaleString()}.`,
          fedSavings: 0, stateSavings: 0, totalSavings: 0,
          caveat: "Not a $ estimate — the benefit depends on what other gains/income it offsets. Watch the wash-sale rule.",
          actionable: true,
        });
      } else if (heldDays < longTermHoldingDays) {
        const ltcgDate = new Date(p.purchaseDate);
        ltcgDate.setDate(ltcgDate.getDate() + longTermHoldingDays);
        const ltcgDateIso = ltcgDate.toISOString().slice(0, 10);
        const stNow = estimateUsFederalTax({
          taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: totalGross,
          shortTermGainTaxable: shortTermGainTaxable + unrealizedGain, longTermGainTaxable, capitalLossDeduction,
          itemizedDeduction: federalItemizedTotal,
        });
        const ltNow = estimateUsFederalTax({
          taxYear, filingStatus, wages: taxableWages, federalWithheld: 0, medicareWages: totalGross,
          shortTermGainTaxable, longTermGainTaxable: longTermGainTaxable + unrealizedGain, capitalLossDeduction,
          itemizedDeduction: federalItemizedTotal,
        });
        const fedSavings = Math.max(0, stNow.estimatedTax - ltNow.estimatedTax);
        scenarios.push({
          id, category: "Equity Timing",
          title: `Hold ${p.ticker} ESPP purchased ${p.purchaseDate} until ${ltcgDateIso} for long-term rates`,
          description: `${p.sharesHeld.toLocaleString()} held shares, purchased ${heldDays} days ago. This app models ESPP gains as a simple capital gain by holding period (like the rest of the Tax report) rather than the full qualifying-disposition split — selling now taxes the ~$${Math.round(unrealizedGain).toLocaleString()} gain as short-term; waiting until ${ltcgDateIso} qualifies it as long-term.`,
          fedSavings, stateSavings: 0, totalSavings: fedSavings,
          deadline: ltcgDateIso,
          caveat: "Simplified model (see description) — real ESPP qualifying-disposition rules also depend on the offering date and split part of the gain into ordinary income, which isn't modeled here or elsewhere in this app's ESPP sale tracking. Assumes today's price holds until the LTCG date.",
          actionable: true,
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
        medicareWages: totalGross, medicareWithheld: totalMedicare,
        shortTermGainTaxable, longTermGainTaxable, capitalLossDeduction,
        aboveLineDeduction: computeHsaDeduction(taxYear, hsaCoverage, hsaContributionTotal),
        itemizedDeduction: federalItemizedTotal + bunchTarget,
      });
      const fedSavings = Math.max(0, baselineFederalTax - bumped.estimatedTax);
      scenarios.push({
        id: "itemize-bunch",
        category: "Deduction Strategy",
        title: `You're about $${Math.round(gap).toLocaleString()} short of itemizing paying off`,
        description: `Your itemized total ($${Math.round(federalItemizedTotal).toLocaleString()}) is close to but under the standard deduction ($${Math.round(baselineFederalStandardDeduction).toLocaleString()}). "Bunching" — e.g. prepaying next year's property tax bill this December, or donating two years' worth of charitable giving in one year (often via a donor-advised fund) — could push you over the line in the year you bunch.`,
        fedSavings, stateSavings: 0,
        totalSavings: fedSavings,
        deadline: `${taxYear}-12-31`,
        caveat: `Shows the benefit of bunching about $${Math.round(bunchTarget).toLocaleString()} — the exact gap plus a small margin, since matching the standard deduction to the penny doesn't help; you have to exceed it. State itemized rules differ (see the Tax report's own state section) and aren't included in this figure.`,
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
        title: `Projected federal balance due of $${Math.round(baselineFederalBalanceDue).toLocaleString()}`,
        description: "The IRS can charge an underpayment penalty if you owe more than $1,000 at filing and didn't withhold/pay enough during the year. Increasing your W-4 withholding for the rest of the year, or making an estimated payment, can close this gap before year-end.",
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
        description: `Projected federal balance due is $${Math.round(Math.max(0, baselineFederalBalanceDue)).toLocaleString()}, under the $1,000 rule-of-thumb threshold for an underpayment penalty.`,
        fedSavings: 0, stateSavings: 0, totalSavings: 0, actionable: false,
      });
    }
  }

  return scenarios;
}
