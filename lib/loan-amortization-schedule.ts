import type { Ledger, Loan } from "./vault-types";
import { standardMonthlyPayment, computePaymentSplit } from "./loans";
import { currentLoanBalance } from "./loans-ledger";

// Composer, not self-contained -- like lib/cash-flow-forecast.ts, this imports runtime values
// (standardMonthlyPayment, computePaymentSplit, currentLoanBalance) from other lib/*.ts files,
// which node --test can't resolve across lib/*.ts files, so this isn't directly unit-tested --
// same accepted precedent, verified live.

export type LoanScheduleRow = {
  date: string;
  type: "posted" | "projected";
  ratePct: number; // annual rate in effect, as a percentage (e.g. 2.875)
  note: string;
  payment: number | null; // null for posted rows -- a posted entry isn't necessarily a clean "payment"
  principal: number;
  interest: number | null; // null for posted rows -- can't be split out of a lump ledger adjustment
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

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

// The worst-case annual rate (%) in effect on `date`, per the loan's actual contractual reset
// terms: holds at the note rate until the first Change Date, then assumes the rate moves to
// whatever the contract caps allow at each reset (it can never legally be worse than this) --
// the real future rate depends on a market index value that isn't knowable today, so this is a
// ceiling, not a prediction.
function worstCaseRatePct(loan: Loan, date: string): number {
  if (!loan.rateAdjustment) return loan.annualRate * 100;
  const { firstChangeDate, changeIntervalMonths, firstChangeCapPct, periodicCapPct, lifetimeCapPct } = loan.rateAdjustment;
  if (date < firstChangeDate) return loan.annualRate * 100;
  let rate = Math.min(firstChangeCapPct, lifetimeCapPct);
  let changeDate = firstChangeDate;
  while (true) {
    const nextChangeDate = addMonthsClamped(changeDate, changeIntervalMonths);
    if (date < nextChangeDate) break;
    rate = Math.min(rate + periodicCapPct, lifetimeCapPct);
    changeDate = nextChangeDate;
  }
  return rate;
}

// Every real transaction actually posted against this loan's own liability account, in
// chronological order, with the account's real running balance after each one -- covers the
// opening registration, every "Record Payment" voucher, AND any other journal entry posted
// directly against the account (e.g. an out-of-band principal paydown, or -- for a loan whose
// balance is maintained by periodic manual adjustments rather than "Record Payment" at all --
// every one of those adjustments). A straight read of the ledger, not a formula.
function actualHistory(data: Ledger, loan: Loan): LoanScheduleRow[] {
  const rows: LoanScheduleRow[] = [];
  const txs = data.transactions
    .filter((t) => !t.deleted && !t.cancelled && t.entries.some((e) => e.accountId === loan.accountId))
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)));
  for (const t of txs) {
    const amount = t.entries.filter((e) => e.accountId === loan.accountId).reduce((s, e) => s + -e.amount, 0);
    if (amount === 0) continue;
    rows.push({
      date: t.date,
      type: "posted",
      ratePct: worstCaseRatePct(loan, t.date),
      note: t.narration,
      payment: null,
      principal: round2(amount),
      interest: null,
      balance: currentLoanBalance(data, loan, t.date),
    });
  }
  return rows;
}

// The full loan schedule as ONE chronological table: every real posted entry (see actualHistory
// above), followed by a month-by-month projection from TODAY's real balance through payoff or
// maturity -- whichever comes first. The projection re-amortizes the remaining balance over the
// remaining term every time the worst-case rate changes (matching the Note's own "Calculation of
// Changes" language: a new payment sufficient to repay the balance by the Maturity Date in
// substantially equal payments), and otherwise holds the payment flat, same as the real contract
// (a partial prepayment does NOT change the payment amount until the next Change Date). If the
// loan has no known reset terms (`rateAdjustment` unset) but does have `rateValidThrough` set, the
// projection stops there instead of guessing and `rateUnknownPast` reports why.
export function computeLoanSchedule(
  data: Ledger,
  loan: Loan,
  asOfDate: string
): { rows: LoanScheduleRow[]; rateUnknownPast: string | null } {
  const rows = actualHistory(data, loan);

  const maturityDate = addMonthsClamped(loan.startDate, loan.termMonths);
  let balance = currentLoanBalance(data, loan, asOfDate);
  let currentRatePct = worstCaseRatePct(loan, asOfDate);
  let currentPayment = loan.standardPayment;
  let rateUnknownPast: string | null = null;

  const totalRemainingMonths = Math.max(0, monthsBetween(asOfDate, maturityDate));
  for (let period = 1; period <= totalRemainingMonths && balance > 0.5; period++) {
    const date = addMonthsClamped(asOfDate, period);

    if (!loan.rateAdjustment && loan.rateValidThrough && date > loan.rateValidThrough) {
      rateUnknownPast = loan.rateValidThrough;
      break;
    }

    const ratePct = worstCaseRatePct(loan, date);
    let note = "";
    if (ratePct !== currentRatePct) {
      const remainingMonths = totalRemainingMonths - period + 1;
      currentPayment = standardMonthlyPayment(balance, ratePct / 100, remainingMonths);
      currentRatePct = ratePct;
      note = "Rate reset (worst case per contract cap) -- payment re-amortized over remaining term";
    }

    const { interest } = computePaymentSplit(balance, ratePct / 100, currentPayment);
    const payment = round2(Math.min(currentPayment, balance + interest));
    const principal = round2(payment - interest);
    balance = round2(Math.max(0, balance - principal));

    rows.push({ date, type: "projected", ratePct, note, payment, principal, interest, balance });
  }

  return { rows, rateUnknownPast };
}
