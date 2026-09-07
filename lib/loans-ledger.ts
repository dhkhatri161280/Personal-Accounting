import type { Account, Ledger, Loan, Tx } from "./vault-types";
import { nextTransactionIds, nextVoucherNumber, ledgerBalanceAsOf } from "./vault-accounting";
import { appendAuditEntry } from "./audit";
import { findOrCreateAccount, registerOpeningBalance } from "./opening-balance-equity";
import { computePaymentSplit } from "./loans";

const LOANS_LIABILITY_GROUP_NAME = "Loans (Liability)";
const EXPENSE_GROUP_NAME = "Indirect Expenses";

// Finds an existing liability account by name under "Loans (Liability)", or creates one --
// registering its starting balance (the loan's outstanding principal as of startDate) via a real,
// auditable Journal Tx against "Opening Balance Equity" (registerOpeningBalance, direction
// "credit" since a loan is a liability: Cr the loan account / Dr equity) rather than a silent
// Account.openingBalance value with no double-entry counterpart. Never touches an existing
// account's real balance/history.
export function getOrCreateLoanAccount(data: Ledger, name: string, principal: number, startDate: string): { data: Ledger; account: Account } {
  const { account, accounts, created } = findOrCreateAccount(data.accounts, name, LOANS_LIABILITY_GROUP_NAME, data.currency, 0, "Liability");
  let next: Ledger = { ...data, accounts };
  if (created) next = registerOpeningBalance(next, account, principal, startDate, `Registered loan: ${name}`, "credit");
  return { data: next, account };
}

// Finds an existing expense-nature account by name, or creates one under "Indirect Expenses" --
// used for the interest-expense account picker when the user types a new category name instead
// of picking an existing one. Mirrors lib/prepaid-expense-ledger.ts's getOrCreateExpenseAccount.
export function getOrCreateExpenseAccount(data: Ledger, name: string): { data: Ledger; account: Account } {
  const { account, accounts } = findOrCreateAccount(data.accounts, name, EXPENSE_GROUP_NAME, data.currency, 0, "Expense");
  return { data: { ...data, accounts }, account };
}

// Current outstanding balance, computed live from whatever's actually posted to the loan's own
// account -- never a separately-tracked cursor, so it can't drift out of sync with reality (the
// same self-correcting approach lib/mortgage-amortization.ts's currentMortgageBalance uses).
// Returns a positive "amount owed" (ledgerBalanceAsOf's own sign convention shows a liability as
// negative, same as this app's credit-card accounts -- negated here since computePaymentSplit and
// every caller in this register want the positive outstanding-balance magnitude, not the raw
// account-display sign).
export function currentLoanBalance(data: Ledger, loan: Loan, asOfDate: string): number {
  return -ledgerBalanceAsOf(data, loan.accountId, asOfDate);
}

// Records one real loan payment: splits it into principal/interest off the current balance, posts
// a single balanced Journal Tx (Dr interestExpenseAccountId for the interest portion / Dr
// accountId for the principal portion, reducing the liability / Cr cashAccountId for the total
// paid), and marks the loan closed if the resulting balance rounds to ~0. Unlike
// postDepreciation/postAmortization, this posts ONE real payment at a time -- a loan payment is
// an actual cash event, not a non-cash accrual to batch-backfill on a schedule.
export function recordLoanPayment(
  data: Ledger,
  loanId: string,
  paymentDate: string,
  paymentAmount: number,
  cashAccountId: number
): { data: Ledger; principal: number; interest: number } | { error: string } {
  const loan = (data.loans ?? []).find((l) => l.id === loanId);
  if (!loan) return { error: "Loan not found" };
  if (loan.closed) return { error: "Loan already closed" };
  const loanAccount = data.accounts.find((a) => a.id === loan.accountId);
  const interestAccount = data.accounts.find((a) => a.id === loan.interestExpenseAccountId);
  const cashAccount = data.accounts.find((a) => a.id === cashAccountId);
  if (!loanAccount || !interestAccount || !cashAccount) return { error: "Account not found" };

  const balanceBefore = currentLoanBalance(data, loan, paymentDate);
  const { principal, interest } = computePaymentSplit(balanceBefore, loan.annualRate, paymentAmount);
  if (principal <= 0 && interest <= 0) return { error: "Payment amount is too small to cover any interest or principal" };

  const entries = [
    { accountId: interestAccount.id, accountName: interestAccount.name, amount: -interest }, // Dr interest expense
    { accountId: loanAccount.id, accountName: loanAccount.name, amount: -principal }, // Dr loan liability (reduces it)
    { accountId: cashAccount.id, accountName: cashAccount.name, amount: interest + principal }, // Cr cash paid
  ].filter((e) => e.amount !== 0);

  const tx: Tx = {
    id: nextTransactionIds(data.transactions, 1)[0],
    guid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    date: paymentDate,
    number: nextVoucherNumber(data, "Payment", paymentDate),
    type: "Payment",
    narration: `Loan payment - ${loan.name}`,
    historical: false,
    cancelled: false,
    syncStatus: "pending",
    entries,
  };

  const balanceAfter = round2(balanceBefore - principal);
  const updatedLoans = (data.loans ?? []).map((l) =>
    l.id === loanId ? { ...l, closed: Math.abs(balanceAfter) < 0.5 ? { date: paymentDate, txGuid: tx.guid } : l.closed } : l
  );

  let next: Ledger = { ...data, transactions: [...data.transactions, tx], loans: updatedLoans };
  next = appendAuditEntry(next, {
    entity: "voucher",
    entityId: tx.guid,
    action: "created",
    summary: `Loan payment for ${loan.name}: ${principal} principal, ${interest} interest`,
  });
  return { data: next, principal, interest };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
