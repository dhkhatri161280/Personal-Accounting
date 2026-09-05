// Pure, framework-free classification helpers shared by the Plaid import pipeline. Extracted
// out of components/vault/PlaidImport.tsx specifically so they're unit-testable with Node's
// native test runner (no React/browser dependency to work around) -- this is the exact class of
// logic that produced a real bug this session (a Contra promoted with unhelpful raw bank text
// as its narration instead of a clean "{Card} Payment" label).

export function isCcAcct(a: { name: string; parent?: string }): boolean {
  // Must literally say "credit card" in the account name — avoids false matches on
  // "credit union", "income credit", etc.
  return /credit card/i.test(a.name);
}

export function isBankAcct(a: { name: string; parent?: string }): boolean {
  const n = a.name.toLowerCase();
  // Match known bank/depository account patterns; explicitly exclude expense/income names
  if (/exps?|expense|income|revenue|wages|salary|rent|fee|charge|tax|insurance/i.test(n)) return false;
  return /bank of america|chase bank|wells fargo|citibank|citi bank|sbi|hdfc|icici|axis bank|kotak|checking|savings/i.test(n) ||
    /^bank\s/i.test(a.name) || /\sbank$/i.test(a.name);
}

// Returns true only when ALL entries in a transaction are bank or credit card accounts.
// This is the correct Contra definition: funds transfer between Bank<->Bank or Bank<->CreditCard.
// Any entry with an expense/income account disqualifies the transaction.
// Override voucherType to "Contra" when ALL draft entries are bank/CC accounts.
//
// A card-payment Contra promoted here (as opposed to one built by a dedicated branch like the
// BofA-branded "PAYMENT TO ACCT #..." case, which already sets its own clean narration)
// otherwise keeps whatever raw text the bank/Plaid reported for the underlying transaction --
// confirmed directly to sometimes be a genuinely unhelpful bill-pay template fragment like
// "Ch. No. :" (a check-number field left blank because the payment was electronic, not by
// check). Rather than special-casing each issuer's own raw-text quirks one at a time, this
// uniformly relabels ANY newly-promoted bank<->card Contra as "{Card} Payment" whenever the
// existing narration doesn't already read like a real payment description -- so every card
// issuer gets the same clean treatment BofA's own branded case already gets, not just BofA.
export function enforceContraType<T extends { voucherType: string; narration: string; entries: { accountId: number; accountName: string }[] }>(
  result: T,
  accounts: { id: number; name: string; parent?: string }[]
): T {
  if (result.voucherType !== "Payment" && result.voucherType !== "Receipt") return result;
  if (result.entries.length === 0) return result;
  const allFinancial = result.entries.every((e) => {
    const a = accounts.find((ac) => ac.id === e.accountId);
    return a && (isCcAcct(a) || isBankAcct(a));
  });
  if (!allFinancial) return result;
  if (/payment/i.test(result.narration)) return { ...result, voucherType: "Contra" };
  const cardEntry = result.entries.find((e) => {
    const a = accounts.find((ac) => ac.id === e.accountId);
    return a && isCcAcct(a);
  });
  const cardName = cardEntry ? accounts.find((ac) => ac.id === cardEntry.accountId)?.name : undefined;
  return {
    ...result,
    voucherType: "Contra",
    narration: cardName ? `${cardName} Payment` : result.narration,
  };
}
