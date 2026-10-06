import type { Account, Entry, RecurringTemplate } from "./vault-types";
import { currentMonthSiblingAccount } from "./vault-accounting.ts";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "YYYY-MM" for monthly templates, "YYYY" for yearly -- the unit a template's postings are
// tracked against. A monthly template is due once per calendar month regardless of what day it
// actually gets posted on; a yearly one is due once per calendar year.
export function currentPeriodKey(template: RecurringTemplate, asOfDate: string): string {
  return template.frequency === "yearly" ? asOfDate.slice(0, 4) : asOfDate.slice(0, 7);
}

export type DueTemplate = { template: RecurringTemplate; periodKey: string; periodLabel: string };

function periodLabelFor(template: RecurringTemplate, periodKey: string): string {
  if (template.frequency === "yearly") return periodKey;
  const [y, m] = periodKey.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

// Active templates not yet posted for the current period. A MONTHLY template with a dayOfMonth
// set is due starting that day of the month, not from the 1st -- flagging "HOA due" on the 1st
// when the bill isn't actually due until the 6th defeats the point of the reminder (confirmed
// live: the user wants it to show up ON the due day, not two-plus weeks early). No dayOfMonth
// set, or a YEARLY template (whose period has no stored month to anchor a day against -- see
// dayOfMonth's comment in vault-types.ts), keeps the old whole-period behavior.
export function dueTemplates(templates: RecurringTemplate[] | undefined, asOfDate: string): DueTemplate[] {
  const todayOfMonth = Number(asOfDate.slice(8, 10));
  return (templates ?? [])
    .filter((t) => t.active)
    .filter((t) => t.frequency !== "monthly" || t.dayOfMonth == null || todayOfMonth >= t.dayOfMonth)
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
