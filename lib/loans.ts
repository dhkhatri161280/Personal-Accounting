// Pure loan amortization math -- deliberately free of any runtime import from another lib/*.ts
// file, mirroring lib/fixed-assets.ts/lib/prepaid-expense.ts's own structure (node --test cannot
// resolve extensionless relative imports between two lib/*.ts files when the import carries
// actual runtime values). Ledger-mutating logic (posting Tx's, creating accounts) lives in
// lib/loans-ledger.ts.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Standard fixed-rate amortization payment: P * r(1+r)^n / ((1+r)^n - 1), where r is the monthly
// rate and n is the term in months. A 0% loan is just principal spread evenly over the term (the
// formula divides by zero at r=0). termMonths <= 0 returns 0 rather than dividing by zero.
export function standardMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  if (termMonths <= 0) return 0;
  if (annualRate <= 0) return round2(principal / termMonths);
  const r = annualRate / 12;
  const factor = Math.pow(1 + r, termMonths);
  return round2((principal * r * factor) / (factor - 1));
}

// Splits one payment into interest (balance x monthly rate) and principal (the remainder of the
// payment) -- the same method every fixed-rate loan servicer uses, and the same formula
// lib/mortgage-amortization.ts's computeMortgagePaymentSplit already uses for the one real
// mortgage it tracks, reimplemented generically here (parameterized on balance/rate/payment
// instead of closing over one hardcoded loan).
export function computePaymentSplit(
  balance: number,
  annualRate: number,
  paymentAmount: number
): { principal: number; interest: number } {
  const interest = round2(balance * (annualRate / 12));
  const principal = round2(paymentAmount - interest);
  return { principal, interest };
}
