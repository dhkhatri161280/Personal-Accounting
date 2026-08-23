import type { EsppPurchase, RsuGrant } from "./vault-types";

export interface CapitalGainEvent {
  id: string;
  label: string;
  shares: number;
  costBasis: number;
  proceeds: number;
  gain: number;
  term: "short" | "long";
}

/** RSU: shares withheld for tax at vest (taxShares) are not a sale — cost basis for a later
 * sale is the vest-date FMV (vestPrice), since that value was already taxed as ordinary
 * income through payroll. A sale only exists when the user has entered an explicit
 * salePrice different from the default vestPrice fallback used elsewhere in the app for
 * display purposes; without one, we don't know the sale actually happened. Mirrors the
 * "sold" quantity math already used in EquityReport.tsx (shares - taxShares - sharesHeld). */
export function classifyRsuSales(grants: RsuGrant[], year: string, holdingDays: number, asOf = new Date()): CapitalGainEvent[] {
  const events: CapitalGainEvent[] = [];
  for (const grant of grants) {
    for (const vest of grant.vests) {
      if (vest.pending || !vest.salePrice) continue;
      if (!vest.vestDate.startsWith(year)) continue;
      const soldShares = Math.max(0, vest.shares - (vest.taxShares ?? 0) - vest.sharesHeld);
      if (soldShares <= 0) continue;
      const costBasis = soldShares * vest.vestPrice;
      const proceeds = soldShares * vest.salePrice;
      const heldDays = daysBetween(vest.vestDate, asOf);
      events.push({
        id: vest.id,
        label: `${grant.ticker} vested ${vest.vestDate}`,
        shares: soldShares,
        costBasis,
        proceeds,
        gain: proceeds - costBasis,
        term: heldDays >= holdingDays ? "long" : "short",
      });
    }
  }
  return events;
}

/** ESPP: simplified — treats the full gain (salePrice - purchasePrice) as capital gain.
 * Real ESPP tax treatment splits some of the discount into ordinary income on a
 * "disqualifying disposition" (sale within 1-2 years of the offering/purchase dates); that
 * split isn't modeled here, so this slightly understates ordinary income and overstates
 * capital gains for shares sold soon after purchase. Flagged in the UI disclaimer. */
export function classifyEsppSales(purchases: EsppPurchase[], year: string, holdingDays: number, asOf = new Date()): CapitalGainEvent[] {
  const events: CapitalGainEvent[] = [];
  for (const p of purchases) {
    const salePrice = (p as { salePrice?: number }).salePrice;
    if (!salePrice) continue;
    if (!p.purchaseDate.startsWith(year)) continue;
    const soldShares = Math.max(0, p.shares - p.sharesHeld);
    if (soldShares <= 0) continue;
    const costBasis = soldShares * p.purchasePrice;
    const proceeds = soldShares * salePrice;
    const heldDays = daysBetween(p.purchaseDate, asOf);
    events.push({
      id: p.id,
      label: `${p.ticker} ESPP purchased ${p.purchaseDate}`,
      shares: soldShares,
      costBasis,
      proceeds,
      gain: proceeds - costBasis,
      term: heldDays >= holdingDays ? "long" : "short",
    });
  }
  return events;
}

const ANNUAL_CAPITAL_LOSS_DEDUCTION_LIMIT = 3_000; // same for single and MFJ; $1,500 for MFS (not modeled)

export interface CapitalGainSummary {
  netShortTerm: number; // can be negative
  netLongTerm: number; // can be negative
  /** Amount taxed as ordinary income (short-term character survives netting). */
  shortTermGainTaxable: number;
  /** Amount taxed at preferential LTCG rates (long-term character survives netting). */
  longTermGainTaxable: number;
  /** Up to $3,000/year of a net overall capital LOSS, deductible against ordinary income. */
  ordinaryLossDeduction: number;
  /** Loss beyond the annual $3,000 cap — not tracked/carried to a future year by this app,
   * shown for information only. */
  lossCarryforward: number;
}

/** Schedule D-style netting: short-term and long-term are summed separately (each can be
 * negative), then netted against EACH OTHER at the combined level -- a loss in one category
 * offsets a gain in the other, dollar for dollar, before any tax rate is applied. Only after
 * that combined net is negative does the $3,000/year ordinary-income loss deduction apply
 * (previously this just floored each category's net loss at zero, silently discarding real,
 * deductible losses instead of crediting them). */
export function summarizeCapitalGains(events: CapitalGainEvent[]): CapitalGainSummary {
  let netShortTerm = 0;
  let netLongTerm = 0;
  for (const e of events) {
    if (e.term === "short") netShortTerm += e.gain;
    else netLongTerm += e.gain;
  }
  const totalNet = netShortTerm + netLongTerm;

  if (totalNet <= 0) {
    const netLoss = -totalNet;
    const ordinaryLossDeduction = Math.min(ANNUAL_CAPITAL_LOSS_DEDUCTION_LIMIT, netLoss);
    return {
      netShortTerm, netLongTerm,
      shortTermGainTaxable: 0, longTermGainTaxable: 0,
      ordinaryLossDeduction,
      lossCarryforward: Math.max(0, netLoss - ANNUAL_CAPITAL_LOSS_DEDUCTION_LIMIT),
    };
  }

  // A gain overall: whichever category still has a positive balance after the other
  // category's loss offsets it keeps its own tax character. min(netLongTerm, totalNet)
  // handles all three cases correctly (both positive; ST gain + LT loss; LT gain + ST loss).
  const longTermGainTaxable = Math.max(0, Math.min(netLongTerm, totalNet));
  const shortTermGainTaxable = totalNet - longTermGainTaxable;
  return {
    netShortTerm, netLongTerm,
    shortTermGainTaxable, longTermGainTaxable,
    ordinaryLossDeduction: 0, lossCarryforward: 0,
  };
}

function daysBetween(isoDate: string, asOf: Date): number {
  const start = new Date(isoDate).getTime();
  const end = asOf.getTime();
  return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}
