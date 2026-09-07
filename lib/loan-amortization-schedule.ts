import type { Ledger, Loan } from "./vault-types";
import { standardMonthlyPayment, computePaymentSplit } from "./loans";
import { currentLoanBalance } from "./loans-ledger";

// Composer, not self-contained -- like lib/cash-flow-forecast.ts, this imports runtime values
// (standardMonthlyPayment, computePaymentSplit, currentLoanBalance) from other lib/*.ts files,
// which node --test can't resolve across lib/*.ts files, so this isn't directly unit-tested --
// same accepted precedent, verified live.

export type LoanScheduleRow = {
  date: string;
  // "posted": a real ledger entry. "estimated": a past/present month with no real entry, filled
  // from the loan's stated terms (the best available answer when the ledger itself has a gap).
  // "projected": a future month, same computation, rolled forward from the real current balance.
  type: "posted" | "estimated" | "projected";
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

// First-of-month, one month after `dateStr` -- monthly schedule rows land on the 1st (matching
// how a standard note actually schedules payments: "the 1st day of each month"), not on whatever
// day-of-month the loan happened to be registered on.
function firstOfNextMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
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

// Every real transaction actually posted for this loan, in chronological order, with the real
// running balance after each one. Two kinds of real posting exist for a loan like this:
// - Direct entries against the loan's own liability account (`loan.accountId`) -- the opening
//   registration, every "Record Payment" voucher, or any other journal entry posted straight to
//   it (e.g. a periodic manual balance adjustment). The real ledger balance is the source of
//   truth here (`currentLoanBalance`).
// - Older historical payment vouchers posted BEFORE the loan had its own liability account at
//   all -- these split Dr the interest-expense account (`loan.interestExpenseAccountId`) and Dr
//   whatever account was standing in for the principal side (for a real mortgage, that's the
//   "Home" fixed-asset account) / Cr the paying bank account. There's no liability account to
//   read a balance back from for these, so the running balance is tracked by cumulative
//   subtraction from the original principal instead, and resyncs to the real ledger balance the
//   moment a direct entry (above) appears.
// Either way this is a straight read of what's actually in the ledger, not a formula.
function actualHistory(data: Ledger, loan: Loan): LoanScheduleRow[] {
  const rows: LoanScheduleRow[] = [];
  const txs = data.transactions
    .filter(
      (t) => !t.deleted && !t.cancelled && t.entries.some((e) => e.accountId === loan.accountId || e.accountId === loan.interestExpenseAccountId)
    )
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)));

  let computedBalance = loan.originalPrincipal;
  for (const t of txs) {
    const loanAcctEntries = t.entries.filter((e) => e.accountId === loan.accountId);
    const interestEntries = t.entries.filter((e) => e.accountId === loan.interestExpenseAccountId);
    const interestPaid = round2(interestEntries.reduce((s, e) => s + -e.amount, 0));

    if (loanAcctEntries.length > 0) {
      const principal = round2(loanAcctEntries.reduce((s, e) => s + -e.amount, 0));
      if (principal === 0 && interestPaid === 0) continue;
      const balance = currentLoanBalance(data, loan, t.date);
      rows.push({
        date: t.date,
        type: "posted",
        ratePct: worstCaseRatePct(loan, t.date),
        note: t.narration,
        payment: interestPaid !== 0 ? round2(principal + interestPaid) : null,
        principal,
        interest: interestPaid !== 0 ? interestPaid : null,
        balance,
      });
      computedBalance = balance;
    } else if (interestPaid !== 0) {
      const totalPayment = round2(t.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0));
      const principal = round2(totalPayment - interestPaid);
      computedBalance = round2(computedBalance - principal);
      rows.push({
        date: t.date,
        type: "posted",
        ratePct: worstCaseRatePct(loan, t.date),
        note: t.narration,
        payment: round2(totalPayment),
        principal,
        interest: interestPaid,
        balance: computedBalance,
      });
    }
  }
  return rows;
}

// The full loan schedule as ONE continuous table, month by month, from the loan's own startDate
// through payoff or maturity -- whichever comes first. Every calendar month is represented:
// - A month with a real posted entry (see actualHistory) shows that entry's real numbers, and the
//   running balance is re-anchored to the real ledger balance from that point on -- so an
//   out-of-schedule or extra principal payment immediately changes every month that follows.
// - A month with no real entry is filled from the loan's stated terms: "estimated" if that month
//   is today or earlier (the ledger has a gap there -- most loans aren't re-posted every single
//   month, e.g. a balance maintained by periodic manual catch-up entries), "projected" if it's in
//   the future.
// Filled months re-amortize the payment over the remaining term every time the worst-case rate
// changes (matching the Note's own "Calculation of Changes" language), and otherwise hold the
// payment flat, same as the real contract (a partial prepayment does NOT change the payment amount
// until the next Change Date). If the loan has no known reset terms (`rateAdjustment` unset) but
// does have `rateValidThrough` set, the schedule stops filling future months there instead of
// guessing, and `rateUnknownPast` reports why.
export function computeLoanSchedule(
  data: Ledger,
  loan: Loan,
  asOfDate: string
): { rows: LoanScheduleRow[]; rateUnknownPast: string | null } {
  const posted = actualHistory(data, loan);
  const postedByMonth = new Map<string, LoanScheduleRow[]>();
  for (const row of posted) {
    const key = row.date.slice(0, 7);
    if (!postedByMonth.has(key)) postedByMonth.set(key, []);
    postedByMonth.get(key)!.push(row);
  }

  const rows: LoanScheduleRow[] = [];
  let balance = loan.originalPrincipal;
  let ratePct = loan.annualRate * 100;
  let payment = loan.standardPayment;
  let rateUnknownPast: string | null = null;

  // Any real entry posted in the loan's own start month (e.g. its opening registration) predates
  // the monthly grid below (which starts the month AFTER startDate) -- emit those first.
  const startMonthKey = loan.startDate.slice(0, 7);
  for (const row of postedByMonth.get(startMonthKey) ?? []) {
    rows.push(row);
    balance = row.balance;
  }
  postedByMonth.delete(startMonthKey);

  const maturityDate = addMonthsClamped(loan.startDate, loan.termMonths);
  let cursor = firstOfNextMonth(loan.startDate);
  let guard = 0;
  while (cursor <= maturityDate && balance > 0.5 && guard < loan.termMonths + 12) {
    guard++;
    const monthKey = cursor.slice(0, 7);
    const postedThisMonth = postedByMonth.get(monthKey);
    if (postedThisMonth) {
      for (const row of postedThisMonth) {
        rows.push(row);
        balance = row.balance;
      }
      ratePct = worstCaseRatePct(loan, cursor);
    } else {
      if (!loan.rateAdjustment && loan.rateValidThrough && cursor > loan.rateValidThrough && cursor > asOfDate) {
        rateUnknownPast = loan.rateValidThrough;
        break;
      }
      const rp = worstCaseRatePct(loan, cursor);
      let note = "";
      if (rp !== ratePct) {
        const remainingMonths = Math.max(1, monthsBetween(cursor, maturityDate) + 1);
        payment = standardMonthlyPayment(balance, rp / 100, remainingMonths);
        ratePct = rp;
        note = "Rate reset (worst case per contract cap) -- payment re-amortized over remaining term";
      }
      const { interest } = computePaymentSplit(balance, rp / 100, payment);
      const pay = round2(Math.min(payment, balance + interest));
      const principal = round2(pay - interest);
      balance = round2(Math.max(0, balance - principal));
      rows.push({ date: cursor, type: cursor <= asOfDate ? "estimated" : "projected", ratePct: rp, note, payment: pay, principal, interest, balance });
    }
    cursor = firstOfNextMonth(cursor);
  }

  return { rows, rateUnknownPast };
}
