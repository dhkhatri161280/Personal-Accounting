import type { AmexBenefit, AmexCoverageBenefit } from "./vault-types.ts";

// Real Amex card benefit tracking -- see AmexBenefit's own comment in vault-types.ts and
// tools/amex-benefits/ for how this data is captured (no public API, same browser-capture
// pattern as tools/costco-receipts/).

// Merges a freshly-imported batch, deduped by benefitId -- the incoming (presumably newer) one
// wins on a collision, since Amex's own tracker is re-fetched each time and should always
// supersede a stale one (same reasoning as mergeCostcoPriceChecks in lib/costco-receipts.ts).
// statementCredits is preserved from the existing record when incoming doesn't specify it, same
// reasoning as mergeAmexCoverageBenefits' own preservation of statementClaims below -- parse.mjs
// has no way to know about a hand-reconciled correction, so a straight overwrite would wipe it.
export function mergeAmexBenefits(existing: AmexBenefit[], incoming: AmexBenefit[]): AmexBenefit[] {
  const byId = new Map(existing.map((b) => [b.benefitId, b]));
  for (const b of incoming) {
    const prev = byId.get(b.benefitId);
    byId.set(b.benefitId, { ...b, statementCredits: b.statementCredits ?? prev?.statementCredits });
  }
  return [...byId.values()].sort((a, b) => (a.benefitName < b.benefitName ? -1 : 1));
}

// The real figure to show/total for a tracker -- the larger of Amex's own live yearToDateAmount
// and whatever statementCredits says was confirmed by hand for THIS calendar year (see that
// field's own comment in vault-types.ts). Never summed with yearToDateAmount, since Amex's own
// tracker may later catch up to the same real figure on its own.
export function effectiveYearToDate(b: AmexBenefit, currentYear: string): number {
  const statementSum = (b.statementCredits ?? []).filter((c) => c.date.startsWith(currentYear)).reduce((s, c) => s + c.amount, 0);
  return Math.max(b.yearToDateAmount, statementSum);
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
    const statementCredits = Array.isArray(o.statementCredits)
      ? o.statementCredits
          .filter((c): c is { date: unknown; amount: unknown } => typeof c === "object" && c !== null)
          .map((c) => ({ date: typeof c.date === "string" ? c.date : "", amount: typeof c.amount === "number" ? c.amount : 0 }))
          .filter((c) => c.date && c.amount)
      : undefined;
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
      yearToDateAmount: typeof o.yearToDateAmount === "number" ? o.yearToDateAmount : 0,
      annualTargetAmount: typeof o.annualTargetAmount === "number" ? o.annualTargetAmount : (typeof o.targetAmount === "number" ? o.targetAmount : 0),
      currency: typeof o.currency === "string" ? o.currency : "USD",
      lastCheckedAt: typeof o.lastCheckedAt === "string" ? o.lastCheckedAt : new Date().toISOString(),
      statementCredits,
    };
  });
}

// Merges a freshly-imported batch of coverage/protection benefits, deduped by benefitKey.
// selfReportedFullyUsed is carried over from the EXISTING record when the incoming one doesn't
// specify it -- parse.mjs/Amex's own data never sets this field (it's app-UI-only, see its own
// comment in vault-types.ts), so a straight overwrite would silently wipe the user's own stated
// claim on every daily re-import.
export function mergeAmexCoverageBenefits(existing: AmexCoverageBenefit[], incoming: AmexCoverageBenefit[]): AmexCoverageBenefit[] {
  const byKey = new Map(existing.map((b) => [b.benefitKey, b]));
  for (const b of incoming) {
    const prev = byKey.get(b.benefitKey);
    byKey.set(b.benefitKey, {
      ...b,
      selfReportedFullyUsed: b.selfReportedFullyUsed ?? prev?.selfReportedFullyUsed,
      // Same preservation reasoning as selfReportedFullyUsed just above -- parse.mjs's daily
      // tracker/catalog re-import has no way to know about hand-reconciled statement claims, so a
      // straight overwrite would silently wipe them.
      statementClaims: b.statementClaims ?? prev?.statementClaims,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.title < b.title ? -1 : 1));
}

export function parseAmexCoverageBenefitsUpload(raw: unknown): AmexCoverageBenefit[] {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of coverage benefits (from coverage-benefits.json).");
  return raw.map((b, i) => {
    if (typeof b !== "object" || b === null) throw new Error(`Coverage benefit ${i}: not an object.`);
    const o = b as Record<string, unknown>;
    if (typeof o.benefitKey !== "string" || !o.benefitKey) throw new Error(`Coverage benefit ${i}: missing "benefitKey".`);
    if (typeof o.title !== "string" || !o.title) throw new Error(`Coverage benefit ${i} (${o.benefitKey}): missing "title".`);
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const statementClaims = Array.isArray(o.statementClaims)
      ? o.statementClaims
          .filter((c): c is { date: unknown; amount: unknown } => typeof c === "object" && c !== null)
          .map((c) => ({ date: typeof c.date === "string" ? c.date : "", amount: typeof c.amount === "number" ? c.amount : 0 }))
          .filter((c) => c.date && c.amount)
      : undefined;
    return {
      benefitKey: o.benefitKey,
      title: o.title,
      summary: typeof o.summary === "string" ? o.summary : "",
      perClaimLimit: num(o.perClaimLimit),
      periodLimit: num(o.periodLimit),
      periodLabel: typeof o.periodLabel === "string" ? o.periodLabel : undefined,
      deductible: num(o.deductible),
      claimsPerPeriod: num(o.claimsPerPeriod),
      monthlyCost: num(o.monthlyCost),
      trialCost: num(o.trialCost),
      trialDays: num(o.trialDays),
      selfReportedFullyUsed: typeof o.selfReportedFullyUsed === "boolean" ? o.selfReportedFullyUsed : undefined,
      statementClaims,
      lastCheckedAt: typeof o.lastCheckedAt === "string" ? o.lastCheckedAt : new Date().toISOString(),
    };
  });
}

// Self-reported monthly Uber Cash usage -- $15/month + a $20 December bonus, per Amex's own
// published terms (confirmed via americanexpress.com's own Credit Intel article). ONLY ever
// computed when the user has explicitly confirmed full usage via the selfReportedFullyUsed
// toggle on that specific AmexCoverageBenefit entry -- never shown, summed, or defaulted to
// otherwise. Calendar-year to date, inclusive of the current month (the user's own claim is that
// they use it every month, not that some months are pending).
//
// Takes the date as a YYYY-MM-DD string (todayLocalIso(), not a Date object) and reads the month
// via string slicing -- confirmed live this is NOT a style nicety: `new Date("2026-12-01")`
// parses as UTC midnight, and reading it back with .getMonth() (a LOCAL-time getter) rolls back
// to November in any negative-UTC-offset timezone, silently dropping the December bonus and
// undercounting every month's total by one. String slicing has no timezone to get wrong.
export function selfReportedUberCashUsed(todayIso: string): number {
  const month = Number(todayIso.slice(5, 7)); // 1-12, directly from the date string
  let total = month * 15;
  if (month >= 12) total += 20;
  return total;
}

export type AmexBenefitsSummary = {
  totalTarget: number;
  totalUsed: number;
  totalRemaining: number;
  achievedCount: number;
  inProgressCount: number;
};

// Totals across whatever benefits are currently on file, for the CURRENT calendar year as a
// whole -- totalTarget/totalUsed deliberately use annualTargetAmount/effectiveYearToDate, NOT
// targetAmount/spentAmount (which are only the current sub-period, e.g. Resy's $100/quarter
// rather than its real $400/year -- confirmed live this badly understated both sides for any
// Monthly/QuarterYear/HalfYear benefit). totalRemaining is derived the same way, for consistency.
// currentYear (YYYY) is required so effectiveYearToDate can apply any statementCredits override.
export function summarizeAmexBenefits(benefits: AmexBenefit[], currentYear: string): AmexBenefitsSummary {
  let totalTarget = 0, totalUsed = 0, totalRemaining = 0, achievedCount = 0, inProgressCount = 0;
  for (const b of benefits) {
    const used = effectiveYearToDate(b, currentYear);
    totalTarget += b.annualTargetAmount;
    totalUsed += used;
    totalRemaining += Math.max(0, b.annualTargetAmount - used);
    // Achieved if Amex's own status says so, OR a statement-confirmed figure alone already clears
    // the annual target (matches the per-row "✓ Achieved" badge logic in AmexBenefitsReport.tsx).
    if (b.status === "ACHIEVED" || (b.annualTargetAmount > 0 && used >= b.annualTargetAmount)) achievedCount++;
    else inProgressCount++;
  }
  return { totalTarget, totalUsed, totalRemaining, achievedCount, inProgressCount };
}
