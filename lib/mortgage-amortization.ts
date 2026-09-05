import type { Ledger } from "./vault-types";

// Confirmed directly against the user's real Closing Disclosure (12/28/2022 disbursement):
// $900,000 original principal, 2.875% initial rate, 5/5 Adjustable Rate product, 30-year term --
// computes to a $3,734.03 monthly P&I payment, matching every historically-posted voucher amount
// to the penny. The current balance below is a real, user-provided anchor point (from a live
// statement, not derived) -- the calculation rolls FORWARD from this anchor rather than
// reconstructing the full history from the closing date, since the exact first-payment-date
// convention and the effect of the one-time $20,000 extra principal payment aren't independently
// knowable. Self-corrects for anything posted to the "Home" account after the anchor date
// (scheduled principal AND any future lump-sum extra payments), so it stays accurate without
// needing to be recalibrated by hand unless the rate itself changes.
export const MORTGAGE_ANCHOR = { asOfDate: "2026-09-04", balance: 787_454.73 };
export const MORTGAGE_ANNUAL_RATE = 0.02875;
export const MORTGAGE_STANDARD_PAYMENT = 3734.03;
export const MORTGAGE_HOME_ACCOUNT_NAMES = ["Home"];
export const MORTGAGE_INTEREST_ACCOUNT_NAMES = ["Interest on Home Loan"];
// 5/5 Adjustable Rate: 2.875% holds for years 1-5, then adjusts every 5 years (year 6, 11, 16...)
// -- NOT annually, and NOT fixed for the full 30-year term. The Closing Disclosure gives only the
// worst-case bound for the reset ($3,531 min / $4,609 max in years 6-10), not the actual formula
// (index + margin) -- but even with that formula, the real post-reset rate is fundamentally
// unknowable today: it depends on the index's value on the reset date itself (~Dec 2027), a
// future market rate, not something derivable from documents signed in 2022. Set one month before
// the actual 5-year mark as a safety margin -- once past this, the auto-split stops trusting
// 2.875% and flags for manual verification instead of silently misstating interest with a rate
// that's no longer correct. Update both this date and MORTGAGE_ANNUAL_RATE once the real
// post-reset rate is known from an actual statement at that time.
export const MORTGAGE_RATE_VALID_THROUGH = "2027-11-28";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Current outstanding principal as of `asOfDate`: the real anchor balance, minus every dollar
// posted to the "Home" account since the anchor date (positive/Dr entries reduce the loan --
// covers both the regular monthly principal portion and any one-time extra payment alike, since
// both hit the same account).
export function currentMortgageBalance(ledger: Ledger, asOfDate: string): number {
  const homeAcct = ledger.accounts.find(
    (a) => a.active !== false && MORTGAGE_HOME_ACCOUNT_NAMES.some((n) => a.name.toLowerCase() === n.toLowerCase())
  );
  if (!homeAcct) return MORTGAGE_ANCHOR.balance;
  let paidSinceAnchor = 0;
  for (const t of ledger.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date <= MORTGAGE_ANCHOR.asOfDate || t.date > asOfDate) continue;
    for (const e of t.entries) {
      if (e.accountId === homeAcct.id && e.amount < 0) paidSinceAnchor += -e.amount;
    }
  }
  return round2(MORTGAGE_ANCHOR.balance - paidSinceAnchor);
}

// Splits the next scheduled payment (dated `paymentDate`) into principal and interest, using
// the balance as of just before that date. Interest = balance x (annual rate / 12); principal
// is the remainder of the standard payment -- same method every fixed-rate mortgage servicer
// uses.
export function computeMortgagePaymentSplit(
  ledger: Ledger,
  paymentDate: string
): { principal: number; interest: number; totalPayment: number; balanceBefore: number; rateStale: boolean } {
  const balanceBefore = currentMortgageBalance(ledger, paymentDate);
  const monthlyRate = MORTGAGE_ANNUAL_RATE / 12;
  const interest = round2(balanceBefore * monthlyRate);
  const principal = round2(MORTGAGE_STANDARD_PAYMENT - interest);
  return {
    principal,
    interest,
    totalPayment: MORTGAGE_STANDARD_PAYMENT,
    balanceBefore,
    rateStale: paymentDate > MORTGAGE_RATE_VALID_THROUGH,
  };
}
