import type { AmexBenefit } from "./vault-types.ts";

// Real Amex card benefit tracking -- see AmexBenefit's own comment in vault-types.ts and
// tools/amex-benefits/ for how this data is captured (no public API, same browser-capture
// pattern as tools/costco-receipts/).

// Merges a freshly-imported batch, deduped by benefitId -- the incoming (presumably newer) one
// wins on a collision, since Amex's own tracker is re-fetched each time and should always
// supersede a stale one (same reasoning as mergeCostcoPriceChecks in lib/costco-receipts.ts).
export function mergeAmexBenefits(existing: AmexBenefit[], incoming: AmexBenefit[]): AmexBenefit[] {
  const byId = new Map(existing.map((b) => [b.benefitId, b]));
  for (const b of incoming) byId.set(b.benefitId, b);
  return [...byId.values()].sort((a, b) => (a.benefitName < b.benefitName ? -1 : 1));
}

// Parses/validates an uploaded benefits.json -- permissive about extra fields (so a future
// parse.mjs can add more without breaking older uploads), strict about the handful actually used.
export function parseAmexBenefitsUpload(raw: unknown): AmexBenefit[] {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of benefits (from benefits.json).");
  return raw.map((b, i) => {
    if (typeof b !== "object" || b === null) throw new Error(`Benefit ${i}: not an object.`);
    const o = b as Record<string, unknown>;
    if (typeof o.benefitId !== "string" || !o.benefitId) throw new Error(`Benefit ${i}: missing "benefitId".`);
    if (typeof o.benefitName !== "string" || !o.benefitName) throw new Error(`Benefit ${i} (${o.benefitId}): missing "benefitName".`);
    return {
      benefitId: o.benefitId,
      benefitName: o.benefitName,
      periodStartDate: typeof o.periodStartDate === "string" ? o.periodStartDate : "",
      periodEndDate: typeof o.periodEndDate === "string" ? o.periodEndDate : "",
      trackerDuration: typeof o.trackerDuration === "string" ? o.trackerDuration : "",
      status: typeof o.status === "string" ? o.status : "",
      targetAmount: typeof o.targetAmount === "number" ? o.targetAmount : 0,
      spentAmount: typeof o.spentAmount === "number" ? o.spentAmount : 0,
      remainingAmount: typeof o.remainingAmount === "number" ? o.remainingAmount : 0,
      currency: typeof o.currency === "string" ? o.currency : "USD",
      lastCheckedAt: typeof o.lastCheckedAt === "string" ? o.lastCheckedAt : new Date().toISOString(),
    };
  });
}

export type AmexBenefitsSummary = {
  totalTarget: number;
  totalUsed: number;
  totalRemaining: number;
  achievedCount: number;
  inProgressCount: number;
};

// Totals across whatever benefits are currently on file -- each one's own CURRENT cycle only
// (periodStartDate/periodEndDate are re-imported fresh each refresh, so this is never a running
// lifetime total, just "where do I stand right now").
export function summarizeAmexBenefits(benefits: AmexBenefit[]): AmexBenefitsSummary {
  let totalTarget = 0, totalUsed = 0, totalRemaining = 0, achievedCount = 0, inProgressCount = 0;
  for (const b of benefits) {
    totalTarget += b.targetAmount;
    totalUsed += b.spentAmount;
    totalRemaining += b.remainingAmount;
    if (b.status === "ACHIEVED") achievedCount++;
    else inProgressCount++;
  }
  return { totalTarget, totalUsed, totalRemaining, achievedCount, inProgressCount };
}
