const cents = (value) => Math.round(Number(value || 0) * 100);
const norm = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
export const CASH_BANK_GROUPS = ["bank accounts", "bank od a/c", "cash-in-hand"];
export function isCashBankAccount(account) {
  return (
    !!account &&
    CASH_BANK_GROUPS.includes(norm(account.parent || account.group || account.category))
  );
}
export function validateVoucher(voucher, accounts) {
  const errors = [],
    entries = Array.isArray(voucher?.entries) ? voucher.entries : [],
    byId = new Map((accounts || []).map((a) => [Number(a.id), a])),
    byName = new Map((accounts || []).map((a) => [norm(a.name), a]));
  if (!String(voucher?.type || "").trim()) errors.push("Choose a voucher type.");
  if (entries.length < 2) errors.push("A voucher must contain at least two ledger lines.");
  if (entries.some((e) => !Number.isFinite(Number(e.amount)) || cents(e.amount) === 0))
    errors.push("Every ledger line must have a non-zero amount.");
  if (entries.reduce((sum, e) => sum + cents(e.amount), 0) !== 0)
    errors.push("Total debit and credit amounts must be equal.");
  if (!entries.some((e) => cents(e.amount) < 0) || !entries.some((e) => cents(e.amount) > 0))
    errors.push("A voucher requires both debit and credit lines.");
  const resolved = entries.map(
    (e) => byId.get(Number(e.accountId)) || byName.get(norm(e.accountName || e.name)) || null
  );
  if (resolved.some((a) => !a)) errors.push("Every voucher line must use an existing ledger.");
  if (resolved.some((a) => a && a.active === false))
    errors.push("Inactive ledgers cannot be used in a new or edited voucher.");
  const ids = entries.map((e, i) =>
    String(e.accountId || resolved[i]?.id || norm(e.accountName || e.name))
  );
  if (new Set(ids).size !== ids.length)
    errors.push("The same ledger cannot be used more than once in a voucher.");
  const lines = entries.map((e, i) => ({
      amount: cents(e.amount),
      cashBank: isCashBankAccount(resolved[i]),
    })),
    type = norm(voucher?.type);
  if (type === "payment" && !lines.some((x) => x.amount > 0 && x.cashBank))
    errors.push("Payment voucher requires at least one Bank or Cash ledger on the credit side.");
  if (type === "receipt" && !lines.some((x) => x.amount < 0 && x.cashBank))
    errors.push("Receipt voucher requires at least one Bank or Cash ledger on the debit side.");
  if (type === "contra" && lines.some((x) => !x.cashBank))
    errors.push("Contra voucher can contain only Bank, Bank OD, or Cash ledgers.");
  if (type === "journal" && lines.some((x) => x.cashBank))
    errors.push(
      "Journal voucher cannot contain Bank, Bank OD, or Cash ledgers; use Payment, Receipt, or Contra instead."
    );
  return { valid: errors.length === 0, errors };
}
export function assertVoucherValid(voucher, accounts) {
  const result = validateVoucher(voucher, accounts);
  if (!result.valid) throw new Error(result.errors.join(" "));
  return voucher;
}
