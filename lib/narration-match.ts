import type { Ledger } from "./vault-types.ts";
import { isCcAcct, isBankAcct } from "./plaid-classify.ts";

// Shared narration/merchant-token matching engine -- originally lived only inside
// components/vault/PlaidImport.tsx (the live Plaid import's auto-categorization), extracted here
// unchanged so lib/categorization-audit.ts can run the EXACT same algorithm retrospectively
// across already-posted vouchers, instead of a second, divergent reimplementation that might not
// agree with what live import actually does.

// ── GL suggestion from vault history (frequency-based per merchant) ───────────
// Each HistoryRecord stores the exact tokens from one historical narration plus
// the account IDs that were used. matchFromHistory counts how many past transactions
// agree on each (debit, credit) pair for this merchant and returns the majority.

export type HistoryRecord = {
  tokens: string[];
  debitId: number;
  creditId: number;
  isReceipt: boolean; // true = Tally "Receipt" (money IN); false = "Payment" (money OUT)
  amount: number; // absolute value of the debit/credit side -- feeds matchFromHistoryByAmount in PlaidImport.tsx
  // True when the debit side is itself a bank/credit-card account (a Contra transfer -- e.g. a
  // "pay off the Citi card" voucher), not a genuine expense category. matchFromHistoryByAmount
  // excludes these: a coincidental dollar-amount match against an old card-payoff record was a
  // real, confirmed bug -- a new $25 Comcast bill matched a prior $25 "Citi Credit Card Payment"
  // voucher purely by amount, then enforceContraType relabeled it "Citi Credit Card Payment" and
  // silently discarded the real merchant name entirely.
  debitIsFinancial: boolean;
};
export type HistoryIndex = HistoryRecord[];

// Generic finance/transaction vocabulary -- words that show up across many unrelated merchants'
// narrations (a recurring "Citi Credit Card Payment" voucher, a card-tier name, etc.) and would
// otherwise dominate the vote count in matchFromHistory purely by being common, drowning out the
// one word that actually identifies the merchant (e.g. "lululemon" in "Platinum Lululemon Credit"
// lost to "credit" matching dozens of unrelated Citi bill-payment vouchers). Excluded from BOTH
// the current transaction's tokens and historical narrations so neither side can match on noise.
export const GENERIC_FINANCE_WORDS = new Set([
  "credit", "debit", "payment", "pay", "card", "charge", "purchase", "platinum", "gold",
  "signature", "rewards", "reward", "points", "point", "statement", "adjustment", "adj",
  "thank", "you", "auto", "autopay", "online", "mobile", "web", "des", "ach", "pmt", "ppd",
  // Bank/institution-name boilerplate that shows up inside Plaid's own transaction description
  // template (e.g. "ACH CREDIT Bank of America CASHREWARD...") -- these identify who's reporting
  // the transaction, not what it's for, so they must not be treated as a merchant-matching signal.
  "bank", "america", "banking", "national",
]);

export function tokenise(text: string): string[] {
  const lower = (text || "").toLowerCase();
  // Ampersand-glued abbreviations (PG&E, AT&T, S&P) are real, meaningful merchant identifiers
  // even at 2 characters once collapsed (H&M -> "hm", S&P -> "sp") -- collected separately so
  // the general length>2 noise filter below (needed to drop generic short words like "of"/"to"
  // everywhere else) doesn't discard them the way it dropped PG&E's fragments before this fix.
  // Requires letters glued directly to the "&" (no spaces) so a genuine spaced separator like
  // "Bed & Bath" is untouched and still splits into two ordinary words via the path below.
  const abbreviations = (lower.match(/[a-z0-9]+(?:&[a-z0-9]+)+/g) || [])
    .map((w) => w.replace(/&/g, ""))
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w));
  const words = lower
    .replace(/(\S)&(\S)/g, "$1$2")
    .split(/[\s\W]+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !GENERIC_FINANCE_WORDS.has(w)); // drop pure numbers (store IDs, dates) and generic finance noise words
  return [...new Set([...words, ...abbreviations])];
}

// Each calendar month gets its own separate "House Hold Exps - Mon YY" account (see
// PlaidImport.tsx's houseHoldMonthName), so 4 real Lululemon vouchers across 4 different months
// look like 4 entirely different, unrelated debit accounts to matchFromHistory -- splitting what
// should be one strong, repeated signal into 4 single-vote candidates that never clear any
// confidence bar. Normalizing every household-month account to one shared sentinel id during
// indexing lets them all vote together; HOUSEHOLD_FAMILY_ID is substituted back to a real account
// id at every live-import call site that reads a matched id.
export const HOUSEHOLD_FAMILY_ID = -1;

export function buildHistoryIndex(ledger: Ledger): HistoryIndex {
  const index: HistoryIndex = [];
  const acctById = new Map(ledger.accounts.map((a) => [a.id, a]));
  const normalize = (id: number): number => {
    const a = acctById.get(id);
    return a && /^house hold exps/i.test(a.name) ? HOUSEHOLD_FAMILY_ID : id;
  };
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled) continue;
    const debitE = v.entries.find((e) => e.amount < 0);
    const creditE = v.entries.find((e) => e.amount > 0);
    if (!debitE || !creditE) continue;
    const tokens = tokenise(v.narration || "");
    if (tokens.length) {
      const debitAcct = acctById.get(debitE.accountId);
      index.push({
        tokens,
        debitId: normalize(debitE.accountId),
        creditId: normalize(creditE.accountId),
        isReceipt: v.type === "Receipt",
        amount: Math.abs(debitE.amount),
        debitIsFinancial: !!debitAcct && (isCcAcct(debitAcct) || isBankAcct(debitAcct)),
      });
    }
  }
  return index;
}

export function matchFromHistory(
  // Structural subset of PlaidImport.tsx's own PlaidTxRaw -- only these three fields are ever
  // read here, so this stays usable against a reconstructed narration (categorization-audit.ts)
  // without depending on that component-local type.
  tx: { merchant_name?: string; name?: string; amount: number },
  index: HistoryIndex
): { debitId: number; creditId: number; confidence: number; fromPaymentHistory: boolean; voteCount: number } | null {
  const merchantTokens = tokenise(tx.merchant_name || tx.name || "");
  if (!merchantTokens.length) return null;

  const txIsReceipt = tx.amount < 0; // Plaid: negative = money IN → maps to Receipt

  const pairCounts = new Map<string, number>();
  const pairPaymentVotes = new Map<string, number>();

  for (const { tokens, debitId, creditId, isReceipt, debitIsFinancial } of index) {
    // Same exclusion as matchFromHistoryByAmount/cardDefaultExpense, and for the same reason: a
    // merchant-token match against a Contra/transfer record (debit side is itself a bank/card
    // account, e.g. a recurring "pay off the card" voucher) means this merchant has never
    // actually been posted as a real expense/income -- trusting it here would relabel a genuine
    // new purchase as a card payment instead of surfacing it for the user to categorize properly.
    if (debitIsFinancial) continue;
    const tokenSet = new Set(tokens);
    if (!merchantTokens.some((t) => tokenSet.has(t))) continue;

    // Same-direction entries get 2× weight; opposite direction get 1×
    const weight = isReceipt === txIsReceipt ? 2 : 1;
    const key = `${debitId}:${creditId}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + weight);
    if (!isReceipt) pairPaymentVotes.set(key, (pairPaymentVotes.get(key) || 0) + weight);
  }

  if (!pairCounts.size) return null;

  let bestKey = "";
  let bestCount = 0;
  let totalWeight = 0;
  pairCounts.forEach((count, key) => {
    totalWeight += count;
    if (count > bestCount) { bestCount = count; bestKey = key; }
  });

  // The ≥3-vote bar exists to stop one anomalous entry (e.g. a single Costco Tire visit) from
  // overriding the correct default when MULTIPLE candidate pairs are competing for the same
  // merchant word -- but when only one pair matches at all (no competing candidates), there's
  // nothing for a low vote count to be wrong ABOUT, so a single unambiguous match (e.g. the one
  // prior Lululemon voucher) is trusted immediately instead of asking the user to repeat the
  // same manual correction 3 times before the app starts remembering it.
  const minVotes = pairCounts.size > 1 ? 3 : 1;
  if (bestCount < minVotes) return null;

  const [dStr, cStr] = bestKey.split(":");
  const agreement = bestCount / totalWeight;
  const depth = Math.min(bestCount / 6, 1); // 1.0 at 6+ weighted votes
  return {
    debitId: +dStr,
    creditId: +cStr,
    confidence: Math.min(agreement * 0.6 + depth * 0.4, 0.9),
    fromPaymentHistory: (pairPaymentVotes.get(bestKey) || 0) > 0,
    // Exposed separately from `confidence` -- a single, uncontested match (no competing pairs)
    // computes a deceptively HIGH confidence (100% "agreement" against nothing), even though it's
    // exactly the case a coincidental short-word overlap with an unrelated merchant looks like
    // (e.g. "hold" from "ACH HOLD ENCLAVE..." matching one unrelated voucher by chance). Callers
    // that have a stronger, independent signal available (see matchFromHistoryByAmount in
    // PlaidImport.tsx) can use this raw vote count to tell "one real match" apart from "one
    // coincidence."
    voteCount: bestCount,
  };
}
