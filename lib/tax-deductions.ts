import type { Account, Tx } from "./vault-types";

export interface DeductionCategory {
  key: "medical" | "mortgageInterest" | "propertyTax" | "stateIncomeTax" | "charitable";
  label: string;
  keywords: RegExp;
}

/** Ledger-name keyword matching, same style as the fuzzy matching already used elsewhere in
 * this app (payroll voucher matching, recon). Matches whatever the user actually named their
 * expense ledgers -- shown in the UI so a miss (unmatched ledger, wrong bucket) is obvious
 * and correctable by renaming the ledger, rather than silently wrong. */
const CATEGORIES: DeductionCategory[] = [
  { key: "medical", label: "Medical & Dental Expenses", keywords: /medical|dental|health\s*insurance|doctor|hospital|pharmacy|\brx\b/i },
  // Word-order-independent: matches "Mortgage Interest", "Home Loan Interest", and
  // "Interest on Home Loan" alike -- requires "interest" plus either "mortgage" or "home
  // loan" somewhere in the name, not a fixed phrase order.
  { key: "mortgageInterest", label: "Home Mortgage Interest", keywords: /(?=.*interest)(?=.*(mortgage|home\s*loan))/i },
  { key: "propertyTax", label: "Property Tax", keywords: /property\s*tax|real\s*estate\s*tax/i },
  { key: "stateIncomeTax", label: "State Income Tax Paid", keywords: /state\s*(income\s*)?tax(\s*paid)?|state\s*withholding/i },
  { key: "charitable", label: "Charitable Donations", keywords: /donation|charity|charitable/i },
];

export interface DeductionMatch {
  key: DeductionCategory["key"];
  label: string;
  ledgers: { name: string; amount: number }[];
  total: number;
  excludedCount?: number;
}

// Money paid through (or transferred to) an HSA/FSA isn't separately deductible as a Schedule A
// medical expense -- it's already tax-advantaged, and gets its own above-the-line deduction
// (Form 8889), not modeled here. Real-world example: a "Medical Expenses" ledger that also
// contains "Trf to HSA Account for Medical Bill Payment" entries -- those would otherwise be
// double-counted as itemized medical expenses on top of never claiming the HSA deduction.
const HSA_FSA_NARRATION_RE = /\bHSA\b|\bFSA\b|flexible\s*spending/i;

/** Sums each matched ledger's expense-side entries (debit, i.e. negative amount by this
 * app's convention) posted within the given tax year. Only ledgers with a nonzero total for
 * the year are returned. */
export function matchDeductionLedgers(accounts: Account[], transactions: Tx[], year: string): DeductionMatch[] {
  const yearTx = transactions.filter((t) => !t.cancelled && !t.deleted && t.date.startsWith(year));
  return CATEGORIES.map((cat) => {
    const ledgers = accounts.filter((a) => a.active !== false && cat.keywords.test(a.name));
    let excludedCount = 0;
    const rows = ledgers
      .map((ledger) => {
        const amount = yearTx.reduce((s, t) => {
          if (cat.key === "medical" && HSA_FSA_NARRATION_RE.test(t.narration || "")) {
            const hasEntry = t.entries.some((e) => e.accountName === ledger.name && e.amount < 0);
            if (hasEntry) excludedCount++;
            return s;
          }
          return s + t.entries.filter((e) => e.accountName === ledger.name).reduce((es, e) => es + Math.max(0, -e.amount), 0);
        }, 0);
        return { name: ledger.name, amount };
      })
      .filter((r) => r.amount > 0.005);
    return {
      key: cat.key, label: cat.label, ledgers: rows, total: rows.reduce((s, r) => s + r.amount, 0),
      excludedCount: excludedCount > 0 ? excludedCount : undefined,
    };
  }).filter((m) => m.ledgers.length > 0);
}

export function deductionTotal(matches: DeductionMatch[], key: DeductionCategory["key"]): number {
  return matches.find((m) => m.key === key)?.total ?? 0;
}

export interface HsaContribution {
  txGuid: string;
  date: string;
  narration: string;
  amount: number;
}

// Only "HSA" here, not FSA -- FSA contributions don't get their own above-the-line deduction
// (they're only tax-advantaged if run through a payroll cafeteria plan, which already keeps
// them out of W-2 wages; a personal ledger transfer wouldn't represent a real FSA tax benefit).
const HSA_NARRATION_RE = /\bHSA\b/i;

/** Personal (non-payroll) HSA contributions for the year, found via the same narration signal
 * used to exclude these from Schedule A medical expenses -- same transactions, opposite
 * purpose: here they're a real above-the-line deduction (Form 8889), not a Schedule A expense. */
export function findHsaContributions(transactions: Tx[], year: string): HsaContribution[] {
  const yearTx = transactions.filter((t) => !t.cancelled && !t.deleted && t.date.startsWith(year));
  const results: HsaContribution[] = [];
  for (const t of yearTx) {
    if (!HSA_NARRATION_RE.test(t.narration || "")) continue;
    const amount = t.entries.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0);
    if (amount > 0.005) results.push({ txGuid: t.guid, date: t.date, narration: t.narration, amount });
  }
  return results;
}
