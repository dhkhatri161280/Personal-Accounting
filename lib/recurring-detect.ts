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
  key: string; // grouping/de-dup key -- see identityKey() below
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

const MONEY_ACCOUNT_RE = /bank|credit card|checking|savings|cash-in-hand|^cash\b/i;
// "House Hold Exps" is a special, hardcoded ledger family that auto-provisions a BRAND NEW
// account every single calendar month (see vault-accounting.ts's currentMonthSiblingAccount) --
// transactions within one of those months look like tight, short-interval "recurring" clusters
// (regular grocery/household spending against that one month's envelope account), but it's not a
// bill at all, just noise from this app's own monthly-rotating-ledger mechanic. Excluded outright
// rather than relying on the interval/amount heuristics to rule it out (confirmed live: it kept
// surfacing as several bogus "monthly" candidates, one per calendar month it ever existed).
const HOUSEHOLD_EXPS_RE = /^House\s*Hold\s*Exps\b/i;

function looksLikeMoneyAccount(name: string): boolean {
  return MONEY_ACCOUNT_RE.test(name);
}

// Strips a trailing "- Mon YY" style month suffix some ledger families carry (e.g. "House Hold
// Exps - Apr 26") -- that's the account's own per-month identity, not part of a bill's name.
function stripMonthSuffix(name: string): string {
  return name.replace(/\s*-\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*['’]?\d{2,4}$/i, "").trim();
}

// Prefer the expense/liability/income side's own name (usually descriptive, e.g. "Netflix
// Subscription", "Car EMI", "HOA Dues") over the bank/credit-card/cash side it was paid from or
// into, which is almost never a useful label for the bill itself.
function inferLabel(debitName: string, creditName: string, narration: string): string {
  const base = looksLikeMoneyAccount(debitName) && !looksLikeMoneyAccount(creditName)
    ? creditName
    : looksLikeMoneyAccount(creditName) && !looksLikeMoneyAccount(debitName)
      ? debitName
      : narration || debitName;
  return stripMonthSuffix(base) || "Recurring bill";
}

// The "identity" of a bill is whichever leg ISN'T a bank/card/cash account -- a dedicated
// expense/liability/income ledger like "PG&E Electric" or "Car EMI". Grouping by that one account
// alone (not the exact debit+credit pair) means a bill paid from a different card some months
// (switched primary cards, autopay moved banks, etc.) still gets recognized as the same recurring
// bill instead of silently splitting into several under-threshold groups that never individually
// reach the occurrence minimum -- confirmed live: this is exactly why a genuinely monthly utility
// bill wasn't surfacing. Falls back to the exact pair when BOTH legs are money accounts (a Contra
// bank transfer) or NEITHER is (unusual), where there's no single "identity" side to anchor on.
function identityKey(debitAccountId: number, creditAccountId: number, accountById: Map<number, DetectAccount>): string {
  const debitIsMoney = looksLikeMoneyAccount(accountById.get(debitAccountId)?.name || "");
  const creditIsMoney = looksLikeMoneyAccount(accountById.get(creditAccountId)?.name || "");
  if (debitIsMoney && !creditIsMoney) return `id:${creditAccountId}`;
  if (creditIsMoney && !debitIsMoney) return `id:${debitAccountId}`;
  return `pair:${debitAccountId}|${creditAccountId}`;
}

/** Scans the Day Book for a regularly-repeating bill and proposes it as a recurring template --
 * the "automatically find my recurring bills" entry point for Masters -> Recurring's own "Scan"
 * button. Groups by the bill's own ledger (identityKey() above), not the exact debit+credit pair
 * -- a bill paid from a different card some months still counts as the same recurring bill.
 * Amount is deliberately NOT a tight filter -- confirmed live, a usage-based bill (electricity,
 * water) can legitimately swing 2x+ cycle to cycle; interval regularity is the primary thing that
 * makes something "recurring", not amount consistency. Requires at least 2 occurrences, but a
 * 2-occurrence candidate only qualifies if its one gap lands tightly on a standard cadence
 * (monthly/bimonthly/quarterly/yearly) -- a single gap can't confidently imply a non-standard
 * custom interval, so that still needs 3+ occurrences. Already-templated and explicitly dismissed
 * bills are excluded so re-scanning doesn't keep re-suggesting what's already set up or what the
 * user already said isn't a real recurring bill. The "House Hold Exps" family (a new ledger every
 * calendar month, by this app's own design) is excluded outright as pure noise. */
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
      return d && c ? identityKey(d.accountId, c.accountId, accountById) : "";
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
    const debitName = accountById.get(debitEntry.accountId)?.name || "";
    const creditName = accountById.get(creditEntry.accountId)?.name || "";
    if (HOUSEHOLD_EXPS_RE.test(debitName) || HOUSEHOLD_EXPS_RE.test(creditName)) continue;
    const key = identityKey(debitEntry.accountId, creditEntry.accountId, accountById);
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

export interface DiagnosticEntry {
  key: string;
  debitAccountName: string;
  creditAccountName: string;
  occurrences: { date: string; amount: number }[];
  avgGapDays: number | null;
  maxGapDeviation: number | null;
  verdict: string;
  reason: string;
}

/** Traces the exact same logic as detectRecurringCandidates, but for every 2-leg transaction
 * touching an account whose name matches `query` -- and instead of silently dropping a
 * non-qualifying group, explains WHY, with the actual computed numbers. Built because "why isn't
 * my bill showing up" can't be debugged from outside the app (no access to the live, encrypted
 * vault data) -- this answers it directly, in the app itself, instead of more guessing. */
export function diagnoseLedger(
  transactions: DetectTx[],
  accounts: DetectAccount[],
  existingTemplates: RecurringTemplate[],
  dismissedKeys: Set<string>,
  lookbackMonths: number,
  asOfDate: string,
  query: string
): DiagnosticEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cutoff = monthsAgo(asOfDate, lookbackMonths);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const matchingAccountIds = new Set(accounts.filter((a) => a.name.toLowerCase().includes(q)).map((a) => a.id));
  const existingKeys = new Set(
    existingTemplates.map((t) => {
      const d = t.entries.find((e) => e.amount < 0);
      const c = t.entries.find((e) => e.amount > 0);
      return d && c ? identityKey(d.accountId, c.accountId, accountById) : "";
    })
  );

  const groups = new Map<string, DetectTx[]>();
  const excludedByWindow: string[] = [];
  const excludedByLegCount: string[] = [];
  for (const t of transactions) {
    const touchesMatch = t.entries.some((e) => matchingAccountIds.has(e.accountId));
    if (!touchesMatch) continue;
    if (t.deleted || t.cancelled) continue;
    if (t.date < cutoff) { excludedByWindow.push(t.guid || t.date); continue; }
    if (t.entries.length !== 2) { excludedByLegCount.push(t.guid || t.date); continue; }
    const [a, b] = t.entries;
    if (Math.abs(a.amount + b.amount) > 0.01) { excludedByLegCount.push(t.guid || t.date); continue; }
    const debitEntry = a.amount < 0 ? a : b;
    const creditEntry = a.amount < 0 ? b : a;
    const key = identityKey(debitEntry.accountId, creditEntry.accountId, accountById);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const out: DiagnosticEntry[] = [];
  if (excludedByWindow.length) {
    out.push({
      key: "~excluded-window", debitAccountName: "", creditAccountName: "",
      occurrences: [], avgGapDays: null, maxGapDeviation: null,
      verdict: "excluded (outside lookback window)",
      reason: `${excludedByWindow.length} transaction(s) matching "${query}" fall before the ${lookbackMonths}-month cutoff (${cutoff}) and aren't considered at all.`,
    });
  }
  if (excludedByLegCount.length) {
    out.push({
      key: "~excluded-legs", debitAccountName: "", creditAccountName: "",
      occurrences: [], avgGapDays: null, maxGapDeviation: null,
      verdict: "excluded (not a simple 2-leg voucher)",
      reason: `${excludedByLegCount.length} transaction(s) matching "${query}" have more than 2 entries (a split voucher) and aren't considered -- a recurring template only models one fixed debit/credit pair.`,
    });
  }

  for (const [key, txs] of groups) {
    const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date));
    const debitLeg = (t: DetectTx) => t.entries.find((e) => e.amount < 0)!;
    const creditLeg = (t: DetectTx) => t.entries.find((e) => e.amount > 0)!;
    const last = sorted[sorted.length - 1];
    const debit = accountById.get(debitLeg(last).accountId);
    const credit = accountById.get(creditLeg(last).accountId);
    const debitName = debit?.name || `(unknown account ${debitLeg(last).accountId})`;
    const creditName = credit?.name || `(unknown account ${creditLeg(last).accountId})`;
    const occurrences = sorted.map((t) => ({ date: t.date, amount: Math.abs(debitLeg(t).amount) }));

    if (HOUSEHOLD_EXPS_RE.test(debitName) || HOUSEHOLD_EXPS_RE.test(creditName)) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: null, maxGapDeviation: null,
        verdict: "excluded (House Hold Exps family)", reason: "This is the special monthly-rotating House Hold Exps ledger, excluded outright as noise." });
      continue;
    }
    if (existingKeys.has(key)) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: null, maxGapDeviation: null,
        verdict: "skipped (already templated)", reason: "A recurring template already covers this exact bill identity." });
      continue;
    }
    if (dismissedKeys.has(key)) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: null, maxGapDeviation: null,
        verdict: "skipped (dismissed)", reason: "You previously dismissed this suggestion -- restore it from \"Show dismissed\" to bring it back." });
      continue;
    }
    if (!debit || !credit) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: null, maxGapDeviation: null,
        verdict: "rejected (unresolvable account)", reason: "One side of this voucher references an account id that no longer exists in the ledger list." });
      continue;
    }
    if (sorted.length < 2) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: null, maxGapDeviation: null,
        verdict: "rejected (too few occurrences)", reason: `Only ${sorted.length} matching transaction(s) in the window -- needs at least 2.` });
      continue;
    }

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const maxGapDeviation = sorted.length === 2 ? 0 : Math.max(...gaps.map((g) => Math.abs(g - avgGap)));
    const standard = STANDARD_FREQUENCIES.find((f) => Math.abs(avgGap - f.days) <= f.tolerance && maxGapDeviation <= f.tolerance * 2.2);

    if (standard) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: avgGap, maxGapDeviation,
        verdict: "accepted", reason: `Matches ${standard.frequency} (avg gap ${avgGap.toFixed(1)} days, target ${standard.days} ± ${standard.tolerance}).` });
    } else if (sorted.length >= 3 && maxGapDeviation <= Math.max(avgGap * 0.35, 12)) {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: avgGap, maxGapDeviation,
        verdict: "accepted", reason: `Regular custom interval (~${Math.round(avgGap / 30.4)} month(s), avg gap ${avgGap.toFixed(1)} days).` });
    } else {
      out.push({ key, debitAccountName: debitName, creditAccountName: creditName, occurrences, avgGapDays: avgGap, maxGapDeviation,
        verdict: "rejected (irregular interval)",
        reason: `Avg gap ${avgGap.toFixed(1)} days, but swings by up to ${maxGapDeviation.toFixed(1)} days between occurrences -- ${sorted.length < 3 ? "and a 2-occurrence candidate needs to land tightly on a standard monthly/bimonthly/quarterly/yearly cadence, not a custom one" : "too irregular to call this a consistent cycle"}.` });
    }
  }
  return out;
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
