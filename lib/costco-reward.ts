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

// Costco Shop Cards / gift cards are explicitly excluded from the Executive 2% Reward (confirmed
// against Costco's own Executive 2% Reward FAQ) -- this app can only see a voucher's narration,
// not its actual receipt line items, so it does what it can from that one signal:
//   1. A voucher whose narration mentions a gift/shop card with NO dollar figure attached is
//      assumed to be entirely a gift card purchase (the common case -- "Costco - Gift Cards for
//      Family") and is excluded from qualifying spend entirely.
//   2. A voucher whose narration includes a dollar figure right after "gift card"/"shop card"
//      (e.g. "Costco run -- Gift Card $50") has just that amount subtracted from an otherwise-
//      qualifying purchase, for a single larger bill that mixed regular items with a gift card.
// Neither rule can see inside a bill that mixes the two WITHOUT the user flagging the gift-card
// portion in the narration -- there's no data in this app to split a bill's total automatically.
const GIFT_CARD_RE = /gift\s*card|shop\s*card/i;
const GIFT_CARD_AMOUNT_RE = /(?:gift\s*card|shop\s*card)s?\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i;

// The portion of a voucher's own total that actually qualifies for the 2% Reward, after backing
// out any flagged (or assumed-whole-purchase) gift card amount. Clamped to 0 -- a gift-card
// figure larger than the voucher's own total (e.g. a typo) can't make qualifying spend negative.
export function costcoQualifyingAmount(narration: string, voucherTotal: number): number {
  if (!GIFT_CARD_RE.test(narration)) return voucherTotal;
  const m = narration.match(GIFT_CARD_AMOUNT_RE);
  if (!m) return 0; // no amount given -- assume the whole purchase was gift cards
  const giftCardAmount = Number(m[1].replace(/,/g, ""));
  return Math.max(0, voucherTotal - giftCardAmount);
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
    const amt = costcoQualifyingAmount(t.narration, voucherAmount(t));
    if (amt === 0) continue; // entirely a gift card purchase -- not a qualifying voucher at all
    qualifyingSpend += t.type.toLowerCase() === "receipt" ? -amt : amt;
    voucherCount++;
  }
  const rawReward = Math.max(0, qualifyingSpend) * COSTCO_REWARD_RATE;
  const estimatedReward = Math.min(rawReward, COSTCO_REWARD_CAP);
  return { qualifyingSpend, estimatedReward, capped: rawReward > COSTCO_REWARD_CAP, voucherCount };
}

export type CostcoRewardCycle = { window: CostcoRewardWindow; estimate: CostcoRewardEstimate };

// Every past Costco reward cycle (most-recent-first, NOT including the current/in-progress one)
// that actually has at least one qualifying Costco voucher -- so a "pick a past cycle" dropdown
// built from this list never lands on a meaningless all-zero pre-membership year. Walks backward
// one 12-month cycle at a time from the cycle immediately before `currentWindowStart` (reward
// cycles are contiguous, so that's always the start of the prior one), stopping once a cycle no
// longer overlaps the earliest transaction on file -- nothing further back could have any
// qualifying spend either.
export function listPastCostcoRewardCycles(
  renewalMonthDay: string,
  currentWindowStart: string,
  transactions: Tx[]
): CostcoRewardCycle[] {
  let earliestTx = "";
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (!earliestTx || t.date < earliestTx) earliestTx = t.date;
  }
  if (!earliestTx) return [];

  const cycles: CostcoRewardCycle[] = [];
  let anchor = addMonthsIso(currentWindowStart, -1);
  for (let guard = 0; guard < 500; guard++) {
    const window = computeCostcoRewardWindow(renewalMonthDay, anchor);
    if (window.end <= earliestTx) break;
    const estimate = computeCostcoRewardEstimate(transactions, window.start, window.end);
    if (estimate.voucherCount > 0) cycles.push({ window, estimate });
    if (window.start <= earliestTx) break;
    anchor = addMonthsIso(window.start, -1);
  }
  return cycles;
}
