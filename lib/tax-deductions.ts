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
}

/** Sums each matched ledger's expense-side entries (debit, i.e. negative amount by this
 * app's convention) posted within the given tax year. Only ledgers with a nonzero total for
 * the year are returned. */
export function matchDeductionLedgers(accounts: Account[], transactions: Tx[], year: string): DeductionMatch[] {
  const yearTx = transactions.filter((t) => !t.cancelled && !t.deleted && t.date.startsWith(year));
  return CATEGORIES.map((cat) => {
    const ledgers = accounts.filter((a) => a.active !== false && cat.keywords.test(a.name));
    const rows = ledgers
      .map((ledger) => {
        const amount = yearTx.reduce(
          (s, t) =>
            s + t.entries.filter((e) => e.accountName === ledger.name).reduce((es, e) => es + Math.max(0, -e.amount), 0),
          0
        );
        return { name: ledger.name, amount };
      })
      .filter((r) => r.amount > 0.005);
    return { key: cat.key, label: cat.label, ledgers: rows, total: rows.reduce((s, r) => s + r.amount, 0) };
  }).filter((m) => m.ledgers.length > 0);
}

export function deductionTotal(matches: DeductionMatch[], key: DeductionCategory["key"]): number {
  return matches.find((m) => m.key === key)?.total ?? 0;
}
