import type { Account, PayrollDirectDepositSplit } from "./vault-types.ts";

export interface PayrollDepositLeg {
  accountId: number;
  accountName: string;
  amount: number; // positive -- the caller applies the Dr/Cr sign
}

/** Splits a paycheck's net deposit across bank accounts per the user's configured
 * payrollDirectDeposit setup (Masters -> Direct Deposit) -- mirrors how the employer payroll
 * portal itself splits a fixed $ amount into one or more accounts, with whatever's left over
 * landing in the one account marked "Remainder". Each active "fixed" split is capped at whatever
 * remains of netDeposit (so a stale/too-large fixed amount can't produce a negative remainder);
 * if no split is configured as "remainder" and there's still money left, it's folded into the
 * last fixed leg rather than silently dropped. Returns legs in configured order, omitting any
 * that resolve to $0 or an account id no longer in `accounts`. */
export function computePayrollDepositSplits(
  splits: PayrollDirectDepositSplit[] | undefined,
  netDeposit: number,
  accounts: Account[]
): PayrollDepositLeg[] {
  const active = (splits ?? []).filter((s) => s.active);
  if (active.length === 0) return [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  let remaining = netDeposit;
  const legs: PayrollDepositLeg[] = [];
  const fixedSplits = active.filter((s) => s.amountType === "fixed");
  const remainderSplits = active.filter((s) => s.amountType === "remainder");

  for (const s of fixedSplits) {
    const account = accountById.get(s.accountId);
    if (!account) continue;
    const amount = Math.max(0, Math.min(s.amount ?? 0, remaining));
    remaining -= amount;
    if (amount > 0.004) legs.push({ accountId: account.id, accountName: account.name, amount });
  }

  if (remainderSplits.length > 0) {
    // More than one active "remainder" is a misconfiguration (the UI warns about it) -- the
    // first one gets whatever's left, the rest get nothing rather than guessing a split.
    const account = accountById.get(remainderSplits[0].accountId);
    if (account && remaining > 0.004) legs.push({ accountId: account.id, accountName: account.name, amount: remaining });
  } else if (remaining > 0.004 && legs.length > 0) {
    // No remainder account configured but money is left over (e.g. gross pay grew past what the
    // fixed splits account for) -- fold it into the last fixed leg instead of silently dropping it.
    legs[legs.length - 1].amount += remaining;
  }

  return legs;
}
