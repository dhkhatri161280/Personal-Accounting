import type { Account, Entry, RecurringTemplate } from "./vault-types";
import { currentMonthSiblingAccount } from "./vault-accounting.ts";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Short human label for a template's frequency -- shared by the Masters list and the Recurring
// report's own template list, so both read the same way instead of each hand-rolling the same
// ternary chain (the original only handled "monthly"/"yearly" and silently mislabeled every new
// frequency added here as "Monthly").
export function frequencyLabel(template: RecurringTemplate): string {
  switch (template.frequency) {
    case "yearly":
      return "Yearly";
    case "bimonthly":
      return "Every 2 months";
    case "quarterly":
      return "Quarterly";
    case "halfyearly":
      return "Every 6 months";
    case "custom":
      return `Every ${template.intervalMonths ?? 1} month(s)`;
    default:
      return "Monthly";
  }
}

// Fixed interval for every frequency except "custom", which carries its own intervalMonths.
function intervalMonthsFor(template: RecurringTemplate): number {
  switch (template.frequency) {
    case "bimonthly":
      return 2;
    case "quarterly":
      return 3;
    case "halfyearly":
      return 6;
    case "yearly":
      return 12;
    case "custom":
      return Math.max(1, template.intervalMonths ?? 1);
    default:
      return 1;
  }
}

function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}
function ymOf(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// "YYYY-MM" for monthly templates, "YYYY" for yearly, and for bimonthly/quarterly/custom the
// "YYYY-MM" of whichever N-month bucket asOfDate falls in -- bucketed from the template's own
// anchorMonth (or, lacking one, asOfDate's own month) so periods land on the bill's real cycle
// rather than an arbitrary offset. monthly is the N=1 special case of the same bucketing, so it's
// unaffected by anchor choice. The unit a template's postings are tracked against -- a monthly
// template is due once per calendar month regardless of what day it actually gets posted on; a
// yearly one is due once per calendar year; a quarterly one once per 3-month bucket.
export function currentPeriodKey(template: RecurringTemplate, asOfDate: string): string {
  if (template.frequency === "yearly") return asOfDate.slice(0, 4);
  const n = intervalMonthsFor(template);
  if (n === 1) return asOfDate.slice(0, 7);
  const anchorIdx = monthIndex(template.anchorMonth || asOfDate.slice(0, 7));
  const todayIdx = monthIndex(asOfDate.slice(0, 7));
  const bucketIndex = Math.floor((todayIdx - anchorIdx) / n);
  return ymOf(anchorIdx + bucketIndex * n);
}

export type DueTemplate = { template: RecurringTemplate; periodKey: string; periodLabel: string };

function periodLabelFor(template: RecurringTemplate, periodKey: string): string {
  if (template.frequency === "yearly") return periodKey;
  const n = intervalMonthsFor(template);
  const startIdx = monthIndex(periodKey);
  if (n === 1) {
    const [y, m] = periodKey.split("-");
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  }
  const [startY] = periodKey.split("-").map(Number);
  const endIdx = startIdx + n - 1;
  const [endY] = ymOf(endIdx).split("-").map(Number);
  const startName = MONTH_NAMES[startIdx % 12].slice(0, 3);
  const endName = MONTH_NAMES[endIdx % 12].slice(0, 3);
  return startY === endY ? `${startName}–${endName} ${startY}` : `${startName} ${startY}–${endName} ${endY}`;
}

// Minimal transaction shape this module needs for live period-satisfaction checking --
// deliberately narrower than the real Tx type so it works from either the full vault-types.ts
// Ledger or MastersPanel.tsx's own narrower MasterLedger view (both are structurally compatible).
export interface RecurringCheckTx {
  date: string;
  deleted?: boolean;
  cancelled?: boolean;
  entries: { accountId: number; amount: number }[];
}

// The calendar span a periodKey covers -- the whole month for monthly, the whole year for
// yearly, or the N-month bucket for bimonthly/quarterly/custom.
function periodDateRange(template: RecurringTemplate, periodKey: string): { start: string; end: string } {
  if (template.frequency === "yearly") return { start: `${periodKey}-01-01`, end: `${periodKey}-12-31` };
  const n = intervalMonthsFor(template);
  const endIdx = monthIndex(periodKey) + n - 1;
  const [endY, endM] = ymOf(endIdx).split("-").map(Number);
  const lastDayOfEndMonth = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
  return { start: `${periodKey}-01`, end: `${ymOf(endIdx)}-${String(lastDayOfEndMonth).padStart(2, "0")}` };
}

// A template's own entries.accountId is fixed at creation time -- for a "House Hold Exps - <Mon>
// <YY>" leg (that family gets a brand-new ledger account every calendar month, see
// vault-accounting.ts), the saved id is forever whichever sibling existed when the template was
// built, so a raw accountId match against a real transaction from a LATER month would silently
// never fire again. Redirect through the same currentMonthSiblingAccount() buildVoucherFromTemplate
// already uses to post, re-targeted to the CANDIDATE transaction's own date (not today's) so a
// year-old House Hold Exps voucher still matches the sibling that was current back then. A no-op
// for every other account family.
function resolveAccountIdForDate(accountId: number, accounts: Account[] | undefined, date: string): number {
  if (!accounts) return accountId;
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return accountId;
  return currentMonthSiblingAccount(account, accounts, date).id;
}

// A template counts as satisfied for a period once EITHER it has an explicit posting link
// (manual "Post", "Already posted...", or a Plaid auto-match) OR -- the actual fix here -- any
// real transaction already touches the same two ledgers within the period's own date range, no
// matter how it got there (Tally sync, Plaid import, manual entry) and no matter the amount. This
// template is a reminder, not the system of record for the posting itself: the real voucher
// always comes from whichever payment source actually handled it (confirmed live: a usage-based
// bill like electricity or water varies every cycle, so requiring an amount match, or requiring
// the user to click "Already posted..." by hand each time, would either miss it or nag forever
// even once it's genuinely paid). `accounts` is optional so House Hold Exps's month-sibling
// redirect only kicks in when the caller has a ledger's account list to pass.
export function isTemplateSatisfiedForPeriod(
  template: RecurringTemplate,
  periodKey: string,
  transactions: RecurringCheckTx[],
  accounts?: Account[]
): boolean {
  if (template.postings.some((p) => p.periodKey === periodKey)) return true;
  const debit = template.entries.find((e) => e.amount < 0);
  const credit = template.entries.find((e) => e.amount > 0);
  if (!debit || !credit) return false;
  const { start, end } = periodDateRange(template, periodKey);
  return transactions.some((t) => {
    if (t.deleted || t.cancelled || t.date < start || t.date > end) return false;
    const debitId = resolveAccountIdForDate(debit.accountId, accounts, t.date);
    const creditId = resolveAccountIdForDate(credit.accountId, accounts, t.date);
    const hasDebit = t.entries.some((e) => e.accountId === debitId && e.amount < 0);
    const hasCredit = t.entries.some((e) => e.accountId === creditId && e.amount > 0);
    return hasDebit && hasCredit;
  });
}

// Most recent date this template's bill was actually paid/accounted for -- the later of its most
// recent explicit posting link and the most recent real transaction through its own two ledgers
// (so it reflects reality even for a bill that's never had an explicit "Post"/"Already posted..."
// click, now that isTemplateSatisfiedForPeriod above auto-recognizes those too). Undefined when
// there's no sign of it ever having been paid yet.
export function lastPaidDate(template: RecurringTemplate, transactions: RecurringCheckTx[], accounts?: Account[]): string | undefined {
  const debit = template.entries.find((e) => e.amount < 0);
  const credit = template.entries.find((e) => e.amount > 0);
  let latest: string | undefined;
  if (debit && credit) {
    for (const t of transactions) {
      if (t.deleted || t.cancelled) continue;
      const debitId = resolveAccountIdForDate(debit.accountId, accounts, t.date);
      const creditId = resolveAccountIdForDate(credit.accountId, accounts, t.date);
      const hasDebit = t.entries.some((e) => e.accountId === debitId && e.amount < 0);
      const hasCredit = t.entries.some((e) => e.accountId === creditId && e.amount > 0);
      if (hasDebit && hasCredit && (!latest || t.date > latest)) latest = t.date;
    }
  }
  for (const p of template.postings) {
    if (!latest || p.postedAt > latest) latest = p.postedAt;
  }
  return latest;
}

// Every real transaction that has ever satisfied this template, via the same account-pair match
// lastPaidDate uses just above, but keeping the REAL amount actually paid each time (not the
// template's own fixed entries.amount, which never changes) -- the raw material
// detectRecurringPriceIncreases needs to compare a bill's latest payment against its own recent
// history.
function paidOccurrences(template: RecurringTemplate, transactions: RecurringCheckTx[], accounts?: Account[]): { date: string; amount: number }[] {
  const debit = template.entries.find((e) => e.amount < 0);
  const credit = template.entries.find((e) => e.amount > 0);
  if (!debit || !credit) return [];
  const out: { date: string; amount: number }[] = [];
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    const debitId = resolveAccountIdForDate(debit.accountId, accounts, t.date);
    const creditId = resolveAccountIdForDate(credit.accountId, accounts, t.date);
    const debitEntry = t.entries.find((e) => e.accountId === debitId && e.amount < 0);
    const hasCredit = t.entries.some((e) => e.accountId === creditId && e.amount > 0);
    if (debitEntry && hasCredit) out.push({ date: t.date, amount: Math.abs(debitEntry.amount) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export type RecurringPriceIncrease = {
  template: RecurringTemplate;
  latestAmount: number;
  latestDate: string;
  previousAvg: number;
  pctIncrease: number;
};

export function priceIncreaseDismissKey(templateId: string, latestDate: string): string {
  return `${templateId}:${latestDate}`;
}

const PRICE_INCREASE_MIN_HISTORY = 3; // prior occurrences needed before the latest, to have a real baseline
const PRICE_INCREASE_MAX_COV = 0.12; // prior occurrences varying >12% already -- a usage-based bill, not flagged
const PRICE_INCREASE_MIN_PCT = 0.08; // the jump itself must be at least 8%...
const PRICE_INCREASE_MIN_DOLLARS = 1; // ...AND at least $1, so rounding noise on a tiny bill doesn't flag

// Flags a recurring bill whose MOST RECENT real payment jumped meaningfully above its own recent
// history -- a subscription price hike, an insurance renewal increase, a rate change -- while
// deliberately staying quiet for a bill that's naturally variable cycle to cycle. Judged from the
// PRIOR occurrences' own coefficient of variation (stdev / mean): a usage-based bill like
// electricity or water (see isTemplateSatisfiedForPeriod's own comment on these) routinely swings
// 20-30%+ season to season, so a plain "is the latest amount higher than average" check would
// nag on every one of those cycles -- real noise, not a real price change. A bill that's instead
// been flat for months and then jumps past both the %-and-$ threshold is exactly the "did a price
// quietly go up" case worth surfacing.
export function detectRecurringPriceIncreases(
  templates: RecurringTemplate[] | undefined,
  transactions: RecurringCheckTx[],
  accounts?: Account[],
  dismissed?: string[]
): RecurringPriceIncrease[] {
  const dismissedSet = new Set(dismissed ?? []);
  const out: RecurringPriceIncrease[] = [];
  for (const t of templates ?? []) {
    if (!t.active) continue;
    const occ = paidOccurrences(t, transactions, accounts);
    if (occ.length < PRICE_INCREASE_MIN_HISTORY + 1) continue;
    const latest = occ[occ.length - 1];
    if (dismissedSet.has(priceIncreaseDismissKey(t.id, latest.date))) continue;
    const prior = occ.slice(0, -1).slice(-6); // trailing up to 6 prior occurrences
    const mean = prior.reduce((s, o) => s + o.amount, 0) / prior.length;
    if (mean <= 0) continue;
    const variance = prior.reduce((s, o) => s + (o.amount - mean) ** 2, 0) / prior.length;
    const cov = Math.sqrt(variance) / mean;
    if (cov > PRICE_INCREASE_MAX_COV) continue;
    const pctIncrease = (latest.amount - mean) / mean;
    if (pctIncrease < PRICE_INCREASE_MIN_PCT || latest.amount - mean < PRICE_INCREASE_MIN_DOLLARS) continue;
    out.push({ template: t, latestAmount: latest.amount, latestDate: latest.date, previousAvg: mean, pctIncrease });
  }
  return out;
}

// Active templates not yet satisfied for the current period (see isTemplateSatisfiedForPeriod).
// A MONTHLY (or bimonthly/quarterly/custom) template with a dayOfMonth set is due starting that
// day of the month, not from the 1st -- flagging "HOA due" on the 1st when the bill isn't
// actually due until the 6th defeats the point of the reminder (confirmed live: the user wants it
// to show up ON the due day, not two-plus weeks early). For a multi-month cycle, the day is
// checked against the LAST month of that cycle's own period -- a quarterly bill shouldn't flag on
// day 1 of the FIRST month of its quarter. A YEARLY template with an anchorMonth set (the month
// it's actually due, e.g. "2024-12" for a December home insurance renewal) is gated the exact
// same way -- confirmed live: without this, a December-due bill showed as "due" starting every
// January 1st, nagging for 11 months before it was ever actually due. A YEARLY template with NO
// anchorMonth (its period has no stored month to anchor a day against -- see dayOfMonth's comment
// in vault-types.ts) keeps the old whole-year behavior, since there's genuinely no known due
// month to gate on. `transactions` is optional for backward compatibility with any caller that
// hasn't been updated to pass it -- omitting it falls back to only checking explicit postings,
// same as before this function gained live matching.
// A bill's nominal due day can land on a weekend -- most billers (and this reminder) don't
// expect a payment to actually go out on a Saturday/Sunday, so the flagging threshold rolls
// forward to the next weekday instead of nagging a day or two early for no real reason. Weekends
// only (no public-holiday calendar) -- that would need a maintained, country-specific holiday
// list (US vs. India books) that's a separate feature of its own.
function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + "T12:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}
function nextWorkingDay(dateStr: string): string {
  let d = new Date(dateStr + "T12:00:00Z");
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The actual flagging threshold date for a template due on `dayOfMonth` within `yearMonth`:
// the raw due day (clamped to that month's real last day, e.g. day 31 in a 30-day month), rolled
// forward to the next working day if it lands on a weekend -- then `graceDays` calendar days
// added on top of THAT already-rolled date, rolled forward again itself if the resulting
// grace-expiry date also lands on a weekend. Same "roll forward" treatment applied twice, not
// just once, per the user's own ask: a Friday due date with a 2-day grace period expires Sunday
// before rolling, which itself rolls forward to Monday -- never flags mid-weekend either way.
function effectiveDueThreshold(yearMonth: string, dayOfMonth: number, graceDays: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rawDue = `${yearMonth}-${String(Math.min(dayOfMonth, lastDay)).padStart(2, "0")}`;
  const effectiveDue = nextWorkingDay(rawDue);
  return graceDays > 0 ? nextWorkingDay(addDays(effectiveDue, graceDays)) : effectiveDue;
}

export function dueTemplates(templates: RecurringTemplate[] | undefined, asOfDate: string, transactions?: RecurringCheckTx[], accounts?: Account[]): DueTemplate[] {
  const todayIdx = monthIndex(asOfDate.slice(0, 7));
  // dayOfMonth itself stays the bill's true usual due day; graceDays (and the weekend-rolling
  // above) shift only the flagging threshold, so a template with jitter (see graceDays's comment
  // in vault-types.ts) doesn't have to misrepresent its own due day just to stop premature
  // flagging.
  const isDue = (t: RecurringTemplate, yearMonth: string) =>
    t.dayOfMonth == null || asOfDate >= effectiveDueThreshold(yearMonth, t.dayOfMonth, t.graceDays ?? 0);
  return (templates ?? [])
    .filter((t) => t.active)
    .filter((t) => {
      if (t.frequency === "yearly") {
        if (!t.anchorMonth) return true;
        const dueMonth = Number(t.anchorMonth.slice(5, 7));
        const todayMonth = Number(asOfDate.slice(5, 7));
        if (todayMonth < dueMonth) return false;
        if (todayMonth === dueMonth) return isDue(t, `${asOfDate.slice(0, 4)}-${t.anchorMonth.slice(5, 7)}`);
        return true; // past the due month entirely -- definitely due
      }
      const n = intervalMonthsFor(t);
      if (n === 1) return isDue(t, asOfDate.slice(0, 7));
      const periodKey = currentPeriodKey(t, asOfDate);
      const lastMonthIdx = monthIndex(periodKey) + n - 1;
      if (todayIdx < lastMonthIdx) return false;
      if (todayIdx === lastMonthIdx) return isDue(t, ymOf(lastMonthIdx));
      return true; // past the period's last month entirely -- definitely due
    })
    .map((t) => {
      const periodKey = currentPeriodKey(t, asOfDate);
      return { template: t, periodKey, periodLabel: periodLabelFor(t, periodKey) };
    })
    .filter(({ template, periodKey }) => !isTemplateSatisfiedForPeriod(template, periodKey, transactions ?? [], accounts));
}

// What a template's voucher looks like -- shared by the manual "Post" button and the Plaid-match
// path so there's exactly one place that turns a template into voucher entries/narration.
export function buildVoucherFromTemplate(
  template: RecurringTemplate,
  date: string,
  accountById: Map<number, Account>
): { entries: Entry[]; voucherType: string; narration: string } {
  const [y, m] = date.split("-");
  const narration = template.narrationTemplate
    .replace("{month}", MONTH_NAMES[Number(m) - 1])
    .replace("{year}", y);
  // A template's own entries.accountId is fixed at creation time (e.g. "House Hold Exps - Apr
  // 17", whichever month existed when the template was built). That family gets a brand-new
  // ledger account every calendar month (see vault-accounting.ts), so posting straight against
  // the saved accountId would forever hit that one stale month. Redirect through the same
  // currentMonthSiblingAccount() reversals already use, so a House Hold Exps leg always lands
  // in the account for `date`'s own month regardless of which sibling the template was created
  // against; every other account family is untouched (currentMonthSiblingAccount no-ops on
  // non-"House Hold Exps" names).
  const accounts = Array.from(accountById.values());
  const entries: Entry[] = template.entries.map((e) => {
    const original = accountById.get(e.accountId);
    const account = original ? currentMonthSiblingAccount(original, accounts, date) : undefined;
    return {
      accountId: account?.id ?? e.accountId,
      accountName: account?.name ?? original?.name ?? "",
      amount: e.amount,
    };
  });
  return { entries, voucherType: template.voucherType, narration };
}

export type RecurringMatch = { template: RecurringTemplate; periodKey: string };

// Plaid-import detection: active templates with a plaidMatch rule, institution+amount match,
// not already posted for the current period. Mirrors the mortgage/payroll matching already in
// components/vault/PlaidImport.tsx's buildDraft(), generalized to user-defined rules.
export function matchRecurringTemplate(
  institutionName: string,
  amount: number,
  date: string,
  templates: RecurringTemplate[] | undefined
): RecurringMatch | null {
  for (const template of templates ?? []) {
    if (!template.active || !template.plaidMatch) continue;
    const periodKey = currentPeriodKey(template, date);
    if (template.postings.some((p) => p.periodKey === periodKey)) continue;
    let re: RegExp;
    try {
      re = new RegExp(template.plaidMatch.institutionPattern, "i");
    } catch {
      continue;
    }
    if (!re.test(institutionName)) continue;
    // The debit side's total is the real-world amount that hits the bank -- by double-entry it
    // equals the credit side's total, but summing debits handles a multi-line split (e.g. a
    // payment split across two expense accounts) without assuming exactly two entries.
    const expected = template.entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
    // Clamped to `expected` itself -- an unreasonably wide tolerance (however it got configured;
    // this is the actual match-time enforcement, not just a UI-side guard) would otherwise match
    // transactions near $0, which is never a legitimate "same bill, amount drifted a bit" case.
    // This is the one auto-applied Plaid-match rule with no merchant-text check at all (a
    // user-configured institution pattern + amount is trusted outright, like payroll), so an
    // unbounded tolerance was the one way it could misfire.
    const tolerance = Math.min(template.plaidMatch.amountTolerance, expected);
    if (Math.abs(Math.abs(amount) - expected) > tolerance) continue;
    return { template, periodKey };
  }
  return null;
}
