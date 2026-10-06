import type { Ledger } from "./vault-types.ts";
import { ledgerBalanceAsOf } from "./vault-accounting.ts";

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
type LedgerSlice = Pick<Ledger, "accounts" | "transactions">;

export function currentMortgageBalance(ledger: LedgerSlice, asOfDate: string): number {
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
  ledger: LedgerSlice,
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

// TCJA's acquisition-debt cap on the home mortgage interest deduction -- loans originated after
// 2017-12-15 (this one closed 2022-12-28) are capped at $750,000; older loans are grandfathered
// at $1,000,000. The original Closing Disclosure principal below ($900,000, same source as
// MORTGAGE_ANCHOR above) is ABOVE the $750k cap, so interest is NOT fully deductible -- only the
// proportional share is, per IRS Pub 936's average-balance method (see deductibleMortgageInterest
// below). This was previously not modeled at all -- computeItemizedDeduction took whatever
// mortgage interest the ledger matched and deducted it in full, overstating the real deduction.
export const MORTGAGE_ORIGINAL_ACQUISITION_DEBT = 900_000;
export const MORTGAGE_ACQUISITION_DEBT_CAP = 750_000;
// California never conformed to the TCJA's reduction from $1,000,000 to $750,000 -- it still
// allows the OLDER, higher cap regardless of origination date. Confirmed directly against the
// real 2025 Schedule CA (540): it shows a $2,369 ADDITION to mortgage interest for CA (federal
// $21,586 -> CA $23,955.38, i.e. the full real Form 1098 box 1 amount, uncapped) -- exactly what
// this constant predicts (avg balance ~$833k is under CA's $1M cap, so capApplies is false and
// the full amount passes through for CA even though federal's $750k cap reduces it).
export const CA_MORTGAGE_ACQUISITION_DEBT_CAP = 1_000_000;

const CCU_HOME_LOAN_ACCOUNT_NAME = "CCU Home Loan";

// Average outstanding balance during `taxYear`, straight from the real "CCU Home Loan" liability
// ledger's own posted history -- NOT reconstructed via currentMortgageBalance's anchor-rollback,
// which only rolls FORWARD from a recent statement date and returns the (wrong, too-low) current
// anchor balance for any date before it, like a prior tax year's start/end. The liability
// account's own balance as of any PAST date is already exact, straight from what was actually
// posted -- no reconstruction needed. Falls back to currentMortgageBalance (today's anchor) at
// both endpoints if the CCU Home Loan account itself isn't found, so this degrades gracefully on
// an older vault rather than throwing.
export function averageMortgageBalanceForYear(ledger: LedgerSlice, taxYear: string): number {
  const ccuAcct = ledger.accounts.find((a) => a.name.toLowerCase() === CCU_HOME_LOAN_ACCOUNT_NAME.toLowerCase());
  const balanceAt = (date: string) =>
    ccuAcct ? Math.abs(ledgerBalanceAsOf(ledger, ccuAcct.id, date)) : currentMortgageBalance(ledger, date);
  const startBalance = balanceAt(`${taxYear}-01-01`);
  const endBalance = balanceAt(`${taxYear}-12-31`);
  return round2((startBalance + endBalance) / 2);
}

// IRS Pub 936's "average balance" method: acquisition debt above the cap only gets its
// proportional share of interest deducted (limit / average balance), not the first or last
// dollars specifically. A household entirely under the cap gets prorationFactor 1 (no reduction).
export function deductibleMortgageInterest(
  averageBalance: number,
  interestPaid: number,
  cap: number = MORTGAGE_ACQUISITION_DEBT_CAP
): { deductible: number; prorationFactor: number; capApplies: boolean } {
  const capApplies = averageBalance > cap;
  const prorationFactor = capApplies ? cap / averageBalance : 1;
  return {
    deductible: round2(Math.max(0, interestPaid) * prorationFactor),
    prorationFactor: round2(prorationFactor),
    capApplies,
  };
}
