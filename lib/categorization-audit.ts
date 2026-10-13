import type { Ledger } from "./vault-types.ts";
import { tokenise, HOUSEHOLD_FAMILY_ID } from "./narration-match.ts";
import { isCcAcct, isBankAcct } from "./plaid-classify.ts";

// Retrospective sibling of PlaidImport.tsx's own matchFromHistory() -- instead of matching a NEW
// transaction against the ledger's history, this re-runs the same merchant-token-vote logic
// against every ALREADY-POSTED voucher with itself excluded from its own evidence, to find
// vouchers whose current (debit, credit) assignment rests on weak or contradicted evidence.
//
// This exists because a real, confirmed bug in matchFromHistory's live auto-categorization
// (a single coincidental shared word with exactly one unrelated prior voucher, trusted
// immediately when no competing pair exists -- see matchFromHistory's own "minVotes" comment)
// posted two restaurant/delivery charges ("DECCAN MORSEL FREMONT", "Shopping @ DoorDash") onto a
// Vehicle Maintenance ledger. Re-deriving the SAME vote purely by checking "does this voucher's
// own pair still win?" can't catch that exact case -- the one coincidental vote that caused the
// mistake is still the only evidence either way once you exclude the voucher itself. Two
// different signals are needed instead:
//   - "thin": the voucher's own pair is supported by exactly ONE other voucher ledger-wide, with
//     NO competing alternative either -- i.e. the live decision (if it used matchFromHistory's
//     exact minVotes=1-when-uncontested loophole) rested on a single word shared with a single
//     other voucher. Flagged for review regardless of whether a better alternative is computable,
//     since there isn't enough evidence to compute one.
//   - "conflicting": a DIFFERENT (debit, credit) pair has more supporting votes, from 2+ other
//     vouchers, than the voucher's own currently-posted pair. This is the directly actionable
//     case -- a concrete suggested fix is available.
// Scoped to vouchers with a Plaid origin (plaidTxId set) only: this audits the auto-categorization
// pipeline's own risk surface, not vouchers a person typed in and chose deliberately -- a manual
// entry sharing a coincidental word with something else isn't a categorization bug.

export type CategorizationFlagKind = "thin" | "conflicting";

export type CategorizationFlag = {
  guid: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  narration: string;
  debitId: number;
  creditId: number;
  kind: CategorizationFlagKind;
  // How many OTHER vouchers (excluding this one) support the pair it's currently posted to.
  ownVotes: number;
  // "conflicting" only -- the historically stronger alternative. suggestedDebitId/CreditId may be
  // HOUSEHOLD_FAMILY_ID (a synthetic sentinel, not a real account id -- see narration-match.ts)
  // when the winning alternative is the shared "House Hold Exps" family; callers should render
  // that case as a generic label rather than resolving it to one specific month's account.
  suggestedDebitId?: number;
  suggestedCreditId?: number;
  suggestedVotes?: number;
};

const MIN_CONFLICT_VOTES = 2;

type AuditRecord = {
  guid: string;
  tokens: string[];
  debitId: number; // normalized (household-family-collapsed), for vote-pooling only
  creditId: number;
  isReceipt: boolean;
  debitIsFinancial: boolean;
};

export function auditNarrationCategorization(ledger: Ledger): CategorizationFlag[] {
  const acctById = new Map(ledger.accounts.map((a) => [a.id, a]));
  const normalize = (id: number): number => {
    const a = acctById.get(id);
    return a && /^house hold exps/i.test(a.name) ? HOUSEHOLD_FAMILY_ID : id;
  };

  // One pass to build the full evidence pool (every posted voucher, tokenised), reused for every
  // voucher's own self-excluded lookup below -- rebuilding this per-voucher would be the same
  // O(n) work repeated n times for no reason.
  const records: AuditRecord[] = [];
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled) continue;
    const debitE = v.entries.find((e) => e.amount < 0);
    const creditE = v.entries.find((e) => e.amount > 0);
    if (!debitE || !creditE) continue;
    const tokens = tokenise(v.narration || "");
    if (!tokens.length) continue;
    const debitAcct = acctById.get(debitE.accountId);
    records.push({
      guid: v.guid,
      tokens,
      debitId: normalize(debitE.accountId),
      creditId: normalize(creditE.accountId),
      isReceipt: v.type === "Receipt",
      debitIsFinancial: !!debitAcct && (isCcAcct(debitAcct) || isBankAcct(debitAcct)),
    });
  }

  const flags: CategorizationFlag[] = [];
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled || !v.plaidTxId) continue;
    const debitE = v.entries.find((e) => e.amount < 0);
    const creditE = v.entries.find((e) => e.amount > 0);
    if (!debitE || !creditE) continue;
    const debitAcct = acctById.get(debitE.accountId);
    if (debitAcct && (isCcAcct(debitAcct) || isBankAcct(debitAcct))) continue; // transfers/card payoffs, not a category decision
    const merchantTokens = tokenise(v.narration || "");
    if (!merchantTokens.length) continue;

    const ownKey = `${normalize(debitE.accountId)}:${normalize(creditE.accountId)}`;
    const txIsReceipt = v.type === "Receipt";

    // weight mirrors matchFromHistory's own same-direction-preferred scoring (used only to rank
    // which alternative "wins"); count is the plain number of distinct corroborating VOUCHERS,
    // which is what both the "thin" and "conflicting" thresholds below actually gate on -- a
    // single matching voucher always counts as 1 voucher regardless of its direction weight, so
    // "exactly one other voucher supports this" means count === 1, not weight === 1.
    const pairStats = new Map<string, { weight: number; count: number }>();
    for (const r of records) {
      if (r.guid === v.guid) continue; // exclude self -- this is the whole point
      if (r.debitIsFinancial) continue;
      const tokenSet = new Set(r.tokens);
      if (!merchantTokens.some((t) => tokenSet.has(t))) continue;
      const weight = r.isReceipt === txIsReceipt ? 2 : 1;
      const key = `${r.debitId}:${r.creditId}`;
      const s = pairStats.get(key) ?? { weight: 0, count: 0 };
      s.weight += weight;
      s.count += 1;
      pairStats.set(key, s);
    }

    if (!pairStats.size) continue; // zero corroboration either way -- could just be a genuinely new category, not flagged

    const own = pairStats.get(ownKey);
    const ownVotes = own?.count ?? 0;
    let bestAltKey = "";
    let bestAltWeight = 0;
    let bestAltVotes = 0;
    pairStats.forEach((s, key) => {
      if (key !== ownKey && s.weight > bestAltWeight) { bestAltWeight = s.weight; bestAltVotes = s.count; bestAltKey = key; }
    });

    let kind: CategorizationFlagKind | null = null;
    let suggestedDebitId: number | undefined;
    let suggestedCreditId: number | undefined;
    let suggestedVotes: number | undefined;

    if (bestAltKey && bestAltVotes >= MIN_CONFLICT_VOTES && bestAltWeight > (own?.weight ?? 0)) {
      kind = "conflicting";
      const [d, c] = bestAltKey.split(":");
      suggestedDebitId = +d;
      suggestedCreditId = +c;
      suggestedVotes = bestAltVotes;
    } else if (pairStats.size === 1 && ownVotes === 1) {
      kind = "thin";
    }

    if (!kind) continue;
    flags.push({
      guid: v.guid,
      date: v.date,
      voucherType: v.type,
      voucherNumber: v.number,
      narration: v.narration || "",
      debitId: debitE.accountId,
      creditId: creditE.accountId,
      kind,
      ownVotes,
      suggestedDebitId,
      suggestedCreditId,
      suggestedVotes,
    });
  }

  return flags.sort((a, b) => b.date.localeCompare(a.date));
}
