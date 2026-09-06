import type { Account, Entry, RecurringTemplate } from "./vault-types";

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

// Active templates not yet posted for the current period -- due from the start of the period
// until posted, no day-of-month gating (a simple, predictable rule beats a fiddly one).
export function dueTemplates(templates: RecurringTemplate[] | undefined, asOfDate: string): DueTemplate[] {
  return (templates ?? [])
    .filter((t) => t.active)
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
  const entries: Entry[] = template.entries.map((e) => ({
    accountId: e.accountId,
    accountName: accountById.get(e.accountId)?.name ?? "",
    amount: e.amount,
  }));
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
    if (Math.abs(Math.abs(amount) - expected) > template.plaidMatch.amountTolerance) continue;
    return { template, periodKey };
  }
  return null;
}
