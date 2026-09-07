import type { Ledger, Loan } from "./vault-types";
import { computePaymentSplit } from "./loans";
import { currentLoanBalance } from "./loans-ledger";

// Composer, not self-contained -- like lib/cash-flow-forecast.ts, this imports runtime values
// (computePaymentSplit, currentLoanBalance) from other lib/*.ts files, which node --test can't
// resolve across lib/*.ts files, so this isn't directly unit-tested -- same accepted precedent,
// verified live.

export type ActualHistoryRow = {
  date: string;
  narration: string;
  amount: number; // positive = principal reduction (paid down), negative = balance increase
  balance: number; // real running balance after this entry, straight from the ledger
};

export type ProjectedRow = {
  period: number; // months out from asOfDate
  date: string;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addMonthsClamped(dateStr: string, n: number): string {
  const [y, m, day] = dateStr.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInTargetMonth = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, daysInTargetMonth)).padStart(2, "0")}`;
}

// Every real transaction actually posted against this loan's own liability account, in
// chronological order, with the account's real running balance after each one -- covers the
// opening registration, every "Record Payment" voucher, AND any other journal entry the user
// posted directly against the account (e.g. an out-of-band principal paydown, or -- as with a loan
// whose balance is maintained by periodic manual adjustments rather than through "Record Payment"
// at all -- every one of those adjustments). This is a straight read of what's actually in the
// ledger, not a formula.
export function computeLoanActualHistory(data: Ledger, loan: Loan): ActualHistoryRow[] {
  const rows: ActualHistoryRow[] = [];
  const txs = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.entries.some((e) => e.accountId === loan.accountId))
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)));
  for (const t of txs) {
    const amount = t.entries.filter((e) => e.accountId === loan.accountId).reduce((s, e) => s + -e.amount, 0);
    if (amount === 0) continue;
    rows.push({ date: t.date, narration: t.narration, amount: round2(amount), balance: currentLoanBalance(data, loan, t.date) });
  }
  return rows;
}

// The remaining schedule, rolled forward month by month from the loan's REAL current balance
// (currentLoanBalance as of `asOfDate`, not the original principal) -- so it reflects every actual
// payment/adjustment already posted, including out-of-schedule principal paydowns. Stops at
// `loan.rateValidThrough` if set (an adjustable-rate loan whose rate is only confirmed through a
// known date) rather than silently projecting the current rate indefinitely -- `rateUnknownPast`
// on the return value flags this so the UI can say so instead of just trailing off.
export function computeLoanProjectedSchedule(
  data: Ledger,
  loan: Loan,
  asOfDate: string
): { rows: ProjectedRow[]; rateUnknownPast: string | null } {
  const rows: ProjectedRow[] = [];
  let balance = currentLoanBalance(data, loan, asOfDate);
  const maxPeriods = loan.termMonths; // safety bound; payoff (balance<=0.5) stops it well before this in practice
  let stoppedForRateReason: string | null = null;
  for (let period = 1; period <= maxPeriods && balance > 0.5; period++) {
    const date = addMonthsClamped(asOfDate, period);
    if (loan.rateValidThrough && date > loan.rateValidThrough) {
      stoppedForRateReason = loan.rateValidThrough;
      break;
    }
    const { interest } = computePaymentSplit(balance, loan.annualRate, loan.standardPayment);
    const payment = round2(Math.min(loan.standardPayment, balance + interest));
    const principal = round2(payment - interest);
    balance = round2(Math.max(0, balance - principal));
    rows.push({ period, date, payment, principal, interest, balance });
  }
  return { rows, rateUnknownPast: stoppedForRateReason };
}
