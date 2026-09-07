import type { Loan } from "./vault-types";
import { computePaymentSplit } from "./loans";

// Composer, not self-contained -- like lib/cash-flow-forecast.ts, this imports a runtime value
// (computePaymentSplit) from another lib/*.ts file, which node --test can't resolve across
// lib/*.ts files, so this isn't directly unit-tested -- same accepted precedent, verified live.

export type AmortizationRow = {
  period: number; // 1-based payment number
  date: string; // YYYY-MM-DD, startDate + `period` months
  payment: number;
  principal: number;
  interest: number;
  balance: number; // outstanding balance after this payment
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// startDate + n months, clamping the day-of-month to whatever the target month actually has (e.g.
// Jan 31 + 1mo -> Feb 28/29) instead of overflowing into the following month like plain setMonth
// would.
function addMonthsClamped(dateStr: string, n: number): string {
  const [y, m, day] = dateStr.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInTargetMonth = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, daysInTargetMonth)).padStart(2, "0")}`;
}

// The full standard-payment amortization schedule for a loan, from its startDate through payoff --
// a projection off the loan's own terms (principal/rate/standardPayment), not a read of actually
// posted payment vouchers. A loan's real running balance (lib/loans-ledger.ts's
// currentLoanBalance) is the source of truth and can diverge from this schedule (extra payments,
// missed payments, or -- as with a loan like "CCU Home Loan" -- a balance that's actually
// maintained by periodic manual journal entries rather than through this app's own "Record
// Payment" flow at all). This schedule is illustrative: "here's what the full term looks like at
// the stated terms," covering both past and future periods in one table.
export function computeLoanAmortizationSchedule(loan: Loan): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  let balance = loan.originalPrincipal;
  for (let period = 1; period <= loan.termMonths && balance > 0.5; period++) {
    const { interest } = computePaymentSplit(balance, loan.annualRate, loan.standardPayment);
    const payment = round2(Math.min(loan.standardPayment, balance + interest));
    const principal = round2(payment - interest);
    balance = round2(Math.max(0, balance - principal));
    rows.push({ period, date: addMonthsClamped(loan.startDate, period), payment, principal, interest, balance });
  }
  return rows;
}
