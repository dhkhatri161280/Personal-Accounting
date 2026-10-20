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

// Active templates not yet posted for the current period. A MONTHLY (or bimonthly/quarterly/
// custom) template with a dayOfMonth set is due starting that day of the month, not from the
// 1st -- flagging "HOA due" on the 1st when the bill isn't actually due until the 6th defeats the
// point of the reminder (confirmed live: the user wants it to show up ON the due day, not
// two-plus weeks early). For a multi-month cycle, the day is checked against the LAST month of
// that cycle's own period -- a quarterly bill shouldn't flag on day 1 of the FIRST month of its
// quarter. No dayOfMonth set, or a YEARLY template (whose period has no stored month to anchor a
// day against -- see dayOfMonth's comment in vault-types.ts), keeps the old whole-period behavior.
export function dueTemplates(templates: RecurringTemplate[] | undefined, asOfDate: string): DueTemplate[] {
  const todayOfMonth = Number(asOfDate.slice(8, 10));
  const todayIdx = monthIndex(asOfDate.slice(0, 7));
  return (templates ?? [])
    .filter((t) => t.active)
    .filter((t) => {
      if (t.frequency === "yearly") return true;
      const n = intervalMonthsFor(t);
      if (n === 1) return t.dayOfMonth == null || todayOfMonth >= t.dayOfMonth;
      const periodKey = currentPeriodKey(t, asOfDate);
      const lastMonthIdx = monthIndex(periodKey) + n - 1;
      if (todayIdx < lastMonthIdx) return false;
      if (todayIdx === lastMonthIdx) return t.dayOfMonth == null || todayOfMonth >= t.dayOfMonth;
      return true; // past the period's last month entirely -- definitely due
    })
    .map((t) => {
      const periodKey = currentPeriodKey(t, asOfDate);
      return { template: t, periodKey, periodLabel: periodLabelFor(t, periodKey) };
    })
    .filter(({ template, periodKey }) => !template.postings.some((p) => p.periodKey === periodKey));
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
