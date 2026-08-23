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

export function summarizeCapitalGains(events: CapitalGainEvent[]): { shortTermGain: number; longTermGain: number } {
  let shortTermNet = 0;
  let longTermNet = 0;
  for (const e of events) {
    if (e.term === "short") shortTermNet += e.gain;
    else longTermNet += e.gain;
  }
  return { shortTermGain: Math.max(0, shortTermNet), longTermGain: Math.max(0, longTermNet) };
}

function daysBetween(isoDate: string, asOf: Date): number {
  const start = new Date(isoDate).getTime();
  const end = asOf.getTime();
  return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}
