import type { Tx } from "@/lib/vault-types";

// Costco Executive Membership's 2% Reward -- confirmed against Costco's own Executive 2% Reward
// FAQ: 2% of qualifying Costco/Costco.com/Costco Travel purchases, capped at $1,250 for any
// 12-month period. Gasoline is explicitly excluded (and the certificate itself can't be used at
// the pump). This module estimates it from this app's own Costco-tagged spend -- the real,
// authoritative number always comes from Costco's own coupon/certificate once issued.
export const COSTCO_REWARD_RATE = 0.02;
export const COSTCO_REWARD_CAP = 1250;

// Same two regexes PlaidImport.tsx's own auto-categorization already uses to route a Costco
// transaction to the Gasoline account vs. the current month's House Hold Exps account -- reused
// here (not re-derived) so this estimate always agrees with how the voucher actually got
// classified at import time, narration being the only signal either place has.
const COSTCO_RE = /costco/i;
const COSTCO_GAS_RE = /costco.*(gas|fuel)|gas.*costco/i;

export function isQualifyingCostcoNarration(narration: string): boolean {
  return COSTCO_RE.test(narration) && !COSTCO_GAS_RE.test(narration);
}

// UTC-day-count month arithmetic (never new Date() + setMonth, which drifts across local
// timezones and silently overflows a short month, e.g. May 31 - 3mo landing on Mar 3 instead of
// Feb 28) -- same manual-arithmetic convention lib/gr-consolidation.ts's prevMonthKey already
// uses for exactly this reason. Clamps the day to the target month's real last day (Aug 31 minus
// 3 months lands on May 31 correctly; Mar 31 minus 1 month lands on Feb 28/29, not an invalid
// Feb 31).
export function addMonthsIso(dateIso: string, months: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export type CostcoRewardWindow = { start: string; end: string; cutoffDate: string };

// The Executive 2% Reward is calculated up to ~3 months before the membership's renewal
// (expiration) date, not through the membership year itself -- confirmed against Costco's own
// Executive 2% Reward FAQ ("...to approximately 3 months prior to your renewal date...") and,
// concretely, against this member's own renewal notice (expires 2027-08-31, renewal window opens
// 2027-05-31 -- exactly 3 months early).
//
// `renewalMonthDay` is just "MM-DD" (e.g. "08-31") -- deliberately NOT a full date with a year.
// Under normal renewal the month/day is fixed year over year; a year-bearing field would need
// bumping every single renewal just to stay correct, defeating the point of a "set once" setting.
// This instead brackets "today" against the last-year/this-year/next-year occurrence of that
// month/day and picks whichever 12-month window actually contains it, so it keeps working
// correctly across any number of renewals with no further maintenance.
export function computeCostcoRewardWindow(renewalMonthDay: string, todayIso: string): CostcoRewardWindow {
  const todayYear = Number(todayIso.slice(0, 4));
  const cutoffs = [todayYear - 1, todayYear, todayYear + 1]
    .map((y) => addMonthsIso(`${y}-${renewalMonthDay}`, -3))
    .sort();
  const end = cutoffs.find((c) => c > todayIso) ?? addMonthsIso(cutoffs[cutoffs.length - 1], 12);
  return { start: addMonthsIso(end, -12), end, cutoffDate: end };
}

export type CostcoRewardEstimate = {
  qualifyingSpend: number;
  estimatedReward: number;
  capped: boolean;
  voucherCount: number;
};

// A voucher's own total transaction amount -- half the sum of every entry's absolute value, same
// convention TransactionTable.tsx's own amount() helper uses (every voucher's debit total equals
// its credit total by construction, so halving avoids double-counting).
function voucherAmount(t: Tx): number {
  return t.entries.reduce((s, e) => s + Math.abs(e.amount), 0) / 2;
}

// Net qualifying spend (and the 2%-capped estimate) within [windowStart, windowEnd) -- a refund
// (voucherType "Receipt" against a prior Costco purchase) SUBTRACTS from the running total, same
// as Costco's own terms ("Refunds of eligible purchases will be deducted from the 2% Reward").
export function computeCostcoRewardEstimate(
  transactions: Tx[],
  windowStart: string,
  windowEnd: string
): CostcoRewardEstimate {
  let qualifyingSpend = 0;
  let voucherCount = 0;
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < windowStart || t.date >= windowEnd) continue;
    if (!isQualifyingCostcoNarration(t.narration)) continue;
    const amt = voucherAmount(t);
    qualifyingSpend += t.type.toLowerCase() === "receipt" ? -amt : amt;
    voucherCount++;
  }
  const rawReward = Math.max(0, qualifyingSpend) * COSTCO_REWARD_RATE;
  const estimatedReward = Math.min(rawReward, COSTCO_REWARD_CAP);
  return { qualifyingSpend, estimatedReward, capped: rawReward > COSTCO_REWARD_CAP, voucherCount };
}
