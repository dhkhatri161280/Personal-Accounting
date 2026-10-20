import type { RecurringTemplate } from "./vault-types.ts";
import { currentPeriodKey } from "./recurring.ts";

// Minimal shapes -- deliberately narrower than the real Ledger/Account/Tx types so this module
// works from either the full vault-types.ts Ledger or MastersPanel.tsx's own MasterLedger view
// (both are structurally compatible with this).
export interface DetectAccount {
  id: number;
  name: string;
}
export interface DetectTx {
  guid?: string;
  date: string;
  type?: string;
  narration?: string;
  deleted?: boolean;
  cancelled?: boolean;
  entries: { accountId: number; amount: number }[];
}

export interface RecurringCandidate {
  key: string; // `${debitAccountId}|${creditAccountId}` -- also the de-dup key against existing templates
  debitAccountId: number;
  debitAccountName: string;
  creditAccountId: number;
  creditAccountName: string;
  voucherType: string;
  suggestedLabel: string;
  occurrences: { date: string; amount: number; narration: string; txGuid?: string }[];
  avgAmount: number;
  avgGapDays: number;
  suggestedFrequency: RecurringTemplate["frequency"];
  suggestedIntervalMonths?: number;
  suggestedDayOfMonth: number;
  suggestedAnchorMonth?: string;
}

// Wider than a textbook calendar interval -- confirmed live, real bills jitter: a yearly renewal
// can land a month+ off the prior year's date depending on processing time, and a monthly bill
// can skip a few days around a weekend/holiday.
const STANDARD_FREQUENCIES: { frequency: RecurringTemplate["frequency"]; days: number; tolerance: number }[] = [
  { frequency: "monthly", days: 30.4, tolerance: 8 },
  { frequency: "bimonthly", days: 60.8, tolerance: 10 },
  { frequency: "quarterly", days: 91.3, tolerance: 14 },
  { frequency: "yearly", days: 365, tolerance: 35 },
];

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}

function monthsAgo(asOfDate: string, months: number): string {
  const [y, m, d] = asOfDate.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Prefer the expense/liability/income side's own name (usually descriptive, e.g. "Netflix
// Subscription", "Car EMI", "HOA Dues") over the bank/credit-card/cash side it was paid from or
// into, which is almost never a useful label for the bill itself.
function inferLabel(debitName: string, creditName: string, narration: string): string {
  const looksLikeMoneyAccount = (n: string) => /bank|credit card|checking|savings|cash-in-hand|^cash\b/i.test(n);
  const base = looksLikeMoneyAccount(debitName) && !looksLikeMoneyAccount(creditName)
    ? creditName
    : looksLikeMoneyAccount(creditName) && !looksLikeMoneyAccount(debitName)
      ? debitName
      : narration || debitName;
  // Strip a trailing "- Mon YY" style month suffix some ledger families carry (e.g. "House Hold
  // Exps - Apr 26") -- that's the account's own per-month identity, not part of the bill's name.
  return base.replace(/\s*-\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*['’]?\d{2,4}$/i, "").trim() || "Recurring bill";
}

/** Scans the Day Book for a regularly-repeating, simple 2-leg voucher pattern (same account pair,
 * roughly evenly spaced dates) and proposes it as a recurring template -- the "automatically find
 * my recurring bills" entry point for Masters -> Recurring's own "Scan" button. Amount is
 * deliberately NOT a tight filter -- confirmed live, a usage-based bill (electricity, water) can
 * legitimately swing 2x+ cycle to cycle, and the account pair itself (a dedicated bill ledger
 * paired with a bank/card) is already a strong signal on its own; interval regularity is the
 * primary thing that makes something "recurring", not amount consistency. Requires at least 2
 * occurrences, but a 2-occurrence candidate only qualifies if its one gap lands tightly on a
 * standard cadence (monthly/bimonthly/quarterly/yearly) -- a single gap can't confidently imply a
 * non-standard custom interval, so that still needs 3+ occurrences. Already-templated and
 * explicitly dismissed account pairs are excluded so re-scanning doesn't keep re-suggesting what's
 * already set up or what the user already said isn't a real recurring bill. */
export function detectRecurringCandidates(
  transactions: DetectTx[],
  accounts: DetectAccount[],
  existingTemplates: RecurringTemplate[],
  dismissedKeys: Set<string>,
  lookbackMonths: number,
  asOfDate: string
): RecurringCandidate[] {
  const cutoff = monthsAgo(asOfDate, lookbackMonths);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const existingKeys = new Set(
    existingTemplates.map((t) => {
      const d = t.entries.find((e) => e.amount < 0);
      const c = t.entries.find((e) => e.amount > 0);
      return d && c ? `${d.accountId}|${c.accountId}` : "";
    })
  );

  const groups = new Map<string, DetectTx[]>();
  for (const t of transactions) {
    if (t.deleted || t.cancelled || t.date < cutoff) continue;
    if (t.entries.length !== 2) continue; // a recurring template only ever models one fixed debit/credit pair
    const [a, b] = t.entries;
    if (Math.abs(a.amount + b.amount) > 0.01) continue; // not a simple balanced 2-leg voucher
    const debitEntry = a.amount < 0 ? a : b;
    const creditEntry = a.amount < 0 ? b : a;
    const key = `${debitEntry.accountId}|${creditEntry.accountId}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const out: RecurringCandidate[] = [];
  for (const [key, txs] of groups) {
    if (existingKeys.has(key) || dismissedKeys.has(key) || txs.length < 2) continue;
    const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date));
    const debitLeg = (t: DetectTx) => t.entries.find((e) => e.amount < 0)!;
    const creditLeg = (t: DetectTx) => t.entries.find((e) => e.amount > 0)!;

    const amounts = sorted.map((t) => Math.abs(debitLeg(t).amount));
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const maxGapDeviation = sorted.length === 2 ? 0 : Math.max(...gaps.map((g) => Math.abs(g - avgGap)));

    const standard = STANDARD_FREQUENCIES.find((f) => Math.abs(avgGap - f.days) <= f.tolerance && maxGapDeviation <= f.tolerance * 2.2);
    let frequency: RecurringTemplate["frequency"];
    let intervalMonths: number | undefined;
    if (standard) {
      frequency = standard.frequency;
    } else if (sorted.length >= 3 && maxGapDeviation <= Math.max(avgGap * 0.35, 12)) {
      // Regular, but not one of the standard buckets -- a custom N-month interval. Needs 3+
      // occurrences (2+ observed gaps) to trust a non-standard cadence with any confidence.
      frequency = "custom";
      intervalMonths = Math.max(1, Math.round(avgGap / 30.4));
    } else {
      continue; // gaps too irregular (or too few data points) to call this a recurring pattern
    }

    const last = sorted[sorted.length - 1];
    const debit = accountById.get(debitLeg(last).accountId);
    const credit = accountById.get(creditLeg(last).accountId);
    if (!debit || !credit) continue;

    out.push({
      key,
      debitAccountId: debit.id,
      debitAccountName: debit.name,
      creditAccountId: credit.id,
      creditAccountName: credit.name,
      voucherType: last.type || "Payment",
      suggestedLabel: inferLabel(debit.name, credit.name, last.narration || ""),
      occurrences: sorted.map((t) => ({ date: t.date, amount: Math.abs(debitLeg(t).amount), narration: t.narration || "", txGuid: t.guid })),
      avgAmount,
      avgGapDays: avgGap,
      suggestedFrequency: frequency,
      suggestedIntervalMonths: intervalMonths,
      suggestedDayOfMonth: Number(last.date.slice(8, 10)),
      suggestedAnchorMonth: frequency === "monthly" || frequency === "yearly" ? undefined : last.date.slice(0, 7),
    });
  }
  return out.sort((a, b) => b.occurrences.length - a.occurrences.length);
}

/** Builds a draft RecurringTemplate from a candidate, with its most recent matching period
 * pre-linked as already-posted if one exists in the candidate's own occurrence history -- without
 * this, creating a template for a bill that was JUST paid this period would immediately show up
 * as "due" in Needs Attention, which is backwards for a brand-new template. */
export function templateFromCandidate(c: RecurringCandidate, asOfDate: string): RecurringTemplate {
  const roundedAmount = Math.round(c.avgAmount * 100) / 100;
  const template: RecurringTemplate = {
    id: crypto.randomUUID(),
    label: c.suggestedLabel,
    active: true,
    frequency: c.suggestedFrequency,
    intervalMonths: c.suggestedIntervalMonths,
    anchorMonth: c.suggestedAnchorMonth,
    dayOfMonth: c.suggestedDayOfMonth,
    voucherType: c.voucherType,
    narrationTemplate: `{month} ${c.suggestedLabel}`,
    entries: [
      { accountId: c.debitAccountId, amount: -roundedAmount },
      { accountId: c.creditAccountId, amount: roundedAmount },
    ],
    postings: [],
  };
  const currentKey = currentPeriodKey(template, asOfDate);
  const match = c.occurrences.find((o) => o.txGuid && currentPeriodKey(template, o.date) === currentKey);
  if (match?.txGuid) template.postings = [{ periodKey: currentKey, txGuid: match.txGuid, postedAt: match.date }];
  return template;
}
