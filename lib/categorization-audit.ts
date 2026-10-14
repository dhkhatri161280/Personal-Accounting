import type { Ledger } from "./vault-types.ts";
import { tokenise, HOUSEHOLD_FAMILY_ID } from "./narration-match.ts";
import { isCcAcct, isBankAcct } from "./plaid-classify.ts";

// Retrospective sibling of PlaidImport.tsx's own matchFromHistory() -- instead of matching a NEW
// transaction against the ledger's history, this re-runs the same merchant-token-vote logic
// against every ALREADY-POSTED voucher with itself excluded from its own evidence, to find
// vouchers whose current EXPENSE LEDGER assignment rests on weak or contradicted evidence.
//
// This exists because a real, confirmed bug in matchFromHistory's live auto-categorization
// (a single coincidental shared word with exactly one unrelated prior voucher, trusted
// immediately when no competing pair exists -- see matchFromHistory's own "minVotes" comment)
// posted two restaurant/delivery charges ("DECCAN MORSEL FREMONT", "Shopping @ DoorDash") onto a
// Vehicle Maintenance ledger. Re-deriving the SAME vote purely by checking "does this voucher's
// own pair still win?" can't catch that exact case -- the one coincidental vote that caused the
// mistake is still the only evidence either way once you exclude the voucher itself. Two
// different signals are needed instead:
//   - "thin": the voucher's own ledger is supported by exactly ONE other voucher ledger-wide,
//     with NO competing alternative either -- i.e. the live decision (if it used
//     matchFromHistory's exact minVotes=1-when-uncontested loophole) rested on a single word
//     shared with a single other voucher. Flagged for review regardless of whether a better
//     alternative is computable, since there isn't enough evidence to compute one.
//   - "conflicting": a DIFFERENT debit ledger has more supporting evidence, from 2+ other
//     vouchers, than the voucher's own currently-posted ledger. This is the directly actionable
//     case -- a concrete suggested fix is available.
// Scoped to vouchers with a Plaid origin (plaidTxId set) only: this audits the auto-categorization
// pipeline's own risk surface, not vouchers a person typed in and chose deliberately -- a manual
// entry sharing a coincidental word with something else isn't a categorization bug.
//
// Two things this deliberately does NOT do, both confirmed live against a real audit run:
//   - Compare the CREDIT (payment) side. Comparing the full (debit, credit) pair like
//     matchFromHistory does flagged dozens of already-correct "House Hold Exps" vouchers as
//     "wrong" purely because they were paid on a less-common card than the majority -- a real
//     difference, but not a miscategorization. The actual risk this audits is "wrong expense
//     ledger," which is a debit-side-only question.
//   - Weigh evidence by raw matching-VOUCHER count. A generic, multi-purpose word like "costco"
//     matches both grocery-run vouchers (House Hold Exps) and gas-station vouchers (Vehicle
//     Maintenance); since there are simply more grocery runs than gas purchases, counting
//     matching vouchers wrongly suggested moving a genuine "Gasoline @ Costco" charge to House
//     Hold Exps, purely because there were more "costco" grocery vouchers than gas ones. See
//     ledgerTokenWeight below: evidence is weighted per DISTINCT SHARED WORD, split across
//     whichever ledgers that word has meant historically -- a specific word like "gasoline"
//     (which has only ever meant Vehicle Maintenance) counts as real, undiluted evidence for that
//     ledger regardless of how many unrelated vouchers happen to also contain "costco".

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
  // How many OTHER vouchers (excluding this one) share a narration word with this one AND are
  // posted to the same ledger it's currently on -- a plain, human-readable count (NOT the
  // word-level score that actually decides `kind`/`suggestedDebitId` below).
  ownVotes: number;
  // "conflicting" only -- the historically stronger alternative ledger. May be HOUSEHOLD_FAMILY_ID
  // (a synthetic sentinel, not a real account id -- see narration-match.ts) when the winning
  // alternative is the shared "House Hold Exps" family; callers should render that case as a
  // generic label rather than resolving it to one specific month's account.
  suggestedDebitId?: number;
  suggestedVotes?: number;
};

const MIN_CONFLICT_VOTES = 2;

type AuditRecord = {
  guid: string;
  tokens: string[];
  debitId: number; // normalized (household-family-collapsed)
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
      isReceipt: v.type === "Receipt",
      debitIsFinancial: !!debitAcct && (isCcAcct(debitAcct) || isBankAcct(debitAcct)),
    });
  }

  // For every token, how many records of each (normalized) debit ledger used it -- tokenise()
  // already dedupes within one narration, so each record contributes at most 1 to any one
  // (token, ledger) cell. Built once, ledger-wide; a per-voucher self-exclusion is applied at
  // read time below (see ledgerWeightFor) rather than rebuilt per voucher.
  const tokenLedgerCounts = new Map<string, Map<number, number>>();
  for (const r of records) {
    if (r.debitIsFinancial) continue;
    for (const t of r.tokens) {
      const byLedger = tokenLedgerCounts.get(t) ?? new Map<number, number>();
      byLedger.set(r.debitId, (byLedger.get(r.debitId) ?? 0) + 1);
      tokenLedgerCounts.set(t, byLedger);
    }
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

    const ownDebitId = normalize(debitE.accountId);

    // Evidence voted PER DISTINCT SHARED TOKEN, not per matching historical voucher -- each
    // token this voucher shares with history contributes 1/(number of distinct ledgers that
    // token has ever meant) to EVERY ledger it's associated with (this voucher's own prior
    // contribution to its own ledger excluded, so a word used only by this one voucher so far
    // isn't self-confirming evidence). A word that's always meant one specific ledger (e.g.
    // "gasoline") casts a full, undiluted vote for it; a word split across several ledgers (e.g.
    // "costco") casts a fraction of a vote to each, however many times it happens to recur.
    const ledgerWeight = new Map<number, number>();
    for (const t of merchantTokens) {
      const byLedger = tokenLedgerCounts.get(t);
      if (!byLedger) continue;
      const adjusted: [number, number][] = [];
      byLedger.forEach((count, ledgerId) => {
        const n = ledgerId === ownDebitId ? count - 1 : count;
        if (n > 0) adjusted.push([ledgerId, n]);
      });
      if (!adjusted.length) continue;
      const specificity = 1 / adjusted.length;
      for (const [ledgerId] of adjusted) {
        ledgerWeight.set(ledgerId, (ledgerWeight.get(ledgerId) ?? 0) + specificity);
      }
    }
    if (!ledgerWeight.size) continue; // zero corroboration either way -- could just be a genuinely new category, not flagged

    // Plain, human-readable corroborating-voucher counts -- NOT what decides
    // kind/suggestedDebitId above (that's ledgerWeight, computed per shared token).
    const ledgerVoteCount = new Map<number, number>();
    for (const r of records) {
      if (r.guid === v.guid || r.debitIsFinancial) continue;
      if (!merchantTokens.some((t) => r.tokens.includes(t))) continue;
      ledgerVoteCount.set(r.debitId, (ledgerVoteCount.get(r.debitId) ?? 0) + 1);
    }

    const ownWeight = ledgerWeight.get(ownDebitId) ?? 0;
    const ownVotes = ledgerVoteCount.get(ownDebitId) ?? 0;
    let bestAltId: number | null = null;
    let bestAltWeight = 0;
    ledgerWeight.forEach((w, id) => {
      if (id !== ownDebitId && w > bestAltWeight) { bestAltWeight = w; bestAltId = id; }
    });
    const bestAltVotes = bestAltId !== null ? (ledgerVoteCount.get(bestAltId) ?? 0) : 0;

    let kind: CategorizationFlagKind | null = null;
    let suggestedDebitId: number | undefined;
    let suggestedVotes: number | undefined;

    if (bestAltId !== null && bestAltVotes >= MIN_CONFLICT_VOTES && bestAltWeight > ownWeight) {
      kind = "conflicting";
      suggestedDebitId = bestAltId;
      suggestedVotes = bestAltVotes;
    } else if (ledgerWeight.size === 1 && ownVotes === 1) {
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
      suggestedVotes,
    });
  }

  return flags.sort((a, b) => b.date.localeCompare(a.date));
}
