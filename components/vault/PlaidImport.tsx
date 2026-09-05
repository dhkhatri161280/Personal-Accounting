"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";
import type { Ledger, Tx, Account } from "@/lib/vault-types";
import { nextVoucherNumber, nextTransactionIds } from "@/lib/vault-accounting";
import { matchPayrollPeriod, rowValue } from "@/lib/payroll-match";
import { fmtDate } from "@/lib/format-date";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlaidTxRaw {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name?: string;
  amount: number; // Plaid: positive = money OUT, negative = money IN (deposit)
  account_id: string;
  institution_name: string;
  pending?: boolean;
  personal_finance_category?: { primary: string; detailed: string };
}

// Plaid's /investments/transactions/get -- fetched every time for investment-type connections
// (see app/api/plaid/transactions/route.ts), used to tell "settled per Plaid" from "only in the
// vault so far" for accounts like HSA where Plaid has no pending-transaction concept at all.
interface PlaidInvestmentTx {
  investment_transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  amount: number; // Plaid: positive = money OUT (withdrawal/buy), negative = money IN
  institution_name: string;
}

interface PlaidAccount {
  account_id: string;
  type: string;     // "credit" | "depository" | "investment" | "loan" | "other"
  subtype: string;  // "credit card" | "checking" | "savings" | etc.
  name: string;
  mask?: string;    // last 4 digits of the account number, e.g. "3096"
  institution_name?: string; // enriched client-side from transaction data
  balances: {
    current: number | null;
    available: number | null;
    limit?: number | null;
  };
  // Investment-type accounts only: the trading day these holdings were priced as of (mutual
  // funds/401k price once per day, well after market close -- this is normal, not staleness).
  // See app/api/plaid/transactions/route.ts.
  pricingAsOf?: string;
}

interface Connection {
  item_id: string;
  institution_name: string;
  institution_id: string;
  connected_at: string;
  // Cached once per connection (see app/api/plaid/transactions/route.ts) -- lets the default
  // bank selection below exclude investment accounts without an extra live Plaid call just to
  // find out which connections have them.
  hasInvestmentAccount?: boolean;
}

interface EntryDraft {
  accountId: number;
  accountName: string;
  amount: number; // vault convention: negative = debit, positive = credit
}

interface ImportRow {
  plaidTx: PlaidTxRaw;
  skip: boolean;
  alreadyImported: boolean;
  voucherType: string;
  narration: string;
  entries: EntryDraft[];
  confidence: number; // 0–1, 1 = high confidence (payroll template), < 0.5 = needs review
  source?: "payroll" | "history" | "household" | "none" | "duplicate";
  // Set when a save attempt was blocked by the vault-duplicate guardrail so the user can
  // review and explicitly confirm it's actually a separate transaction, not a re-save.
  dupBlocked?: boolean;
  // User confirmed this is NOT a duplicate despite matching the guardrail — bypass it on retry.
  forceSave?: boolean;
}

interface ConfirmedMatch {
  id: string;
  merchant_key: string;
  amount: number;
  vault_voucher_id: number;
  vault_narration: string;
  debit_account_id: number;
  credit_account_id: number;
  confirmed_tx_ids: string[];
  confirmed_at: string;
}

interface Props {
  data: Ledger;
  apiUrl: string;
  onSave: (next: Ledger) => Promise<boolean>;
}

function fmtMoney(n: number): string {
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}

// ── Payroll template constants ─────────────────────────────────────────────────

const PAYROLL_PATTERNS = [/nvidia/i, /nviida/i, /adp.*payroll/i, /payroll.*nvidia/i];

// Fallback figures, taken from the most recent known real paystub (pay date 08/14/2026).
// Only used when the Excel-imported payroll data (Tax tab) has no real numbers for this
// specific pay period yet -- these WILL drift as pay rate / benefit elections change, so
// any voucher built from this fallback keeps confidence < 1 and still needs a human look
// (see the "auto" badge) rather than being trusted blindly.
const PAYROLL_BASE = 10_166.67; // Salary line only (not Gross -- Telephone is separate below)
const PAYROLL_TELEPHONE = 30.00; // Wireless Device reimbursement
const PAYROLL_TAX = 2_062.49; // Federal + Medicare + Social Security + CA State, combined
const PAYROLL_MEDICAL = 184.50; // Medical + Dental + Vision, combined (Legal Plan is its own line below)
const PAYROLL_401K = 813.33;
const PAYROLL_LEGAL = 9.00;

// NVIDIA's direct deposit always splits a fixed amount into a second account (e.g. $1,500 +
// $500 into two Chase sub-accounts, tracked here as one combined "Chase Bank" line) -- only
// the primary (Plaid-linked) account shows up as its own pending transaction, so this second
// leg has to be added to the draft manually since there's no separate feed for it. If the
// split amount or destination ever changes, update these two constants.
const PAYROLL_SECONDARY_BANK = "Chase Bank";
const PAYROLL_SECONDARY_AMOUNT = 2_000.00;

function isPayroll(tx: PlaidTxRaw) {
  if (tx.amount >= 0) return false; // must be a deposit (money in)
  const desc = `${tx.name} ${tx.merchant_name || ""}`;
  return PAYROLL_PATTERNS.some((p) => p.test(desc));
}

// ── Account finder helpers ─────────────────────────────────────────────────────

function findAcct(accounts: Account[], ...names: string[]): Account | undefined {
  // Two passes: try an EXACT match for every candidate name first (in priority order), and
  // only fall back to substring matching if none of them hit. Previously this checked exact
  // *and* substring for name[0] before ever trying name[1]'s exact match -- so a later, more
  // specific candidate's exact match could lose to an earlier candidate's accidental substring
  // match against an unrelated account (e.g. a short generic alias like "BofA" substring-matching
  // whichever of two real BofA accounts happens to sit first, non-deterministically).
  for (const name of names) {
    const exact = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  for (const name of names) {
    const lc = name.toLowerCase();
    const partial = accounts.find((a) => a.name.toLowerCase().includes(lc));
    if (partial) return partial;
  }
}

// ── House Hold Exps monthly account helpers ───────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function houseHoldMonthName(date: string): string {
  const [year, month] = date.split("-");
  const mon = MONTH_ABBR[parseInt(month, 10) - 1] || "Jan";
  return `House Hold Exps - ${mon} ${year.slice(-2)}`;
}

function findHouseHoldTemplate(accounts: Account[]): Account | undefined {
  return accounts.find((a) => /^house hold exps/i.test(a.name));
}

// Pre-compute new accounts needed for unmatched expenses (so all same-month txs share one ID)
function computeNewAccounts(
  txs: PlaidTxRaw[],
  ledger: Ledger,
  historyIndex: HistoryIndex
): Record<string, Account> {
  const accounts = ledger.accounts.filter((a) => a.active !== false);
  const template = findHouseHoldTemplate(accounts);
  if (!template) return {};

  const result: Record<string, Account> = {};
  let nextId = Math.max(...ledger.accounts.map((a) => a.id), 0) + 1;

  for (const tx of txs) {
    if (tx.amount <= 0) continue; // only expenses (money out)
    if (isPayroll(tx)) continue;
    const histMatch = matchFromHistory(tx, historyIndex);
    if (histMatch && histMatch.confidence >= 0.2) {
      // Exception: if history matched a HouseHold account from a PAST month,
      // we still need to create THIS month's account so the guard can substitute it.
      const matchedDebit = accounts.find((a) => a.id === histMatch.debitId);
      if (!matchedDebit || !/^house hold exps/i.test(matchedDebit.name)) continue;
    }
    const name = houseHoldMonthName(tx.date);
    const exists = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!exists && !result[name]) {
      result[name] = { ...template, id: nextId++, name };
    }
  }
  return result;
}

// ── GL suggestion from vault history (frequency-based per merchant) ───────────
// Each HistoryRecord stores the exact tokens from one historical narration plus
// the account IDs that were used. matchFromHistory counts how many past transactions
// agree on each (debit, credit) pair for this merchant and returns the majority.

type HistoryRecord = {
  tokens: string[];
  debitId: number;
  creditId: number;
  isReceipt: boolean; // true = Tally "Receipt" (money IN); false = "Payment" (money OUT)
};
type HistoryIndex = HistoryRecord[];

// Generic finance/transaction vocabulary -- words that show up across many unrelated merchants'
// narrations (a recurring "Citi Credit Card Payment" voucher, a card-tier name, etc.) and would
// otherwise dominate the vote count in matchFromHistory purely by being common, drowning out the
// one word that actually identifies the merchant (e.g. "lululemon" in "Platinum Lululemon Credit"
// lost to "credit" matching dozens of unrelated Citi bill-payment vouchers). Excluded from BOTH
// the current transaction's tokens and historical narrations so neither side can match on noise.
const GENERIC_FINANCE_WORDS = new Set([
  "credit", "debit", "payment", "pay", "card", "charge", "purchase", "platinum", "gold",
  "signature", "rewards", "reward", "points", "point", "statement", "adjustment", "adj",
  "thank", "you", "auto", "autopay", "online", "mobile", "web", "des", "ach", "pmt", "ppd",
  // Bank/institution-name boilerplate that shows up inside Plaid's own transaction description
  // template (e.g. "ACH CREDIT Bank of America CASHREWARD...") -- these identify who's reporting
  // the transaction, not what it's for, so they must not be treated as a merchant-matching signal.
  "bank", "america", "banking", "national",
]);

function tokenise(text: string): string[] {
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
// houseHoldMonthName), so 4 real Lululemon vouchers across 4 different months look like 4
// entirely different, unrelated debit accounts to matchFromHistory -- splitting what should be
// one strong, repeated signal into 4 single-vote candidates that never clear any confidence bar.
// Normalizing every household-month account to one shared sentinel id during indexing lets them
// all vote together; HOUSEHOLD_FAMILY_ID is substituted back to the CURRENT transaction's own
// month at every call site that reads a matched id (see the 3 substitution points below).
const HOUSEHOLD_FAMILY_ID = -1;

function buildHistoryIndex(ledger: Ledger): HistoryIndex {
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
      index.push({ tokens, debitId: normalize(debitE.accountId), creditId: normalize(creditE.accountId), isReceipt: v.type === "Receipt" });
    }
  }
  return index;
}

function matchFromHistory(
  tx: PlaidTxRaw,
  index: HistoryIndex
): { debitId: number; creditId: number; confidence: number; fromPaymentHistory: boolean } | null {
  const merchantTokens = tokenise(tx.merchant_name || tx.name || "");
  if (!merchantTokens.length) return null;

  const txIsReceipt = tx.amount < 0; // Plaid: negative = money IN → maps to Receipt

  const pairCounts = new Map<string, number>();
  const pairPaymentVotes = new Map<string, number>();

  for (const { tokens, debitId, creditId, isReceipt } of index) {
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
  };
}

// For purchases with no strong merchant match, find the most common expense account
// that has been paired with a specific card in payment history — card-based default.
function cardDefaultExpense(cardAccId: number, index: HistoryIndex): number | null {
  const counts = new Map<number, number>();
  for (const { debitId, creditId, isReceipt } of index) {
    if (creditId !== cardAccId || isReceipt) continue;
    counts.set(debitId, (counts.get(debitId) || 0) + 1);
  }
  let bestId = 0, bestCount = 0;
  counts.forEach((c, id) => { if (c > bestCount) { bestCount = c; bestId = id; } });
  return bestId || null;
}

// ── Account-type helpers ──────────────────────────────────────────────────────

function isCcAcct(a: { name: string; parent?: string }): boolean {
  // Must literally say "credit card" in the account name — avoids false matches on
  // "credit union", "income credit", etc.
  return /credit card/i.test(a.name);
}

function isBankAcct(a: { name: string; parent?: string }): boolean {
  const n = a.name.toLowerCase();
  // Match known bank/depository account patterns; explicitly exclude expense/income names
  if (/exps?|expense|income|revenue|wages|salary|rent|fee|charge|tax|insurance/i.test(n)) return false;
  return /bank of america|chase bank|wells fargo|citibank|citi bank|sbi|hdfc|icici|axis bank|kotak|checking|savings/i.test(n) ||
    /^bank\s/i.test(a.name) || /\sbank$/i.test(a.name);
}

// Returns true only when ALL entries in a transaction are bank or credit card accounts.
// This is the correct Contra definition: funds transfer between Bank↔Bank or Bank↔CreditCard.
// Any entry with an expense/income account disqualifies the transaction.
// Override voucherType to "Contra" when ALL draft entries are bank/CC accounts.
//
// A card-payment Contra promoted here (as opposed to one built by a dedicated branch like the
// BofA-branded "PAYMENT TO ACCT #..." case above, which already sets its own clean narration)
// otherwise keeps whatever raw text the bank/Plaid reported for the underlying transaction --
// confirmed directly to sometimes be a genuinely unhelpful bill-pay template fragment like
// "Ch. No. :" (a check-number field left blank because the payment was electronic, not by
// check). Rather than special-casing each issuer's own raw-text quirks one at a time, this
// uniformly relabels ANY newly-promoted bank<->card Contra as "{Card} Payment" whenever the
// existing narration doesn't already read like a real payment description -- so every card
// issuer gets the same clean treatment BofA's own branded case already gets, not just BofA.
function enforceContraType<T extends { voucherType: string; narration: string; entries: { accountId: number; accountName: string }[] }>(
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

// A pending negative-amount (money-in) transaction that is actually a card bill payment,
// not a merchant refund/credit — payments are already reflected in both Plaid's current
// balance and the vault, so they must not be double-counted as an "uncleared credit".
function isCardPayment(tx: PlaidTxRaw): boolean {
  const cat = (tx.personal_finance_category?.primary || "").toLowerCase();
  const detailed = (tx.personal_finance_category?.detailed || "").toLowerCase();
  if (cat.includes("loan_payments") || detailed.includes("payment")) return true;
  return /payment/i.test(tx.name);
}

// BofA "Pay & Transfer" reports one card payment as two rows: a "PAYMENT TO ACCT #..." debit
// (built into a Contra voucher above) and a "PENDING PAYMENT" credit that mirrors the exact same
// transfer, not a second real transaction. Force that mirror row to start pre-skipped.
function isBofaPaymentDuplicate(tx: { institution_name?: string; name: string }): boolean {
  return /bank of america|bofa/i.test(tx.institution_name || "") && /^pending payment$/i.test(tx.name.trim());
}

// General version of the BofA case above, for any pair of institutions that both independently
// report the same card-payment transfer (e.g. BofA's "AUTOPAY..." debit + Amex's own "MOBILE
// PAYMENT..." credit for the identical $ amount) -- these resolve to the identical Contra
// voucher (same account pair, same amount, same day) from two different banks' feeds, and
// without this check both stay selectable/importable, letting the user accidentally double-post
// one real transfer as two vouchers. Mirrors vaultHasDuplicate's matching exactly (same account
// pair, amount within a few cents, dates within 3 days) so "duplicate" means the same thing at
// staging time as it does at save time. Checks against BOTH other rows in this same batch AND
// transactions already saved to the vault -- the other side of a transfer often shows up in a
// LATER fetch (e.g. the debit posts and gets saved today, the mirroring credit only appears as
// pending a day or two later), so same-batch-only comparison misses that case entirely.
function flagCrossFeedDuplicates(draftRows: ImportRow[], existingVaultTxs: Tx[]): void {
  const seen: { drId: number; crId: number; amt: number; ms: number }[] = [];
  for (const v of existingVaultTxs) {
    if (v.deleted || v.cancelled) continue;
    const vDr = v.entries.find((e) => e.amount < 0);
    const vCr = v.entries.find((e) => e.amount > 0);
    if (!vDr || !vCr) continue;
    seen.push({
      drId: vDr.accountId,
      crId: vCr.accountId,
      amt: Math.abs(vDr.amount),
      ms: new Date(v.date + "T12:00:00Z").getTime(),
    });
  }
  for (const row of draftRows) {
    if (row.skip) continue;
    const dr = row.entries.find((e) => e.amount < 0);
    const cr = row.entries.find((e) => e.amount > 0);
    if (!dr || !cr) continue;
    const amt = Math.abs(dr.amount);
    const ms = new Date(row.plaidTx.date + "T12:00:00Z").getTime();
    const match = seen.find(
      (s) =>
        s.drId === dr.accountId &&
        s.crId === cr.accountId &&
        Math.abs(s.amt - amt) < 0.05 &&
        Math.abs(s.ms - ms) / 86400000 <= 3
    );
    if (match) {
      row.skip = true;
      row.narration = `Duplicate — matches an already-recorded or already-pending transfer (${row.narration})`;
    } else {
      seen.push({ drId: dr.accountId, crId: cr.accountId, amt, ms });
    }
  }
}

// ── Build draft entries for a Plaid transaction ────────────────────────────────

function buildDraft(
  tx: PlaidTxRaw,
  ledger: Ledger,
  newAcctsByName: Record<string, Account>,
  historyIndex: HistoryIndex,
  plaidAcctMap: Map<string, PlaidAccount>
): Pick<ImportRow, "entries" | "voucherType" | "narration" | "confidence" | "source"> {
  const accounts = ledger.accounts.filter((a) => a.active !== false);
  // Combined lookup: existing vault accounts + pending new ones
  const allAccounts = [
    ...accounts,
    ...Object.values(newAcctsByName).filter(
      (na) => !accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase())
    ),
  ];
  const netDeposit = Math.abs(tx.amount); // always positive for arithmetic

  // ── NVIDIA payroll template ──
  if (isPayroll(tx)) {
    const salaryAcc = findAcct(accounts, "Salary Income - Nvidia", "Salary Income");
    const telAcc = findAcct(accounts, "Telephone Exps", "Telephone Expenses", "Telephone");
    const taxAcc = findAcct(accounts, "Tax Deduction", "Tax");
    const medAcc = findAcct(accounts, "Health Insurance", "Medical");
    const k401Acc = findAcct(accounts, "401K Investments", "401k");
    const legalAcc = findAcct(accounts, "Legal Plan - Nvidia", "Legal Plan");
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America");
    const secondaryBankAcc = findAcct(accounts, PAYROLL_SECONDARY_BANK);

    if (salaryAcc && taxAcc && medAcc && k401Acc && bankAcc) {
      // Prefer the actual imported paystub numbers (Reports → Tax) for this pay period over
      // the hardcoded fallback constants -- but only when that period actually has real
      // (non-zero) data. A period row that exists but hasn't been filled in yet (e.g. the
      // books have run ahead of the last Excel import) must not silently zero everything out.
      const match = matchPayrollPeriod(ledger.payroll, tx.date);
      let base = PAYROLL_BASE, telephone = PAYROLL_TELEPHONE, medical = PAYROLL_MEDICAL,
        k401 = PAYROLL_401K, tax = PAYROLL_TAX, matched = false, haveRealTax = false;
      if (match) {
        const y = ledger.payroll!.years[match.yearIdx];
        const mBase = rowValue(y, "Base", match.periodIndex) + rowValue(y, "Bonus", match.periodIndex);
        if (mBase > 0) {
          base = mBase;
          telephone = rowValue(y, "Telephone", match.periodIndex);
          medical = rowValue(y, "Medical", match.periodIndex);
          k401 = rowValue(y, "401K", match.periodIndex);
          const mTax = rowValue(y, "Total Tax", match.periodIndex);
          if (mTax > 0) { tax = mTax; haveRealTax = true; }
          matched = true;
        }
      }
      const legal = PAYROLL_LEGAL;
      const secondaryAmount = secondaryBankAcc ? PAYROLL_SECONDARY_AMOUNT : 0;
      // Without a real imported tax figure, solve for whatever balances the FULL paycheck
      // (both destination accounts combined) -- not just this one bank line, which would
      // silently misattribute the other account's share to "tax" once a paycheck splits
      // across two accounts.
      if (!haveRealTax) {
        tax = Math.max(0, base + telephone - medical - k401 - legal - netDeposit - secondaryAmount);
      }
      const entries: EntryDraft[] = [
        { accountId: salaryAcc.id, accountName: salaryAcc.name, amount: base },
        ...(telAcc ? [{ accountId: telAcc.id, accountName: telAcc.name, amount: telephone }] : []),
        { accountId: taxAcc.id, accountName: taxAcc.name, amount: -tax },
        { accountId: medAcc.id, accountName: medAcc.name, amount: -medical },
        { accountId: k401Acc.id, accountName: k401Acc.name, amount: -k401 },
        ...(legalAcc ? [{ accountId: legalAcc.id, accountName: legalAcc.name, amount: -legal }] : []),
        { accountId: bankAcc.id, accountName: bankAcc.name, amount: -netDeposit },
        ...(secondaryBankAcc ? [{ accountId: secondaryBankAcc.id, accountName: secondaryBankAcc.name, amount: -secondaryAmount }] : []),
      ];
      return { entries, voucherType: "Receipt", narration: "Salary Income - Semi Monthly", confidence: matched ? 0.98 : 0.9, source: "payroll" };
    }
  }

  // ── Merchant-specific rules ────────────────────────────────────────────────
  // Derive short aliases from the institution name so "Credit Card - BofA"
  // is found for a "Bank of America" transaction, etc.
  const instLower = (tx.institution_name || "").toLowerCase();
  const plaidAcct = plaidAcctMap.get(tx.account_id);
  const isCreditAcct = plaidAcct?.type === "credit";
  // NOTE: do NOT put tx.institution_name first for BofA — "Bank of America" exactly matches
  // the checking account "Bank Of America" and would always win before "Credit Card - BofA".
  const instAliases: string[] = [];
  if (/bank.of.america|bofa/i.test(instLower)) {
    if (isCreditAcct) {
      // Two physical BofA cards, two GL accounts -- Plaid's account nickname is the one
      // stable signal that tells them apart (see BOFA_CARD_GL_BY_NAME above institution
      // name/type alone can't, since both are "BofA credit").
      const specific = bofaCardGlAccountName(plaidAcct?.name || "");
      if (specific) instAliases.push(specific);
      instAliases.push("Credit Card - BofA", "BofA", "Bank Of America", "Bank of America");
    }
    else
      instAliases.push(tx.institution_name, "BofA", "Bank Of America", "Bank of America", "Credit Card - BofA");
  }
  else if (/chase/i.test(instLower))
    instAliases.push("Chase Credit Card", "Chase Bank", "Chase");
  else if (/citi(?!zen)/i.test(instLower))
    instAliases.push("Citi Credit Card", "Citibank", "Citi");
  else if (/american express|amex/i.test(instLower))
    instAliases.push("AMEX Credit Card", "American Express", "Amex");
  // Fallback candidates only reached if institution aliases all failed
  const fallbackCardNames = ["Citi Credit Card", "Citibank", "Citi", "Bank Of America", "Bank of America", "Chase"];
  const cardAcc = findAcct(accounts, ...instAliases, ...fallbackCardNames);

  // Returns true when an account name plausibly belongs to the given institution
  function accountMatchesInstitution(accountName: string, institution: string): boolean {
    const a = accountName.toLowerCase();
    const inst = institution.toLowerCase();
    if (/bank.of.america|bofa/i.test(inst)) return /bank.of.america|bofa/i.test(a);
    if (/chase/i.test(inst)) return /chase/i.test(a);
    if (/citi(?!zen)/i.test(inst)) return /citi(?!zen)/i.test(a);
    if (/american express|amex/i.test(inst)) return /american express|amex/i.test(a);
    if (/wells.fargo/i.test(inst)) return /wells.fargo/i.test(a);
    // Generic: any word > 3 chars from institution appears in account name
    return inst.split(/\W+/).filter((w) => w.length > 3).some((w) => a.includes(w));
  }

  // BofA online banking "Pay & Transfer": paying a BofA-issued credit card bill from BofA checking.
  // Plaid names the checking-side debit "PAYMENT TO ACCT #1234 ON MM/DD VIA..." and separately
  // mirrors the exact same transfer as a "PENDING PAYMENT" credit — that second row is Plaid's
  // duplicate report of this one movement, not a distinct transaction (force-skipped below, and at
  // the row-build call site so it can never be double-saved). Build one Contra voucher from the debit leg.
  if (/bank of america|bofa/i.test(instLower) && /payment to acct\s*#?\s*\d+/i.test(tx.name)) {
    // This transaction is on the CHECKING side of the payment -- tx.account_id is the bank
    // account, not the card being paid, so the per-card learned mapping (keyed by the card's
    // own Plaid account_id) can't be consulted here. But Plaid embeds the last 4 digits of the
    // card being paid right in the transaction text ("PAYMENT TO ACCT #3096..."), and Plaid's
    // own account objects carry that same digit string as `.mask` -- matching the two resolves
    // which physical card this is deterministically, no guessing needed.
    const last4 = tx.name.match(/#\s*(\d{4})\b/)?.[1];
    const matchedCardAcct = last4
      ? [...plaidAcctMap.values()].find((a) => a.mask === last4)
      : undefined;
    const specific = matchedCardAcct ? bofaCardGlAccountName(matchedCardAcct.name) : undefined;
    const cardAcc = specific
      ? findAcct(accounts, specific)
      : findAcct(accounts, "Credit Card - BofA", "BofA Credit Card");
    const bankAcc = findAcct(accounts, "Bank Of America", "Bank of America", tx.institution_name);
    const multipleBofaCards = accounts.filter(
      (a) => a.active !== false && /^credit card - bofa/i.test(a.name)
    ).length > 1;
    if (cardAcc && bankAcc) {
      return {
        entries: [
          { accountId: cardAcc.id, accountName: cardAcc.name, amount: -netDeposit },
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: netDeposit },
        ],
        voucherType: "Contra",
        narration: specific
          ? "BofA Credit Card Payment"
          : multipleBofaCards
            ? `BofA Credit Card Payment — verify which card (${tx.name})`
            : "BofA Credit Card Payment",
        confidence: specific ? 0.9 : multipleBofaCards ? 0.4 : 0.85,
        source: "history",
      };
    }
  }
  if (/bank of america|bofa/i.test(instLower) && /^pending payment$/i.test(tx.name.trim())) {
    return {
      entries: [],
      voucherType: "Payment",
      narration: "Duplicate — Plaid double-reports the BofA card payment above",
      confidence: 0,
      source: "duplicate",
    };
  }

  // American Express ACH payment: paying AmEx credit card bill from a bank account
  // Plaid name format: "AMERICAN EXPRESS DES:ACH PMT ID:..." from BofA/Chase checking
  if (/american express.*(pmt|payment|ach)|amex.*(pmt|payment)/i.test(tx.name)) {
    const amexAcc = findAcct(accounts, "American Express", "Amex", "AMEX");
    // Source is the bank/checking account — match this institution first so BofA never picks Chase
    const bankAcc = findAcct(
      accounts,
      tx.institution_name,
      "Bank Of America", "Bank of America",
      "Chase Bank", "Chase",
      "Checking", "Savings"
    );
    const pastNarr = (() => {
      const hits = ledger.transactions
        .filter((v) => !v.deleted && !v.cancelled &&
          /american express.*(pmt|payment)|amex.*(pmt|payment)/i.test(v.narration || ""))
        .map((v) => v.narration || "");
      const counts = new Map<string, number>();
      for (const n of hits) counts.set(n, (counts.get(n) || 0) + 1);
      let best = "", bestC = 0;
      counts.forEach((c, n) => { if (c > bestC) { bestC = c; best = n; } });
      return best || "American Express CC Payment";
    })();
    if (amexAcc && bankAcc) {
      return {
        entries: [
          { accountId: amexAcc.id, accountName: amexAcc.name, amount: -netDeposit },
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: netDeposit },
        ],
        voucherType: "Payment",
        narration: pastNarr,
        confidence: 0.85,
        source: "history",
      };
    }
  }

  // ── Citi card feed: money-IN transactions (payment received by Citi from user's bank) ──
  // "PAYMENT THANK YOU", "AUTOPAY PAYMENT", etc. — institution = "Citibank Online"
  if (/citi(?!zen)/i.test(instLower) && tx.amount < 0) {
    const citiAcc = findAcct(accounts, "Citi Credit Card", "Citibank", "Citi");
    if (/payment|autopay|thank you/i.test(tx.name)) {
      const bankAcc = findAcct(accounts, "Bank Of America", "Bank of America", "BofA", "Chase Bank", "Chase");
      // Look up the most common narration used in past Citi payment vouchers
      const pastNarr = (() => {
        const hits = ledger.transactions
          .filter((v) => !v.deleted && !v.cancelled &&
            v.entries.some((e) => e.accountId === citiAcc?.id && e.amount < 0))
          .map((v) => v.narration || "");
        const counts = new Map<string, number>();
        for (const n of hits) counts.set(n, (counts.get(n) || 0) + 1);
        let best = "", bestC = 0;
        counts.forEach((c, n) => { if (c > bestC) { bestC = c; best = n; } });
        return best || "Citi CC Payment";
      })();
      if (citiAcc && bankAcc) {
        return {
          entries: [
            { accountId: citiAcc.id, accountName: citiAcc.name, amount: -netDeposit },
            { accountId: bankAcc.id, accountName: bankAcc.name, amount: netDeposit },
          ],
          voucherType: "Payment",
          narration: pastNarr,
          confidence: 0.85,
          source: "history",
        };
      }
    }
  }

  // ── AMEX card feed: money-IN transactions (from American Express's own feed) ──
  // These are credits/payments as seen by the AMEX account — institution = "American Express"
  if (/american express|amex/i.test(instLower) && tx.amount < 0) {
    const amexAcc = findAcct(accounts, "AMEX Credit Card", "American Express", "Amex");

    // Mobile/online/auto payment — user paid AMEX bill from a bank account
    if (/mobile pay|online pay|autopay|e-pay|payment.*thank|thank.*pay|web pay/i.test(tx.name)) {
      const bankAcc = findAcct(accounts, "Bank Of America", "Bank of America", "BofA", "Chase Bank", "Chase");
      if (amexAcc && bankAcc) {
        return {
          entries: [
            { accountId: amexAcc.id, accountName: amexAcc.name, amount: -netDeposit },
            { accountId: bankAcc.id, accountName: bankAcc.name, amount: netDeposit },
          ],
          voucherType: "Payment",
          narration: "American Express CC Payment",
          confidence: 0.8,
          source: "history",
        };
      }
    }

    // Travel credit / points / rewards applied as statement credit
    if (/travel.*pay.*point|travel.*credit|point.*credit|reward.*credit|statement.*credit/i.test(tx.name)) {
      const travelAcc = findAcct(accounts, "Travel Exps", "Travel Expenses", "Travel", "Misc Income", "Other Income");
      if (amexAcc && travelAcc) {
        return {
          entries: [
            { accountId: amexAcc.id, accountName: amexAcc.name, amount: -netDeposit },
            { accountId: travelAcc.id, accountName: travelAcc.name, amount: netDeposit },
          ],
          voucherType: "Receipt",
          narration: tx.name,
          confidence: 0.75,
          source: "history",
        };
      }
    }

    // Generic AMEX credit/adjustment (ADJ REDIST, PURCHASE BAL, refunds, etc.)
    // At minimum put AMEX Credit Card on the debit side; find credit from history if possible
    if (amexAcc) {
      const adjMatch = matchFromHistory(tx, historyIndex);
      const histCrId = adjMatch
        ? (adjMatch.fromPaymentHistory ? adjMatch.debitId : adjMatch.creditId)
        : null;
      const crAcc = (histCrId === HOUSEHOLD_FAMILY_ID
          ? allAccounts.find((a) => a.name.toLowerCase() === houseHoldMonthName(tx.date).toLowerCase())
          : histCrId ? accounts.find((a) => a.id === histCrId) : null)
        || findAcct(accounts, "Misc Income", "Other Income");
      if (crAcc) {
        return {
          entries: [
            { accountId: amexAcc.id, accountName: amexAcc.name, amount: -netDeposit },
            { accountId: crAcc.id, accountName: crAcc.name, amount: netDeposit },
          ],
          voucherType: "Receipt",
          narration: tx.name,
          confidence: 0.4,
          source: "history",
        };
      }
    }
  }

  // Costco Gas: fuel purchases at Costco gas station
  // → Vehicle Maintenance (or Gasoline/Fuel), narration repeated from past vouchers
  if (/costco.*(gas|fuel)|gas.*costco/i.test(tx.name)) {
    const fuelAcc = findAcct(accounts, "Gasoline", "Fuel Exps", "Vehicle Maintenance", "Fuel", "Gas");
    if (fuelAcc && cardAcc) {
      const pastNarr = (() => {
        const hits = ledger.transactions
          .filter((v) => !v.deleted && !v.cancelled && /costco.*(gas|fuel)|gas.*costco/i.test(v.narration || ""))
          .map((v) => v.narration || "");
        const counts = new Map<string, number>();
        for (const n of hits) counts.set(n, (counts.get(n) || 0) + 1);
        let best = "Costco Gas", bestC = 0;
        counts.forEach((c, n) => { if (c > bestC) { bestC = c; best = n; } });
        return best;
      })();
      return {
        entries: [
          { accountId: fuelAcc.id, accountName: fuelAcc.name, amount: -netDeposit },
          { accountId: cardAcc.id, accountName: cardAcc.name, amount: netDeposit },
        ],
        voucherType: "Payment",
        narration: pastNarr,
        confidence: 0.85,
        source: "history",
      };
    }
  }

  // Costco WHSE: warehouse purchase or refund → House Hold Exps monthly account
  if (/costco/i.test(tx.merchant_name || tx.name)) {
    const hhName = houseHoldMonthName(tx.date);
    const hhAcct = allAccounts.find((a) => a.name.toLowerCase() === hhName.toLowerCase());
    if (hhAcct && cardAcc) {
      const isRefund = tx.amount < 0;
      return {
        entries: isRefund
          ? [
              { accountId: cardAcc.id, accountName: cardAcc.name, amount: -netDeposit },
              { accountId: hhAcct.id, accountName: hhAcct.name, amount: netDeposit },
            ]
          : [
              { accountId: hhAcct.id, accountName: hhAcct.name, amount: -netDeposit },
              { accountId: cardAcc.id, accountName: cardAcc.name, amount: netDeposit },
            ],
        voucherType: isRefund ? "Receipt" : "Payment",
        narration: "Shopping @ Costco",
        confidence: 0.8,
        source: "history",
      };
    }
  }

  // ── Pattern match from vault history ──
  const match = matchFromHistory(tx, historyIndex);
  if (match) {
    let finalDebitId = match.debitId;
    let finalCreditId = match.creditId;
    // For receipts (money IN) matched against payment history, reverse Dr/Cr:
    if (tx.amount < 0 && match.fromPaymentHistory) {
      finalDebitId = match.creditId;
      finalCreditId = match.debitId;
    }
    // Household month guard: history matched the normalized "House Hold Exps" family (see
    // HOUSEHOLD_FAMILY_ID) for a recurring merchant that's been expensed under several different
    // months' accounts — substitute the CURRENT tx's own month's account, not a lookup by the
    // (non-existent) sentinel id.
    const currentHH = () => allAccounts.find((a) => a.name.toLowerCase() === houseHoldMonthName(tx.date).toLowerCase());
    let debitAcc = finalDebitId === HOUSEHOLD_FAMILY_ID ? currentHH() : accounts.find((a) => a.id === finalDebitId);
    let creditAcc = finalCreditId === HOUSEHOLD_FAMILY_ID ? currentHH() : accounts.find((a) => a.id === finalCreditId);
    // Institution guard: for expense transactions the credit side must come from
    // the same institution as the Plaid transaction. If history suggested a card
    // from a different bank (e.g. Citi for a BofA charge), substitute cardAcc.
    if (tx.amount > 0 && creditAcc && cardAcc && creditAcc.id !== cardAcc.id) {
      if (!accountMatchesInstitution(creditAcc.name, tx.institution_name)) {
        creditAcc = cardAcc;
      }
    }
    // Same-institution, wrong-physical-card guard: matchFromHistory has no idea which of two
    // same-institution cards (e.g. DK's vs Hiral's BofA card) a transaction came from -- it
    // just picks whichever card historically won the most votes for that merchant, so the
    // institution guard above never catches it (both cards pass accountMatchesInstitution).
    // cardAcc was already resolved above specifically for THIS Plaid account (via
    // bofaCardGlAccountName); if history instead matched a different account from the same
    // shared-card family, that's always wrong for a card-identity purpose and gets corrected
    // here -- otherwise a charge on Hiral's card can silently post to DK's account (or vice
    // versa) whenever that merchant's history happens to be weighted toward the other card.
    const sameCardFamily = (a?: Account) => a && cardAcc && /^credit card - bofa/i.test(a.name) && /^credit card - bofa/i.test(cardAcc.name);
    if (creditAcc && cardAcc && creditAcc.id !== cardAcc.id && sameCardFamily(creditAcc)) creditAcc = cardAcc;
    if (debitAcc && cardAcc && debitAcc.id !== cardAcc.id && sameCardFamily(debitAcc)) debitAcc = cardAcc;
    if (debitAcc && creditAcc) {
      const amt = Math.abs(tx.amount);
      return {
        entries: [
          { accountId: debitAcc.id, accountName: debitAcc.name, amount: -amt },
          { accountId: creditAcc.id, accountName: creditAcc.name, amount: amt },
        ],
        voucherType: tx.amount < 0 ? "Receipt" : "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: match.confidence,
        source: "history",
      };
    }
  }

  // ── Card-based default: most common expense on this card (no merchant match) ──
  if (tx.amount > 0 && cardAcc) {
    const defaultDebitId = cardDefaultExpense(cardAcc.id, historyIndex);
    // Household month guard: card default picks the most frequent HouseHold month across
    // ALL history (via the normalized HOUSEHOLD_FAMILY_ID), but we must use the tx's own month.
    const defaultDebitAcc = defaultDebitId === HOUSEHOLD_FAMILY_ID
      ? allAccounts.find((a) => a.name.toLowerCase() === houseHoldMonthName(tx.date).toLowerCase())
      : defaultDebitId ? accounts.find((a) => a.id === defaultDebitId) : null;
    if (defaultDebitAcc) {
      return {
        entries: [
          { accountId: defaultDebitAcc.id, accountName: defaultDebitAcc.name, amount: -netDeposit },
          { accountId: cardAcc.id, accountName: cardAcc.name, amount: netDeposit },
        ],
        voucherType: "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: 0.3,
        source: "history",
      };
    }
  }

  // ── No match — use House Hold Exps monthly account for expenses ──
  if (tx.amount > 0) {
    const hhName = houseHoldMonthName(tx.date);
    const hhAcct = allAccounts.find((a) => a.name.toLowerCase() === hhName.toLowerCase());
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America", "Chase");

    if (hhAcct && bankAcc) {
      return {
        entries: [
          { accountId: hhAcct.id, accountName: hhAcct.name, amount: -netDeposit },
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: netDeposit },
        ],
        voucherType: "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: 0.35,
        source: "household",
      };
    }
  }

  // ── No match — deposit landed in a known bank account, default Dr to that account ──
  // Plaid already tells us which institution/account the money hit (tx.institution_name); no
  // reason to leave this blank and make the user pick it manually when that much is knowable.
  // Credit side (what the deposit was FOR) is genuinely unknown, so it defaults to a generic
  // income account pending user review -- deliberately low confidence, no "auto" badge.
  if (tx.amount < 0) {
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America", "Chase Bank", "Chase");
    const incomeAcc = findAcct(accounts, "Other Income", "Misc Income");
    if (bankAcc && incomeAcc) {
      return {
        entries: [
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: -netDeposit },
          { accountId: incomeAcc.id, accountName: incomeAcc.name, amount: netDeposit },
        ],
        voucherType: "Receipt",
        narration: tx.merchant_name || tx.name,
        confidence: 0.35,
        source: "history",
      };
    }
  }

  // ── Still no match — empty scaffold ──
  return {
    entries: [],
    voucherType: tx.amount < 0 ? "Receipt" : "Payment",
    narration: tx.merchant_name || tx.name,
    confidence: 0,
    source: "none",
  };
}

// ── Check if already imported ─────────────────────────────────────────────────
// Handles four patterns:
// 1. Exact date + amount match
// 2. Delayed posting: same amount within ±2 days (banks/cards post 1-2 days late)
// 3. Aggregated: multiple same-merchant same-day Plaid charges were posted as one
//    combined vault entry — check if group total matches a vault entry
// 4. Multi-entry Receipt: e.g. payroll splits BofA + Chase into one vault Receipt;
//    check if any single debit entry in a vault Receipt matches the Plaid deposit

function alreadyImported(tx: PlaidTxRaw, allPending: PlaidTxRaw[], ledger: Ledger, confirmedMatches: ConfirmedMatch[]): boolean {
  // For bank-pending (uncleared) transactions: skip loose ±2-day window and confirmed-merchant
  // auto-detection — a $4 Voyager Cafe pending charge is NOT the same entry as a prior $4
  // Voyager Cafe settled charge; they're separate purchases that happen to cost the same.
  // Instead: match only if (a) an explicit bank-pending vault entry exists within ±1 day,
  // OR (b) any vault entry for the exact same date has the same amount (e.g. manually posted).
  if (tx.pending) {
    // A user-confirmed match (via "Already posted?") always wins, regardless of date drift.
    if (confirmedMatches.some((m) => m.confirmed_tx_ids.includes(tx.transaction_id))) return true;
    const amt = Math.abs(tx.amount);
    const txMs = new Date(tx.date + "T12:00:00Z").getTime();
    // Plaid can reissue a NEW transaction_id for a still-pending item on a later fetch (seen with
    // BofA Zelle/ACH "Processing" entries) — the exact-tx_id check above then silently stops
    // matching even though the user already confirmed it once. Fall back to the specific voucher
    // that was confirmed: if any past confirmation points at a vault voucher with the same amount
    // within a few days of this pending date, treat it as the same real-world item. Deliberately
    // keyed to a specific already-confirmed vault_voucher_id (not a general merchant+amount
    // pattern) so it doesn't reintroduce the "two separate $4 coffees" false-positive risk the
    // comment above warns about.
    if (confirmedMatches.some((m) => {
      if (Math.abs(m.amount - amt) >= 0.05) return false;
      const v = ledger.transactions.find((vv) => vv.id === m.vault_voucher_id);
      if (!v || v.deleted || v.cancelled) return false;
      const daysDiff = Math.abs(txMs - new Date(v.date + "T12:00:00Z").getTime()) / 86400000;
      return daysDiff <= 3;
    })) return true;
    const vDebit = (v: { entries: { amount: number }[] }) =>
      v.entries.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0);
    return ledger.transactions.some((v) => {
      if (v.deleted || v.cancelled) return false;
      const amtMatch = Math.abs(vDebit(v) - amt) < 0.05;
      if (!amtMatch) return false;
      const daysDiff = Math.abs(txMs - new Date(v.date + "T12:00:00Z").getTime()) / 86400000;
      // Explicit pending save (bank-pending): allow ±1 day for same-charge detection
      if (v.syncStatus === "bank-pending") return daysDiff <= 1;
      // Any other vault entry: require exact same date to avoid cross-day false positives
      return v.date === tx.date;
    });
  }

  // Pattern 5a: exact match by Plaid transaction_id (manually confirmed previously)
  if (confirmedMatches.some((m) => m.confirmed_tx_ids.includes(tx.transaction_id))) return true;
  // Pattern 5b: same merchant + same amount as a previously confirmed pattern.
  // ONLY for expense transactions (tx.amount > 0). A credit/refund (tx.amount < 0) must never
  // match against payment history — a -$62.50 Amazon refund is NOT the same event as a
  // +$62.50 Amazon charge even though Math.abs is equal.
  const txAmt = Math.abs(tx.amount);
  const merchantDesc = (tx.merchant_name || tx.name || "").toLowerCase();
  if (tx.amount > 0 && confirmedMatches.some((m) =>
    m.merchant_key && merchantDesc.includes(m.merchant_key) &&
    Math.abs(txAmt - m.amount) < Math.max(0.05, m.amount * 0.02)
  )) return true;
  const amt = Math.abs(tx.amount);
  const txMs = new Date(tx.date + "T12:00:00Z").getTime();

  const withinWindow = (vaultDate: string) =>
    Math.abs(txMs - new Date(vaultDate + "T12:00:00Z").getTime()) / 86400000 <= 2;

  const vaultDebitAmt = (v: { entries: { amount: number }[] }) =>
    v.entries.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0);

  // Pattern 1 & 2: individual transaction match — exact or within ±2 days.
  // DIRECTION GUARD using account sides (not vault entry type, which can be wrong for old data):
  //   tx.amount > 0 (expense/charge)  → bank/CC account must be on the CREDIT side (positive) in vault
  //   tx.amount < 0 (credit/refund)   → bank/CC account must be on the DEBIT side (negative) in vault
  // Example of the false positive this prevents:
  //   Amazon charge in vault: Dr HouseHold(-62.50) / Cr AMEX(+62.50) → CC is on Cr
  //   Amazon refund from Plaid: amount = -62.50 → expects CC on Dr → rejects the charge vault entry ✓
  // Contra (CC payment) in vault: Dr AMEX(-200) / Cr BofA(+200) → CC/bank on BOTH sides → passes both checks ✓
  const hasCcOrBankOnSide = (v: { entries: { accountId: number; amount: number }[] }, positive: boolean) =>
    v.entries.some((e) => {
      if (positive ? e.amount <= 0 : e.amount >= 0) return false;
      const a = ledger.accounts.find((ac) => ac.id === e.accountId);
      return a && (isCcAcct(a) || isBankAcct(a));
    });
  // Merchant tokens for the fuzzy (non-exact-date) path only -- an exact-date match is almost
  // always the same Plaid transaction re-fetched, so it stays merchant-agnostic as before. The
  // fuzzy ±2-day window exists for bank pending/posted lag, not for "same amount, any merchant,
  // within a couple days" -- without a merchant check it silently hides a genuine second
  // purchase (e.g. two separate $4.75 coffees at the same cafe 2 days apart) as a duplicate,
  // with no way for the user to ever see and correct it.
  const txMerchantTokens = new Set(tokenise(tx.merchant_name || tx.name || ""));
  const singleMatch = ledger.transactions.some((v) => {
    if (v.deleted) return false;
    if (Math.abs(vaultDebitAmt(v) - amt) >= 0.05) return false;
    // expense tx (amount > 0): CC/bank must be on Cr side (positive)
    if (tx.amount > 0 && !hasCcOrBankOnSide(v, true)) return false;
    // credit/refund tx (amount < 0): CC/bank must be on Dr side (negative)
    if (tx.amount < 0 && !hasCcOrBankOnSide(v, false)) return false;
    // Exclude Contra entries (CC payments): both sides are financial — Dr AMEX / Cr Chase.
    // A CC payment has the same debit-side check as a refund but is NOT a refund.
    if (tx.amount < 0 && hasCcOrBankOnSide(v, true)) return false;
    if (v.date === tx.date) return true;
    if (!withinWindow(v.date)) return false;
    const vaultTokens = tokenise(v.narration || "");
    return vaultTokens.some((t) => txMerchantTokens.has(t));
  });
  if (singleMatch) return true;

  // Pattern 4: money-IN deposit that is one of several debit entries in a multi-entry vault Receipt
  // e.g. payroll: one Receipt voucher has Dr BofA $5,127.36 + Dr Chase $2,000 + Dr Tax + ...
  // vaultDebitAmt sums ALL debits (~$10,196) so Pattern 1 misses the individual $5,127.36 deposit
  if (tx.amount < 0) {
    const entryMatch = ledger.transactions.some((v) => {
      if (v.deleted || v.type !== "Receipt") return false;
      if (!withinWindow(v.date)) return false;
      return v.entries.some((e) => e.amount < 0 && Math.abs(Math.abs(e.amount) - amt) < 0.05);
    });
    if (entryMatch) return true;
  }

  // Pattern 3: same-merchant same-day same-direction charges posted as one combined vault entry
  // Only group same-direction (both expense or both income) to avoid mixing receipts with payments.
  // Skip generic finance noise words (same stoplist as tokenise()) -- otherwise two unrelated
  // same-day, same-sign transactions that both happen to say "purchase" or "payment" get pooled
  // as false peers, and a genuine second transaction can silently vanish from the import screen
  // if their combined total coincidentally matches an existing vault entry.
  const merchantKey = (tx.merchant_name || tx.name || "")
    .toLowerCase().split(/\W+/).find((w) => w.length > 2 && !GENERIC_FINANCE_WORDS.has(w)) || "";
  if (!merchantKey) return false;

  const txSign = Math.sign(tx.amount);
  const groupPeers = allPending.filter(
    (t) => t.transaction_id !== tx.transaction_id &&
      t.date === tx.date &&
      Math.sign(t.amount) === txSign &&
      (t.merchant_name || t.name || "").toLowerCase().includes(merchantKey)
  );
  if (!groupPeers.length) return false;

  const groupTotal = amt + groupPeers.reduce((s, t) => s + Math.abs(t.amount), 0);
  return ledger.transactions.some((v) => {
    if (v.deleted) return false;
    return Math.abs(vaultDebitAmt(v) - groupTotal) < 0.05 && withinWindow(v.date);
  });
}

// ── Balance reconciliation helpers ────────────────────────────────────────────

function vaultBookBalance(accountId: number, plaidType: string, ledger: Ledger): number {
  let sum = 0;
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled) continue;
    for (const e of v.entries) {
      if (e.accountId === accountId) sum += e.amount;
    }
  }
  // Vault convention: Dr=negative, Cr=positive
  // Asset (depository): balance = -sum  (Dr entries increase the asset)
  // Liability (credit): balance = +sum  (Cr entries increase what you owe)
  return plaidType === "credit" ? sum : -sum;
}

// Sum of vault entries with syncStatus==="bank-pending" for this account.
// These are transactions posted via the Pending tab that haven't cleared the bank yet.
// Used to compute Adj Diff = Plaid − Vault + VaultPendingNet; when zero, books are reconciled.
function vaultPendingNet(accountId: number, plaidType: string, ledger: Ledger): number {
  let sum = 0;
  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled || v.syncStatus !== "bank-pending") continue;
    for (const e of v.entries) {
      if (e.accountId === accountId) sum += e.amount;
    }
  }
  return plaidType === "credit" ? sum : -sum;
}

function vaultUnclearedEntries(accountId: number, ledger: Ledger) {
  return ledger.transactions
    .filter((v) => !v.deleted && !v.cancelled && v.syncStatus === "bank-pending")
    .flatMap((v) =>
      v.entries
        .filter((e) => e.accountId === accountId)
        .map((e) => ({ date: v.date, narration: v.narration ?? "", type: v.type, amount: e.amount }))
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Two physical BofA credit cards (the user's + spouse Hiral's) share one institution but post
// to two separate GL accounts, split via a one-time manual reclassification (2026-08-27).
// Plaid's own account nickname is stable per physical card, so it's the one reliable signal to
// tell them apart -- institution name/type alone can't, since both are "BofA credit".
const BOFA_CARD_GL_BY_NAME: Record<string, string> = {
  "customized cash rewards visa signature": "Credit Card - BofA - Hiral",
  "unlimited cash rewards visa signature": "Credit Card - BofA",
};

function bofaCardGlAccountName(plaidAcctName: string): string | undefined {
  return BOFA_CARD_GL_BY_NAME[(plaidAcctName || "").toLowerCase().trim()];
}

// Display-only label suffix for the Balances tab so it's obvious at a glance whose card each
// row is, without having to cross-reference the GL account column.
const BOFA_CARD_OWNER_BY_NAME: Record<string, string> = {
  "customized cash rewards visa signature": "Hiral",
  "unlimited cash rewards visa signature": "DK",
};

function bofaCardOwnerLabel(plaidAcctName: string): string | undefined {
  return BOFA_CARD_OWNER_BY_NAME[(plaidAcctName || "").toLowerCase().trim()];
}

function matchVaultAccount(plaidAcct: PlaidAccount, vaultAccounts: Account[]): Account | undefined {
  const inst = (plaidAcct.institution_name || "").toLowerCase();
  const isCreditAcct = plaidAcct.type === "credit";
  const isSavings = plaidAcct.subtype === "savings";
  if (/bank.of.america|bofa/i.test(inst)) {
    if (isCreditAcct) {
      const specific = bofaCardGlAccountName(plaidAcct.name);
      return findAcct(vaultAccounts, ...(specific ? [specific] : []), "Credit Card - BofA", "BofA Credit Card");
    }
    if (isSavings)
      return findAcct(vaultAccounts, "Saving Account", "Savings Account", "BofA Savings", "Savings");
    return findAcct(vaultAccounts, "Bank Of America", "Bank of America");
  }
  if (/american express|amex/i.test(inst))
    return findAcct(vaultAccounts, "AMEX Credit Card", "American Express", "Amex");
  if (/chase/i.test(inst))
    return isCreditAcct
      ? findAcct(vaultAccounts, "Chase Credit Card")
      : findAcct(vaultAccounts, "Chase Bank", "Chase");
  if (/citi(?!zen)/i.test(inst))
    return findAcct(vaultAccounts, "Citi Credit Card", "Citibank", "Citi");
  if (/wells.fargo/i.test(inst))
    return findAcct(vaultAccounts, "Wells Fargo");
  // Fidelity: only the HSA has a real Bank-group ledger to reconcile against (see
  // "HSA Fidelity Account") -- the 401(k) is intentionally NOT tracked as a bank-type account
  // (its ledger equivalent, "401K Investments", tracks cumulative payroll contributions under the
  // Retirement group, not a balance meant to match Fidelity's real number). Leaving 401(k) match
  // undefined here is correct, not an oversight -- it shows up informational-only, no vault
  // balance/difference column, same as before this HSA rule existed.
  if (/fidelity/i.test(inst) && plaidAcct.subtype === "hsa")
    return findAcct(vaultAccounts, "HSA Fidelity Account");
  return undefined;
}

// ── PlaidConnectButton sub-component ──────────────────────────────────────────

function PlaidConnectButton({ onConnected }: { onConnected: (name: string) => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkClient, setLinkClient] = useState<"primary" | "secondary" | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((r) => r.json())
      .then((d: any) => {
        if (d.link_token) { setLinkToken(d.link_token); setLinkClient(d.client); }
        else setError(d.error_message || d.error_code || "Failed to get link token");
      })
      .catch(() => setError("Network error — check Plaid credentials"))
      .finally(() => setLoading(false));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata) => {
      const name = metadata?.institution?.name || "Bank";
      const id = (metadata?.institution as any)?.institution_id || "";
      // Must tag the connection with the SAME project that created this link_token -- the
      // public_token can only be exchanged with that same client_id/secret pair.
      fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token: publicToken, institution_name: name, institution_id: id, client: linkClient }),
      }).then((resp) => {
        if (resp.ok) onConnected(name);
        else setError("Token exchange failed");
      });
    },
    [onConnected, linkClient]
  );

  const { open, ready } = usePlaidLink({ token: linkToken || "", onSuccess });

  if (error) return <span className="plaid-error">{error}</span>;
  if (loading || !linkToken) return <button className="plaid-connect-btn" disabled>Loading…</button>;
  return (
    <button className="plaid-connect-btn" onClick={() => open()} disabled={!ready}>
      + Connect Bank
    </button>
  );
}

// Repairs ONE broken connection in place (update mode) -- same access_token/item_id, same
// transaction history, no duplicate connection. Distinct from PlaidConnectButton above, which
// always creates a brand-new Item; going through that flow for an already-broken bank would add
// a second connection for the same institution instead of fixing the first one.
function PlaidReconnectButton({
  itemId, institutionName, onReconnected,
}: {
  itemId: string;
  institutionName: string;
  onReconnected: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function startReconnect() {
    setLoading(true);
    setError("");
    fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    })
      .then((r) => r.json())
      .then((d: any) => {
        if (d.link_token) setLinkToken(d.link_token);
        else setError(d.error_message || d.error_code || "Failed to get an update-mode link token");
      })
      .catch(() => setError("Network error — check Plaid credentials"))
      .finally(() => setLoading(false));
  }

  // Update mode: completing Link re-authenticates the SAME item server-side. The public_token
  // returned here is not exchanged for anything -- the original access_token stays valid, so
  // there's no /api/plaid/exchange call, unlike PlaidConnectButton's new-connection flow.
  const onSuccess = useCallback<PlaidLinkOnSuccess>(() => {
    setLinkToken(null);
    onReconnected();
  }, [onReconnected]);

  const { open, ready } = usePlaidLink({ token: linkToken || "", onSuccess });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  if (error) {
    return (
      <span className="plaid-error">
        {error}{" "}
        <button className="plaid-connect-btn" onClick={startReconnect}>Retry</button>
      </span>
    );
  }
  return (
    <button className="plaid-connect-btn" onClick={startReconnect} disabled={loading}>
      {loading ? "Opening…" : `🔧 Reconnect ${institutionName}`}
    </button>
  );
}

// ── Main PlaidImport component ─────────────────────────────────────────────────

export function PlaidImport({ data, onSave }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [confirmedMatches, setConfirmedMatches] = useState<ConfirmedMatch[]>([]);
  const [pickerRowIdx, setPickerRowIdx] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pendingPickerRowIdx, setPendingPickerRowIdx] = useState<number | null>(null);
  const [pendingPickerSearch, setPendingPickerSearch] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [hideInVault, setHideInVault] = useState(true);
  const [newAccts, setNewAccts] = useState<Record<string, Account>>({});
  const [status, setStatus] = useState("");
  const [brokenItems, setBrokenItems] = useState<
    { item_id: string; institution_name: string; error_code?: string; error_message?: string }[]
  >([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingTxs, setPendingTxs] = useState<PlaidTxRaw[]>([]);
  const [investmentTxs, setInvestmentTxs] = useState<PlaidInvestmentTx[]>([]);
  // Specific (voucher, Plaid transaction) pairings the user has explicitly said "this is NOT the
  // same charge" for -- keyed as `${voucher_guid}|${plaid_transaction_id}`, persisted server-side
  // (see app/api/plaid/investment-match-overrides) so the correction sticks across fetches/sessions.
  // Scoped to the specific pairing, not the whole voucher: a recurring merchant means a later,
  // genuinely-matching Plaid transaction can still arrive for the same voucher and must still be
  // allowed to match then.
  const [investmentMatchOverrides, setInvestmentMatchOverrides] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch("/api/plaid/investment-match-overrides")
      .then((r) => r.json() as Promise<{ voucher_guid: string; plaid_transaction_id: string }[]>)
      .then((pairs) => setInvestmentMatchOverrides(new Set(pairs.map((p) => `${p.voucher_guid}|${p.plaid_transaction_id}`))))
      .catch(() => {});
  }, []);
  async function rejectInvestmentMatch(guid: string, plaidTransactionId: string) {
    setInvestmentMatchOverrides((prev) => new Set(prev).add(`${guid}|${plaidTransactionId}`));
    try {
      await fetch("/api/plaid/investment-match-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher_guid: guid, plaid_transaction_id: plaidTransactionId }),
      });
    } catch {
      // Best-effort -- the local state update already reflects it for this session even if the
      // persisted write fails; next load will just re-prompt if it never saved.
    }
  }
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccount[]>([]);
  const [activeTab, setActiveTab] = useState<"transactions" | "pending" | "balances">("transactions");
  const [pendingRows, setPendingRows] = useState<ImportRow[]>([]);
  const [savingPending, setSavingPending] = useState(false);
  const [expandedReconIdx, setExpandedReconIdx] = useState<number | null>(null);
  const [expandedUnclearedIdx, setExpandedUnclearedIdx] = useState<number | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [manualName, setManualName] = useState("");
  const [manualAmt, setManualAmt] = useState("");
  const [manualDrId, setManualDrId] = useState(0);
  const [manualCrId, setManualCrId] = useState(0);
  const [savingManual, setSavingManual] = useState(false);

  function reloadConnections() {
    fetch("/api/plaid/connections")
      .then((r) => r.json())
      .then((cs: unknown) => {
        const list = cs as Connection[];
        setConnections(list);
        setSelectedIds((prev) => {
          // Keep existing selections as-is once the user has any.
          if (prev.size) return new Set(prev);
          // Fresh load: everything selected -- Fidelity carries the spendable HSA balance
          // alongside the 401k, and Plaid can't refresh just one account within a connection,
          // so excluding Fidelity to skip the slow 401k also silently hid the HSA balance.
          return new Set(list.map((c) => c.item_id));
        });
      })
      .catch(() => {});
  }

  function toggleInstitution(item_id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item_id)) next.delete(item_id); else next.add(item_id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) =>
      prev.size === connections.length ? new Set() : new Set(connections.map((c) => c.item_id))
    );
  }

  useEffect(() => { reloadConnections(); }, []);

  useEffect(() => {
    fetch("/api/plaid/confirmed-matches")
      .then((r) => r.json())
      .then((ms: unknown) => setConfirmedMatches(ms as ConfirmedMatch[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const margin = 10;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      // Pick whichever side has more room, then cap maxHeight to what's ACTUALLY available
      // there (not just a static CSS value) -- a short browser window can leave less than the
      // menu's natural content height on either side, and only a viewport-aware inline maxHeight
      // (which wins over the CSS class's static max-height) makes the internal scroll actually
      // kick in instead of leaving part of the menu rendered off-screen with nothing to scroll.
      const isDropUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      setMenuStyle(
        isDropUp
          ? { position: "fixed", bottom: window.innerHeight - rect.top + 6, left: rect.left, minWidth: rect.width, maxHeight: Math.max(120, spaceAbove) }
          : { position: "fixed", top: rect.bottom + 6, left: rect.left, minWidth: rect.width, maxHeight: Math.max(120, spaceBelow) }
      );
    }
    const onOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
        setDropdownOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [dropdownOpen]);

  async function fetchTransactions() {
    setFetching(true);
    const selectedConns = connections.filter((c) => selectedIds.has(c.item_id));
    const label = selectedConns.map((c) => c.institution_name).join(", ") || "selected banks";
    setStatus(`Fetching transactions from ${label}…`);
    try {
      const fetchingAll = selectedConns.length === connections.length;
      const qs = fetchingAll
        ? ""
        : `?institution=${selectedConns.map((c) => encodeURIComponent(c.institution_name)).join(",")}`;
      const r = await fetch(`/api/plaid/transactions${qs}`);
      const { transactions, accounts: rawPlaidAccts, investmentTransactions, errors, itemErrors } = (await r.json()) as {
        transactions: PlaidTxRaw[];
        accounts: PlaidAccount[];
        investmentTransactions?: PlaidInvestmentTx[];
        errors: string[];
        itemErrors?: { item_id: string; institution_name: string; error_code?: string; error_message?: string }[];
      };
      if (errors?.length) setStatus(`Partial fetch — ${errors.join(", ")}`);
      else setStatus("");
      setBrokenItems(itemErrors ?? []);
      setInvestmentTxs(investmentTransactions ?? []);
      // Enrich each account with its institution_name inferred from transactions
      const acctToInst = new Map<string, string>();
      for (const tx of transactions) {
        if (tx.institution_name && !acctToInst.has(tx.account_id))
          acctToInst.set(tx.account_id, tx.institution_name);
      }
      const enrichedAccts = (rawPlaidAccts || []).map((a) => ({
        ...a,
        institution_name: acctToInst.get(a.account_id) || a.institution_name || "",
      }));
      setPlaidAccounts(enrichedAccts);
      const plaidAcctMap = new Map<string, PlaidAccount>(
        enrichedAccts.map((a) => [a.account_id, a])
      );
      const pendingBankTxs = transactions.filter((t) => t.pending);
      setPendingTxs(pendingBankTxs);
      const pending = transactions.filter((t) => !t.pending);
      const historyIndex = buildHistoryIndex(data);
      const acctsToCreate = computeNewAccounts([...pending, ...pendingBankTxs], data, historyIndex);
      setNewAccts(acctsToCreate);
      const draftPendingRows: ImportRow[] = pendingBankTxs.map((tx) => {
        const draft = enforceContraType(buildDraft(tx, data, acctsToCreate, historyIndex, plaidAcctMap), data.accounts);
        const imported = alreadyImported(tx, pendingBankTxs, data, confirmedMatches);
        return { plaidTx: tx, skip: imported || isBofaPaymentDuplicate(tx), alreadyImported: imported, ...draft };
      });
      flagCrossFeedDuplicates(draftPendingRows, data.transactions);
      setPendingRows(draftPendingRows);
      const draftRows: ImportRow[] = pending.map((tx) => {
        const draft = enforceContraType(buildDraft(tx, data, acctsToCreate, historyIndex, plaidAcctMap), data.accounts);
        const imported = alreadyImported(tx, pending, data, confirmedMatches);
        return {
          plaidTx: tx,
          skip: imported || isBofaPaymentDuplicate(tx),
          alreadyImported: imported,
          ...draft,
        };
      });
      flagCrossFeedDuplicates(draftRows, data.transactions);
      setRows(draftRows);
    } catch {
      setStatus("Failed to fetch transactions");
    } finally {
      setFetching(false);
    }
  }

  async function disconnect(item_id: string) {
    await fetch("/api/plaid/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id }),
    });
    reloadConnections();
  }

  function updateRow(idx: number, patch: Partial<ImportRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function blankEntryPair(row: ImportRow): EntryDraft[] {
    const amt = Math.abs(row.plaidTx.amount);
    const first = data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name))[0];
    const base = first ? { accountId: first.id, accountName: first.name } : { accountId: 0, accountName: "" };
    return [
      { ...base, amount: -amt },
      { ...base, amount: amt },
    ];
  }

  function updateEntry(rowIdx: number, eIdx: number, patch: Partial<EntryDraft>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i !== rowIdx
          ? r
          : { ...r, entries: r.entries.map((e, j) => (j === eIdx ? { ...e, ...patch } : e)) }
      )
    );
  }

  function updatePendingRow(idx: number, patch: Partial<ImportRow>) {
    setPendingRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function updatePendingEntry(rowIdx: number, eIdx: number, patch: Partial<EntryDraft>) {
    setPendingRows((rs) =>
      rs.map((r, i) =>
        i !== rowIdx
          ? r
          : { ...r, entries: r.entries.map((e, j) => (j === eIdx ? { ...e, ...patch } : e)) }
      )
    );
  }

  async function savePendingSelected() {
    const toSave = pendingRows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2);
    if (!toSave.length) { setStatus("Nothing to save."); return; }
    setSavingPending(true);
    const usedAcctIds = new Set(toSave.flatMap((r) => r.entries.map((e) => e.accountId)));
    const pendingAcctsNeeded = Object.values(newAccts).filter(
      (na) =>
        usedAcctIds.has(na.id) &&
        !data.accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase())
    );
    const updatedAccounts = pendingAcctsNeeded.length
      ? [...data.accounts, ...pendingAcctsNeeded]
      : data.accounts;
    const importedAt = new Date().toISOString();
    const newIds = nextTransactionIds(data.transactions, toSave.length);
    const drafts = toSave.map((r, i) => ({
      row: r,
      tx: {
        id: newIds[i],
        guid: crypto.randomUUID(),
        syncStatus: "bank-pending" as const,
        createdAt: importedAt,
        date: r.plaidTx.date,
        number: "",
        type: r.voucherType,
        narration: r.narration,
        historical: false,
        cancelled: false,
        entries: r.entries,
      } satisfies Tx,
    }));
    const existingTxs = data.transactions;
    const safeTxs: Tx[] = [];
    const blockedTxIds = new Set<string>();
    for (const { row, tx } of drafts) {
      if (!row.forceSave && vaultHasDuplicate(tx, [...existingTxs, ...safeTxs])) {
        blockedTxIds.add(row.plaidTx.transaction_id);
        continue;
      }
      safeTxs.push(tx);
    }
    const blocked = blockedTxIds.size;
    if (blockedTxIds.size) {
      setPendingRows((rs) => rs.map((r) => (blockedTxIds.has(r.plaidTx.transaction_id) ? { ...r, dupBlocked: true } : r)));
    }
    if (!safeTxs.length) {
      setStatus(`All ${blocked} pending voucher(s) already exist in vault.`);
      setSavingPending(false);
      return;
    }
    setStatus(`Saving ${safeTxs.length} pending voucher(s)${blocked ? ` (${blocked} duplicate(s) blocked)` : ""}…`);
    const next: Ledger = { ...data, accounts: updatedAccounts, transactions: [...data.transactions, ...safeTxs] };
    const ok = await onSave(next);
    if (ok) {
      const msg = blocked
        ? `${safeTxs.length} saved. ${blocked} duplicate(s) were blocked.`
        : `${safeTxs.length} pending voucher(s) saved.`;
      setStatus(msg);
      const savedIds = new Set(drafts.filter((d) => safeTxs.includes(d.tx)).map((d) => d.row.plaidTx.transaction_id));
      setPendingRows((rs) => rs.map((r) => (savedIds.has(r.plaidTx.transaction_id) ? { ...r, alreadyImported: true, skip: true } : r)));
    } else {
      setStatus("Save failed.");
    }
    setSavingPending(false);
  }

  async function saveManualPending() {
    const amt = parseFloat(manualAmt);
    if (!manualDate || !manualName.trim() || !amt || amt <= 0 || !manualDrId || !manualCrId) {
      setStatus("Fill in date, description, amount, and both accounts.");
      return;
    }
    if (manualDrId === manualCrId) { setStatus("Debit and credit accounts must differ."); return; }
    const drAcc = data.accounts.find((a) => a.id === manualDrId);
    const crAcc = data.accounts.find((a) => a.id === manualCrId);
    if (!drAcc || !crAcc) return;
    setSavingManual(true);
    const newTx: Tx = {
      id: nextTransactionIds(data.transactions, 1)[0],
      guid: crypto.randomUUID(),
      syncStatus: "manual-pending",
      createdAt: new Date().toISOString(),
      date: manualDate,
      number: "",
      type: "Payment",
      narration: manualName.trim(),
      historical: false,
      cancelled: false,
      entries: [
        { accountId: manualDrId, accountName: drAcc.name, amount: -amt },
        { accountId: manualCrId, accountName: crAcc.name, amount: amt },
      ],
    };
    const next: Ledger = { ...data, transactions: [...data.transactions, newTx] };
    const ok = await onSave(next);
    if (ok) {
      setStatus("Manual pending entry saved.");
      setShowManualForm(false);
      setManualName("");
      setManualAmt("");
    } else {
      setStatus("Save failed.");
    }
    setSavingManual(false);
  }

  function vaultHasDuplicate(draft: { date: string; entries: { accountId: number; amount: number }[] }, existing: Tx[]): boolean {
    const dr = draft.entries.find((e) => e.amount < 0);
    const cr = draft.entries.find((e) => e.amount > 0);
    if (!dr || !cr) return false;
    const amt = Math.abs(dr.amount);
    const draftMs = new Date(draft.date + "T12:00:00Z").getTime();
    return existing.some((v) => {
      if (v.deleted || v.cancelled) return false;
      const vDr = v.entries.find((e) => e.amount < 0);
      const vCr = v.entries.find((e) => e.amount > 0);
      if (!vDr || !vCr) return false;
      if (vDr.accountId !== dr.accountId || vCr.accountId !== cr.accountId) return false;
      if (Math.abs(Math.abs(vDr.amount) - amt) >= 0.05) return false;
      return Math.abs(draftMs - new Date(v.date + "T12:00:00Z").getTime()) / 86400000 <= 3;
    });
  }

  async function saveSelected() {
    const toSave = rows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2);
    if (!toSave.length) { setStatus("Nothing to save."); return; }
    setSaving(true);

    // Determine which new accounts are actually needed by selected rows
    const usedAcctIds = new Set(toSave.flatMap((r) => r.entries.map((e) => e.accountId)));
    const pendingAcctsNeeded = Object.values(newAccts).filter(
      (na) =>
        usedAcctIds.has(na.id) &&
        !data.accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase())
    );

    const updatedAccounts = pendingAcctsNeeded.length
      ? [...data.accounts, ...pendingAcctsNeeded]
      : data.accounts;

    const importedAt = new Date().toISOString();
    const newIds = nextTransactionIds(data.transactions, toSave.length);
    const drafts = toSave.map((r, i) => ({
      row: r,
      tx: {
        id: newIds[i],
        guid: crypto.randomUUID(),
        syncStatus: "pending" as const,
        createdAt: importedAt,
        date: r.plaidTx.date,
        number: "",
        type: r.voucherType,
        narration: r.narration,
        historical: false,
        cancelled: false,
        entries: r.entries,
      } satisfies Tx,
    }));

    // Guardrail: skip any draft that would create a vault duplicate (unless the user force-saved it)
    const existingTxs = data.transactions;
    const safeTxs: Tx[] = [];
    const blockedTxIds = new Set<string>();
    for (const { row, tx } of drafts) {
      if (!row.forceSave && vaultHasDuplicate(tx, [...existingTxs, ...safeTxs])) {
        blockedTxIds.add(row.plaidTx.transaction_id);
        continue;
      }
      safeTxs.push(tx);
    }
    const blocked = blockedTxIds.size;
    if (blockedTxIds.size) {
      setRows((rs) => rs.map((r) => (blockedTxIds.has(r.plaidTx.transaction_id) ? { ...r, dupBlocked: true } : r)));
    }

    if (!safeTxs.length) {
      setStatus(`All ${blocked} voucher(s) already exist in vault — nothing saved.`);
      setSaving(false);
      return;
    }

    if (pendingAcctsNeeded.length) {
      setStatus(`Creating ${pendingAcctsNeeded.length} new account(s) and saving ${safeTxs.length} voucher(s)${blocked ? ` (${blocked} duplicate(s) blocked)` : ""}…`);
    } else {
      setStatus(`Saving ${safeTxs.length} voucher(s)${blocked ? ` (${blocked} duplicate(s) blocked)` : ""}…`);
    }

    // Record confirmed bank deposits against their matching pay period in Reports → Tax,
    // so that tab reflects which paychecks are actually confirmed vs. still projected.
    let nextPayroll = data.payroll;
    if (nextPayroll) {
      const payrollSaved = drafts.filter((d) => d.row.source === "payroll" && safeTxs.includes(d.tx));
      if (payrollSaved.length) {
        const years = nextPayroll.years.map((y) => ({ ...y, matches: y.matches ? [...y.matches] : [] }));
        for (const { row: draftRow, tx } of payrollSaved) {
          const ref = matchPayrollPeriod(nextPayroll, tx.date);
          if (!ref) continue;
          const y = years[ref.yearIdx];
          if (y.matches!.some((m) => m.periodIndex === ref.periodIndex)) continue;
          y.matches!.push({
            periodIndex: ref.periodIndex,
            txGuid: tx.guid,
            txDate: tx.date,
            depositAmount: Math.abs(draftRow.plaidTx.amount),
            confirmedAt: importedAt,
          });
        }
        nextPayroll = { ...nextPayroll, years };
      }
    }

    const next: Ledger = { ...data, accounts: updatedAccounts, transactions: [...data.transactions, ...safeTxs], payroll: nextPayroll };
    const ok = await onSave(next);
    if (ok) {
      const msg = blocked
        ? `${safeTxs.length} saved. ${blocked} duplicate(s) were blocked — check Duplicates tab.`
        : `${safeTxs.length} voucher(s) saved.`;
      setStatus(msg);
      const savedIds = new Set(drafts.filter((d) => safeTxs.includes(d.tx)).map((d) => d.row.plaidTx.transaction_id));
      setRows((rs) => rs.map((r) => (savedIds.has(r.plaidTx.transaction_id) ? { ...r, alreadyImported: true, skip: true } : r)));
    } else {
      setStatus("Save failed — see vault status for details.");
    }
    setSaving(false);
  }

  async function confirmMatch(rowIdx: number, vault: { id: number; narration: string; entries: { amount: number; accountId: number }[] }) {
    const tx = rows[rowIdx]?.plaidTx;
    if (!tx) return;
    const debitEntry = vault.entries.find((e) => e.amount < 0);
    const creditEntry = vault.entries.find((e) => e.amount > 0);
    const merchantKey = (tx.merchant_name || tx.name || "")
      .toLowerCase().split(/\W+/).find((w) => w.length > 2) || "";
    await fetch("/api/plaid/confirmed-matches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_id: tx.transaction_id,
        merchant_key: merchantKey,
        amount: Math.abs(tx.amount),
        vault_voucher_id: vault.id,
        vault_narration: vault.narration || "",
        debit_account_id: debitEntry?.accountId ?? 0,
        credit_account_id: creditEntry?.accountId ?? 0,
      }),
    });
    setConfirmedMatches((prev) => {
      const next = [...prev];
      const existing = next.find(
        (m) => m.merchant_key === merchantKey &&
          Math.abs(m.amount - Math.abs(tx.amount)) < Math.max(0.05, Math.abs(tx.amount) * 0.02)
      );
      if (existing) {
        if (!existing.confirmed_tx_ids.includes(tx.transaction_id))
          existing.confirmed_tx_ids.push(tx.transaction_id);
      } else {
        next.push({
          id: crypto.randomUUID(),
          merchant_key: merchantKey,
          amount: Math.abs(tx.amount),
          vault_voucher_id: vault.id,
          vault_narration: vault.narration || "",
          debit_account_id: debitEntry?.accountId ?? 0,
          credit_account_id: creditEntry?.accountId ?? 0,
          confirmed_tx_ids: [tx.transaction_id],
          confirmed_at: new Date().toISOString(),
        });
      }
      return next;
    });
    updateRow(rowIdx, { alreadyImported: true });
    setPickerRowIdx(null);
    setPickerSearch("");
  }

  async function confirmPendingMatch(rowIdx: number, vault: { id: number; narration: string; entries: { amount: number; accountId: number }[] }) {
    const tx = pendingRows[rowIdx]?.plaidTx;
    if (!tx) return;
    const debitEntry = vault.entries.find((e) => e.amount < 0);
    const creditEntry = vault.entries.find((e) => e.amount > 0);
    const merchantKey = (tx.merchant_name || tx.name || "")
      .toLowerCase().split(/\W+/).find((w) => w.length > 2) || "";
    await fetch("/api/plaid/confirmed-matches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_id: tx.transaction_id,
        merchant_key: merchantKey,
        amount: Math.abs(tx.amount),
        vault_voucher_id: vault.id,
        vault_narration: vault.narration || "",
        debit_account_id: debitEntry?.accountId ?? 0,
        credit_account_id: creditEntry?.accountId ?? 0,
      }),
    });
    setConfirmedMatches((prev) => {
      const next = [...prev];
      const existing = next.find(
        (m) => m.merchant_key === merchantKey &&
          Math.abs(m.amount - Math.abs(tx.amount)) < Math.max(0.05, Math.abs(tx.amount) * 0.02)
      );
      if (existing) {
        if (!existing.confirmed_tx_ids.includes(tx.transaction_id))
          existing.confirmed_tx_ids.push(tx.transaction_id);
      } else {
        next.push({
          id: crypto.randomUUID(),
          merchant_key: merchantKey,
          amount: Math.abs(tx.amount),
          vault_voucher_id: vault.id,
          vault_narration: vault.narration || "",
          debit_account_id: debitEntry?.accountId ?? 0,
          credit_account_id: creditEntry?.accountId ?? 0,
          confirmed_tx_ids: [tx.transaction_id],
          confirmed_at: new Date().toISOString(),
        });
      }
      return next;
    });
    updatePendingRow(rowIdx, { alreadyImported: true });
    setPendingPickerRowIdx(null);
    setPendingPickerSearch("");
  }

  async function undoPendingMatch(rowIdx: number) {
    const tx = pendingRows[rowIdx]?.plaidTx;
    if (!tx) return;
    await fetch("/api/plaid/confirmed-matches", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: tx.transaction_id }),
    });
    setConfirmedMatches((prev) =>
      prev
        .map((m) => ({ ...m, confirmed_tx_ids: m.confirmed_tx_ids.filter((id) => id !== tx.transaction_id) }))
        .filter((m) => m.confirmed_tx_ids.length > 0)
    );
    updatePendingRow(rowIdx, { alreadyImported: false, skip: false });
  }


  const toImport = rows.filter((r) => !r.skip && !r.alreadyImported);
  const newAcctsNeededCount = Object.values(newAccts).filter(
    (na) =>
      !data.accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase()) &&
      toImport.some((r) => r.source === "household" && r.entries.some((e) => e.accountId === na.id))
  ).length;

  return (
    <div className="plaid-import-panel">
      {/* Connected banks — compact dropdown */}
      <div className="plaid-banks-row">
        <div className="plaid-bank-dropdown" ref={dropdownRef}>
          <button
            ref={triggerRef}
            className="plaid-bank-trigger"
            onClick={() => setDropdownOpen((o) => !o)}
            disabled={fetching}
          >
            <span className="plaid-trigger-label">
              {connections.length === 0
                ? "No Banks Connected"
                : selectedIds.size === 0
                ? "Select Banks"
                : selectedIds.size === connections.length
                ? connections.length === 1
                  ? connections[0].institution_name
                  : `All Banks (${connections.length})`
                : selectedIds.size <= 2
                ? connections.filter((c) => selectedIds.has(c.item_id)).map((c) => c.institution_name).join(", ")
                : `${selectedIds.size} of ${connections.length} Banks`}
            </span>
            <span className="plaid-trigger-arrow">{dropdownOpen ? "▲" : "▼"}</span>
          </button>

          {dropdownOpen && (
            <div className="plaid-bank-menu" style={menuStyle}>
              {connections.length > 0 && (
                <>
                  <label className="plaid-bank-menu-item plaid-menu-select-all">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === connections.length}
                      onChange={toggleAll}
                    />
                    <span>Select All</span>
                  </label>
                  <div className="plaid-bank-menu-divider" />
                  {connections.map((c) => (
                    <label key={c.item_id} className="plaid-bank-menu-item">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.item_id)}
                        onChange={() => toggleInstitution(c.item_id)}
                      />
                      <span className="plaid-menu-bank-name">{c.institution_name}</span>
                      <button
                        className="plaid-menu-disconnect"
                        onClick={(e) => { e.preventDefault(); disconnect(c.item_id); }}
                        title="Disconnect"
                      >×</button>
                    </label>
                  ))}
                  <div className="plaid-bank-menu-divider" />
                </>
              )}
              <div className="plaid-bank-menu-connect">
                <PlaidConnectButton onConnected={(name) => { setStatus(`${name} connected!`); reloadConnections(); setDropdownOpen(false); }} />
              </div>
            </div>
          )}
        </div>

        <button
          className="plaid-fetch-btn"
          onClick={() => { fetchTransactions(); setDropdownOpen(false); }}
          disabled={fetching || selectedIds.size === 0}
          title={selectedIds.size === 0 ? "Select at least one bank" : undefined}
        >
          {fetching ? "Loading…" : `Fetch${selectedIds.size > 0 && selectedIds.size < connections.length ? ` (${selectedIds.size})` : ""}`}
        </button>
      </div>

      {status && (
        <div className="plaid-status">
          <div>{status}</div>
          {brokenItems.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {brokenItems.map((b) => (
                <PlaidReconnectButton
                  key={b.item_id}
                  itemId={b.item_id}
                  institutionName={b.institution_name}
                  onReconnected={() => {
                    setBrokenItems((prev) => prev.filter((x) => x.item_id !== b.item_id));
                    fetchTransactions();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab bar */}
      {(rows.length > 0 || pendingTxs.length > 0 || plaidAccounts.length > 0) && (
        <div className="plaid-tabs">
          <button
            className={`plaid-tab-btn${activeTab === "transactions" ? " active" : ""}`}
            onClick={() => setActiveTab("transactions")}
          >
            Transactions{rows.length > 0 ? ` (${toImport.length} to import)` : ""}
          </button>
          <button
            className={`plaid-tab-btn${activeTab === "pending" ? " active" : ""}`}
            onClick={() => setActiveTab("pending")}
          >
            {(() => {
              const unposted = pendingRows.filter((r) => !r.alreadyImported && !r.skip).length;
              return `Pending${unposted > 0 ? ` (${unposted})` : pendingRows.length > 0 ? " ✓" : ""}`;
            })()}
          </button>
          <button
            className={`plaid-tab-btn${activeTab === "balances" ? " active" : ""}`}
            onClick={() => setActiveTab("balances")}
          >
            Balances
          </button>
        </div>
      )}

      {/* Import review queue */}
      {activeTab === "transactions" && rows.length > 0 && (
        <>
          <div className="plaid-queue-toolbar">
            <span>{toImport.length} pending · {rows.filter((r) => r.alreadyImported).length} in vault</span>
            <label className="plaid-filter-toggle">
              <input type="checkbox" checked={hideInVault} onChange={(e) => setHideInVault(e.target.checked)} />
              Hide "in vault"
            </label>
            {newAcctsNeededCount > 0 && (
              <span className="plaid-new-accts-notice">
                + {newAcctsNeededCount} new account{newAcctsNeededCount > 1 ? "s" : ""} will be created
              </span>
            )}
            <label>
              <input type="checkbox" onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, skip: r.alreadyImported ? true : e.target.checked })))} />
              Skip all
            </label>
            <button className="plaid-save-btn" onClick={saveSelected} disabled={saving || !toImport.length}>
              {saving ? "Saving…" : `Save ${toImport.length} selected`}
            </button>
          </div>

          <div className="plaid-queue">
            {rows.map((row, idx) => hideInVault && row.alreadyImported ? null : (
              <div
                key={row.plaidTx.transaction_id}
                className={[
                  "plaid-queue-row",
                  row.alreadyImported ? "plaid-row-exists" : "",
                  row.skip && !row.alreadyImported ? "plaid-row-skipped" : "",
                  row.confidence >= 0.8 ? "plaid-row-confident" : row.confidence === 0 ? "plaid-row-unmatched" : "",
                ].filter(Boolean).join(" ")}
              >
                {/* Skip checkbox */}
                <input
                  type="checkbox"
                  checked={row.skip || row.alreadyImported}
                  disabled={row.alreadyImported}
                  onChange={(e) => updateRow(idx, { skip: e.target.checked })}
                  title={row.alreadyImported ? "Already in vault" : "Skip this transaction"}
                />

                {/* Transaction info */}
                <div className="plaid-tx-info">
                  <span className="plaid-tx-date">{fmtDate(row.plaidTx.date)}</span>
                  <span className="plaid-tx-name">{row.plaidTx.name}</span>
                  <span className={`plaid-tx-amt ${row.plaidTx.amount < 0 ? "credit" : "debit"}`}>
                    {row.plaidTx.amount < 0 ? "+" : "−"}${Math.abs(row.plaidTx.amount).toFixed(2)}
                  </span>
                  <span className="plaid-tx-bank">{row.plaidTx.institution_name}</span>
                </div>

                {/* JE narration & type */}
                <div className="plaid-je-meta">
                  <select
                    value={row.voucherType}
                    onChange={(e) => updateRow(idx, { voucherType: e.target.value })}
                    disabled={row.alreadyImported}
                  >
                    {["Receipt", "Payment", "Journal", "Contra"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={row.narration}
                    onChange={(e) => updateRow(idx, { narration: e.target.value })}
                    placeholder="Narration"
                    disabled={row.alreadyImported}
                  />
                  {row.confidence >= 0.8 && !row.alreadyImported && (
                    <span className="plaid-confidence-badge">auto</span>
                  )}
                  {row.source === "household" && !row.alreadyImported && (
                    <span className="plaid-household-badge">household</span>
                  )}
                  {row.confidence === 0 && !row.alreadyImported && (
                    <span className="plaid-unmatched-badge">needs accounts</span>
                  )}
                  {row.alreadyImported && <span className="plaid-exists-badge">in vault</span>}
                </div>

                {/* JE entries */}
                {!row.alreadyImported && (
                  <div className="plaid-entries">
                    {row.entries.map((e, ei) => (
                      <div key={ei} className="plaid-entry-line">
                        <span className={e.amount < 0 ? "plaid-dr" : "plaid-cr"}>{e.amount < 0 ? "Dr" : "Cr"}</span>
                        <select
                          value={e.accountId}
                          onChange={(ev) => {
                            const acc = data.accounts.find((a) => a.id === +ev.target.value);
                            if (acc) updateEntry(idx, ei, { accountId: acc.id, accountName: acc.name });
                          }}
                        >
                          {data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                            <option value={a.id} key={a.id}>{a.name}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={Math.abs(e.amount).toFixed(2)}
                          onChange={(ev) => {
                            const abs = Math.abs(+ev.target.value);
                            updateEntry(idx, ei, { amount: e.amount < 0 ? -abs : abs });
                          }}
                        />
                      </div>
                    ))}
                    {row.entries.length === 0 && (
                      <button
                        type="button"
                        className="plaid-add-entries-btn"
                        onClick={() => updateRow(idx, { entries: blankEntryPair(row) })}
                      >
                        + Select accounts manually
                      </button>
                    )}
                    {/* Already Posted? link */}
                    <button
                      className="plaid-already-posted-btn"
                      onClick={() => {
                        setPickerRowIdx(pickerRowIdx === idx ? null : idx);
                        setPickerSearch("");
                      }}
                    >
                      {pickerRowIdx === idx ? "✕ Cancel" : "Already posted?"}
                    </button>
                    {row.dupBlocked && !row.forceSave && (
                      <div className="plaid-dup-blocked-banner">
                        <span>Blocked — matches a vault voucher with the same amount, accounts, and a nearby date.</span>
                        <button
                          type="button"
                          className="plaid-force-save-btn"
                          onClick={() => updateRow(idx, { forceSave: true, dupBlocked: false })}
                        >
                          Not a duplicate — save anyway
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Inline vault voucher picker */}
                {pickerRowIdx === idx && !row.alreadyImported && (() => {
                  const txMs = new Date(row.plaidTx.date + "T12:00:00Z").getTime();
                  const txAmt = Math.abs(row.plaidTx.amount);
                  const search = pickerSearch.toLowerCase();
                  const vouchers = data.transactions
                    .filter((v) => {
                      if (v.deleted) return false;
                      const vMs = new Date(v.date + "T12:00:00Z").getTime();
                      if (Math.abs(txMs - vMs) / 86400000 > 60) return false;
                      if (!search) return true;
                      const narr = (v.narration || "").toLowerCase();
                      const amt = String(Math.abs(v.entries?.find((e) => e.amount < 0)?.amount || 0));
                      return narr.includes(search) || amt.includes(search);
                    })
                    .sort((a, b) => {
                      const aMs = new Date(a.date + "T12:00:00Z").getTime();
                      const bMs = new Date(b.date + "T12:00:00Z").getTime();
                      const aAmt = Math.abs(a.entries?.find((e) => e.amount < 0)?.amount || 0);
                      const bAmt = Math.abs(b.entries?.find((e) => e.amount < 0)?.amount || 0);
                      return (Math.abs(txMs - aMs) / 86400000 + Math.abs(aAmt - txAmt) * 0.5)
                           - (Math.abs(txMs - bMs) / 86400000 + Math.abs(bAmt - txAmt) * 0.5);
                    })
                    .slice(0, 25);
                  return (
                    <div className="plaid-picker-panel">
                      <div className="plaid-picker-header">
                        <span>Select the vault voucher this transaction was already posted as:</span>
                        <input
                          className="plaid-picker-search"
                          placeholder="Search by narration or amount…"
                          value={pickerSearch}
                          onChange={(e) => setPickerSearch(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="plaid-picker-list">
                        {vouchers.length === 0 && <div className="plaid-picker-empty">No matching vouchers found</div>}
                        {vouchers.map((v) => {
                          const drEntry = v.entries?.find((e) => e.amount < 0);
                          const crEntry = v.entries?.find((e) => e.amount > 0);
                          const drName = data.accounts.find((a) => a.id === drEntry?.accountId)?.name || "—";
                          const crName = data.accounts.find((a) => a.id === crEntry?.accountId)?.name || "—";
                          const debitAmt = Math.abs(drEntry?.amount || 0);
                          const [y, m, d] = v.date.split("-");
                          return (
                            <div key={v.id} className="plaid-picker-item" onClick={() => confirmMatch(idx, v)}>
                              <span className="plaid-picker-date">{d}-{m}-{y}</span>
                              <span className="plaid-picker-type">{v.type}</span>
                              <span className="plaid-picker-narr">
                                <span className="plaid-picker-narr-text">{v.narration || "—"}</span>
                                <span className="plaid-picker-gl">
                                  <span className="plaid-picker-dr">Dr: {drName}</span>
                                  <span className="plaid-picker-sep"> / </span>
                                  <span className="plaid-picker-cr">Cr: {crName}</span>
                                </span>
                              </span>
                              <span className="plaid-picker-amt">${debitAmt.toFixed(2)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Pending transactions — importable queue */}
      {activeTab === "pending" && (
        <div className="plaid-pending-section">
          {pendingRows.length === 0 ? (
            <div className="plaid-pending-empty">No pending transactions from Plaid. Fetch transactions first.</div>
          ) : (
            <>
              <div className="plaid-queue-toolbar">
                <span>{pendingRows.filter((r) => !r.alreadyImported && !r.skip).length} to import · {pendingRows.filter((r) => r.alreadyImported).length} saved</span>
                <label>
                  <input type="checkbox" checked={hideInVault} onChange={(e) => setHideInVault(e.target.checked)} />
                  Hide "in vault"
                </label>
                <label>
                  <input type="checkbox" onChange={(e) => setPendingRows((rs) => rs.map((r) => ({ ...r, skip: r.alreadyImported ? true : e.target.checked })))} />
                  Skip all
                </label>
                <button className="plaid-save-btn" onClick={savePendingSelected} disabled={savingPending || !pendingRows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2).length}>
                  {savingPending ? "Saving…" : `Save ${pendingRows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2).length} pending`}
                </button>
              </div>
              <div className="plaid-pending-bofa-note">
                Post pending charges now — edit the voucher if the settled amount differs. BofA checking "Processing" items (Zelle, ACH, payroll) are not returned by Plaid — use the Manual Pending section below.
              </div>
              <div className="plaid-queue">
                {pendingRows.map((row, idx) => hideInVault && row.alreadyImported ? null : (
                  <div
                    key={row.plaidTx.transaction_id}
                    className={[
                      "plaid-queue-row",
                      row.alreadyImported ? "plaid-row-exists" : "",
                      row.skip && !row.alreadyImported ? "plaid-row-skipped" : "",
                      row.confidence >= 0.8 ? "plaid-row-confident" : row.confidence === 0 ? "plaid-row-unmatched" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={row.skip || row.alreadyImported}
                      disabled={row.alreadyImported}
                      onChange={(e) => updatePendingRow(idx, { skip: e.target.checked })}
                      title={row.alreadyImported ? "Already saved" : "Skip"}
                    />
                    <div className="plaid-tx-info">
                      <span className="plaid-tx-date">{fmtDate(row.plaidTx.date)}</span>
                      <span className="plaid-tx-name">
                        <span className="plaid-pending-badge-sm">PND</span>
                        {row.plaidTx.name}
                      </span>
                      <span className={`plaid-tx-amt ${row.plaidTx.amount < 0 ? "credit" : "debit"}`}>
                        {row.plaidTx.amount < 0 ? "+" : "−"}${Math.abs(row.plaidTx.amount).toFixed(2)}
                      </span>
                      <span className="plaid-tx-bank">{row.plaidTx.institution_name}</span>
                    </div>
                    <div className="plaid-je-meta">
                      <select
                        value={row.voucherType}
                        onChange={(e) => updatePendingRow(idx, { voucherType: e.target.value })}
                        disabled={row.alreadyImported}
                      >
                        {["Receipt", "Payment", "Journal", "Contra"].map((t) => <option key={t}>{t}</option>)}
                      </select>
                      <input
                        type="text"
                        value={row.narration}
                        onChange={(e) => updatePendingRow(idx, { narration: e.target.value })}
                        placeholder="Narration"
                        disabled={row.alreadyImported}
                      />
                      {row.alreadyImported && (
                        <>
                          <span className="plaid-exists-badge">saved</span>
                          <button
                            type="button"
                            className="plaid-undo-match-btn"
                            title="Not actually already posted — reopen for import"
                            onClick={() => undoPendingMatch(idx)}
                          >
                            ✕ Undo match
                          </button>
                        </>
                      )}
                    </div>
                    {!row.alreadyImported && (
                      <div className="plaid-entries">
                        {row.entries.map((e, ei) => (
                          <div key={ei} className="plaid-entry-line">
                            <span className={e.amount < 0 ? "plaid-dr" : "plaid-cr"}>{e.amount < 0 ? "Dr" : "Cr"}</span>
                            <select
                              value={e.accountId}
                              onChange={(ev) => {
                                const acc = data.accounts.find((a) => a.id === +ev.target.value);
                                if (acc) updatePendingEntry(idx, ei, { accountId: acc.id, accountName: acc.name });
                              }}
                            >
                              {data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                                <option value={a.id} key={a.id}>{a.name}</option>
                              ))}
                            </select>
                            <input
                              type="number" step="0.01" min="0"
                              value={Math.abs(e.amount).toFixed(2)}
                              onChange={(ev) => {
                                const abs = Math.abs(+ev.target.value);
                                updatePendingEntry(idx, ei, { amount: e.amount < 0 ? -abs : abs });
                              }}
                            />
                          </div>
                        ))}
                        {row.entries.length === 0 && (
                          <button
                            type="button"
                            className="plaid-add-entries-btn"
                            onClick={() => updatePendingRow(idx, { entries: blankEntryPair(row) })}
                          >
                            + Select accounts manually
                          </button>
                        )}
                        {/* Already Posted? link */}
                        <button
                          className="plaid-already-posted-btn"
                          onClick={() => {
                            setPendingPickerRowIdx(pendingPickerRowIdx === idx ? null : idx);
                            setPendingPickerSearch("");
                          }}
                        >
                          {pendingPickerRowIdx === idx ? "✕ Cancel" : "Already posted?"}
                        </button>
                        {row.dupBlocked && !row.forceSave && (
                          <div className="plaid-dup-blocked-banner">
                            <span>Blocked — matches a vault voucher with the same amount, accounts, and a nearby date.</span>
                            <button
                              type="button"
                              className="plaid-force-save-btn"
                              onClick={() => updatePendingRow(idx, { forceSave: true, dupBlocked: false })}
                            >
                              Not a duplicate — save anyway
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Inline vault voucher picker */}
                    {pendingPickerRowIdx === idx && !row.alreadyImported && (() => {
                      const txMs = new Date(row.plaidTx.date + "T12:00:00Z").getTime();
                      const txAmt = Math.abs(row.plaidTx.amount);
                      const search = pendingPickerSearch.toLowerCase();
                      const vouchers = data.transactions
                        .filter((v) => {
                          if (v.deleted) return false;
                          const vMs = new Date(v.date + "T12:00:00Z").getTime();
                          if (Math.abs(txMs - vMs) / 86400000 > 60) return false;
                          if (!search) return true;
                          const narr = (v.narration || "").toLowerCase();
                          const amt = String(Math.abs(v.entries?.find((e) => e.amount < 0)?.amount || 0));
                          return narr.includes(search) || amt.includes(search);
                        })
                        .sort((a, b) => {
                          const aMs = new Date(a.date + "T12:00:00Z").getTime();
                          const bMs = new Date(b.date + "T12:00:00Z").getTime();
                          const aAmt = Math.abs(a.entries?.find((e) => e.amount < 0)?.amount || 0);
                          const bAmt = Math.abs(b.entries?.find((e) => e.amount < 0)?.amount || 0);
                          return (Math.abs(txMs - aMs) / 86400000 + Math.abs(aAmt - txAmt) * 0.5)
                               - (Math.abs(txMs - bMs) / 86400000 + Math.abs(bAmt - txAmt) * 0.5);
                        })
                        .slice(0, 25);
                      return (
                        <div className="plaid-picker-panel">
                          <div className="plaid-picker-header">
                            <span>Select the vault voucher this transaction was already posted as:</span>
                            <input
                              className="plaid-picker-search"
                              placeholder="Search by narration or amount…"
                              value={pendingPickerSearch}
                              onChange={(e) => setPendingPickerSearch(e.target.value)}
                              autoFocus
                            />
                          </div>
                          <div className="plaid-picker-list">
                            {vouchers.length === 0 && <div className="plaid-picker-empty">No matching vouchers found</div>}
                            {vouchers.map((v) => {
                              const drEntry = v.entries?.find((e) => e.amount < 0);
                              const crEntry = v.entries?.find((e) => e.amount > 0);
                              const drName = data.accounts.find((a) => a.id === drEntry?.accountId)?.name || "—";
                              const crName = data.accounts.find((a) => a.id === crEntry?.accountId)?.name || "—";
                              const debitAmt = Math.abs(drEntry?.amount || 0);
                              const [y, m, d] = v.date.split("-");
                              return (
                                <div key={v.id} className="plaid-picker-item" onClick={() => confirmPendingMatch(idx, v)}>
                                  <span className="plaid-picker-date">{d}-{m}-{y}</span>
                                  <span className="plaid-picker-type">{v.type}</span>
                                  <span className="plaid-picker-narr">
                                    <span className="plaid-picker-narr-text">{v.narration || "—"}</span>
                                    <span className="plaid-picker-gl">
                                      <span className="plaid-picker-dr">Dr: {drName}</span>
                                      <span className="plaid-picker-sep"> / </span>
                                      <span className="plaid-picker-cr">Cr: {crName}</span>
                                    </span>
                                  </span>
                                  <span className="plaid-picker-amt">${debitAmt.toFixed(2)}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            </>
          )}
          {/* Manual Pending — BofA "Processing" items Plaid doesn't surface */}
          {(() => {
            const manualEntries = data.transactions.filter(
              (v) => !v.deleted && !v.cancelled && v.syncStatus === "manual-pending"
            );
            return (
              <div className="plaid-manual-pending">
                <div className="plaid-manual-pending-hdr">
                  <span className="plaid-manual-pending-title">Manual Pending</span>
                  <span className="plaid-pending-bofa-note" style={{ flex: 1 }}>
                    BofA "Processing" items (Zelle, ACH, payroll) are not returned by Plaid — enter them here to post to vault
                  </span>
                  <button className="plaid-add-manual-btn" onClick={() => setShowManualForm((v) => !v)}>
                    {showManualForm ? "✕ Cancel" : "+ Add"}
                  </button>
                </div>
                {showManualForm && (
                  <div className="plaid-manual-form">
                    <input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} />
                    <input type="text" placeholder="Description (e.g. Rent, Zelle payment)" value={manualName} onChange={(e) => setManualName(e.target.value)} />
                    <input type="number" step="0.01" min="0.01" placeholder="Amount" value={manualAmt} onChange={(e) => setManualAmt(e.target.value)} />
                    <select value={manualDrId} onChange={(e) => setManualDrId(+e.target.value)}>
                      <option value={0}>Dr — Expense account</option>
                      {data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <select value={manualCrId} onChange={(e) => setManualCrId(+e.target.value)}>
                      <option value={0}>Cr — Bank account</option>
                      {data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <button className="plaid-save-btn" onClick={saveManualPending} disabled={savingManual}>
                      {savingManual ? "Saving…" : "Save Entry"}
                    </button>
                  </div>
                )}
                {manualEntries.length > 0 && (
                  <div className="plaid-queue">
                    {manualEntries.map((v) => {
                      const dr = v.entries.find((e) => e.amount < 0);
                      const cr = v.entries.find((e) => e.amount > 0);
                      const amt = dr ? Math.abs(dr.amount) : 0;
                      return (
                        <div key={v.guid} className="plaid-queue-row plaid-row-exists">
                          <span />
                          <div className="plaid-tx-info">
                            <span className="plaid-tx-date">{fmtDate(v.date)}</span>
                            <span className="plaid-tx-name">
                              <span className="plaid-pending-badge-sm">MNL</span>{v.narration}
                            </span>
                            <span className="plaid-tx-amt debit">−${amt.toFixed(2)}</span>
                          </div>
                          <div className="plaid-je-meta">
                            <span className="plaid-exists-badge">manual · posted to vault</span>
                          </div>
                          <div className="plaid-entries">
                            <div className="plaid-entry-line">
                              <span className="plaid-dr">Dr</span><span>{dr?.accountName}</span>
                            </div>
                            <div className="plaid-entry-line">
                              <span className="plaid-cr">Cr</span><span>{cr?.accountName}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {manualEntries.length === 0 && !showManualForm && (
                  <div className="plaid-pending-empty" style={{ textAlign: "left", padding: "6px 0" }}>
                    No manual entries yet — click + Add to post a BofA processing item.
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Balance reconciliation */}
      {activeTab === "balances" && (
        <div className="plaid-recon-section">
          {plaidAccounts.length === 0 ? (
            <div className="plaid-pending-empty">No account data yet. Fetch transactions first.</div>
          ) : (
            <>
              <table className="plaid-recon-table">
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Account</th>
                    <th>Type</th>
                    <th>Plaid Balance</th>
                    <th>Uncleared</th>
                    <th>Vault Balance</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const vaultAccs = data.accounts.filter((a) => a.active !== false);
                    // Sum pending amounts per plaid account_id (Plaid: positive = charge out)
                    const pendingByAcctId = new Map<string, number>();
                    for (const tx of pendingTxs) {
                      pendingByAcctId.set(tx.account_id, (pendingByAcctId.get(tx.account_id) || 0) + tx.amount);
                    }

                    // One row per physical Plaid account, always -- never merged, even when two
                    // physical accounts (e.g. two BofA credit cards, one per spouse) map to the
                    // same GL account. Each keeps its own real Plaid balance/pending; only the
                    // Vault Balance side needs to be split further below, since the ledger itself
                    // doesn't distinguish which card a transaction came from -- that split is done
                    // by proportional allocation against each card's own Plaid balance share (see
                    // plaidBalSumByVaultId below), not per-transaction attribution.
                    const groups: Array<{
                      vaultAcct: Account | undefined;
                      institutions: string[];
                      names: string[];
                      types: string[];
                      plaidBal: number | null;
                      plaidType: string;
                      pendingSum: number;
                      plaidAccts: PlaidAccount[];
                    }> = [];

                    for (const acct of plaidAccounts) {
                      const vaultAcct = matchVaultAccount(acct, vaultAccs);
                      // Depository: use available (excludes pending holds); credit: use current (includes pending charges)
                      const bal = acct.type === "depository"
                        ? (acct.balances?.available ?? acct.balances?.current ?? null)
                        : (acct.balances?.current ?? null);
                      const inst = acct.institution_name || "—";
                      const pending = pendingByAcctId.get(acct.account_id) ?? 0;
                      groups.push({
                        vaultAcct,
                        institutions: [inst],
                        names: [acct.name],
                        types: [acct.subtype || acct.type],
                        plaidBal: bal,
                        plaidType: acct.type,
                        pendingSum: pending,
                        plaidAccts: [acct],
                      });
                    }
                    // How many physical Plaid accounts share each GL account -- >1 means the Vault
                    // Balance column below has to be split across them, not shown as the full
                    // total on every row. There's no way to know which specific transaction
                    // belongs to which physical card once they're posted to one shared GL account
                    // (and no interest in tracking that going forward either) -- so instead of
                    // attributing individual entries, the one real vault balance is allocated
                    // proportionally to each card's own share of the combined Plaid balance. This
                    // always sums to the exact real total (see the Total row) with no leftover
                    // bucket needed; it's an estimate for each individual row, not a hard fact.
                    const vaultIdShareCount = new Map<number, number>();
                    const plaidBalSumByVaultId = new Map<number, number>();
                    // If ANY member sharing a GL account has a null Plaid balance (a failed
                    // fetch, not a real $0), the whole group falls back to an even split rather
                    // than a proportional one -- otherwise that member's $0-via-null contribution
                    // to plaidBalSumByVaultId would silently push 100%+ of the real total onto
                    // the OTHER member(s), and the individual rows would stop summing to the
                    // group's real total (the one invariant this allocation is supposed to keep).
                    const hasNullBalanceByVaultId = new Map<number, boolean>();
                    for (const g of groups) {
                      if (!g.vaultAcct) continue;
                      vaultIdShareCount.set(g.vaultAcct.id, (vaultIdShareCount.get(g.vaultAcct.id) ?? 0) + 1);
                      plaidBalSumByVaultId.set(g.vaultAcct.id, (plaidBalSumByVaultId.get(g.vaultAcct.id) ?? 0) + (g.plaidBal ?? 0));
                      if (g.plaidBal === null) hasNullBalanceByVaultId.set(g.vaultAcct.id, true);
                    }

                    // Fixed display order: BofA → Citi → AMEX → Chase → Fidelity → Merrill → others;
                    // depository before credit within each institution, and within Fidelity
                    // specifically HSA (real ledger, reconciles) before the 401(k) (no vault match,
                    // valued live elsewhere instead -- see subtypeRank below).
                    const instRank = (inst: string) => {
                      if (/bank.of.america|bofa/i.test(inst)) return 0;
                      if (/citi(?!zen)/i.test(inst)) return 1;
                      if (/american express|amex/i.test(inst)) return 2;
                      if (/chase/i.test(inst)) return 3;
                      if (/wells.fargo/i.test(inst)) return 4;
                      if (/fidelity/i.test(inst)) return 5;
                      if (/merrill/i.test(inst)) return 6;
                      return 99;
                    };
                    const typeRank = (t: string) => t === "depository" ? 0 : t === "credit" ? 1 : 2;
                    const subtypeRank = (t: string) => t === "hsa" ? 0 : t === "401k" ? 1 : t === "ira" ? 2 : 5;
                    groups.sort((a, b) => {
                      const iA = instRank(a.institutions[0] || "");
                      const iB = instRank(b.institutions[0] || "");
                      if (iA !== iB) return iA - iB;
                      const tA = typeRank(a.plaidType);
                      const tB = typeRank(b.plaidType);
                      if (tA !== tB) return tA - tB;
                      const sA = subtypeRank(a.types[0] || "");
                      const sB = subtypeRank(b.types[0] || "");
                      if (sA !== sB) return sA - sB;
                      return (a.vaultAcct?.name || "").localeCompare(b.vaultAcct?.name || "");
                    });

                    // Captured per-row so a "Total" row can sum the ALREADY correctly-signed
                    // per-card figures (refunds/credits netted against charges exactly the same
                    // way every other card's own row already computes it) for shared GL accounts.
                    const rowSummaries: Array<{ vaultAcctId: number | undefined; plaidBal: number | null; uncleared: number }> = [];
                    // Column totals for the footer row -- "liquidity coming through Plaid" at a
                    // glance. Vault Balance mirrors the Plaid balance for accounts with no vault
                    // ledger match (401k/IRA tracked live via Plaid only, never booked as vault
                    // vouchers) so the total isn't silently missing real liquidity just because
                    // there's nothing to reconcile it against.
                    const columnTotals = { plaid: 0, uncleared: 0, vault: 0 };
                    const realRows = groups.map((g, i) => {
                      // Shared: >1 physical Plaid account posts to this same GL account. There's
                      // no per-transaction attribution (see the comment on plaidBalSumByVaultId
                      // above), so this row's slice of the one real vault balance is allocated
                      // proportionally to its own share of the combined Plaid balance.
                      const shared = !!g.vaultAcct && (vaultIdShareCount.get(g.vaultAcct.id) ?? 0) > 1;
                      const vaultBal = !g.vaultAcct
                        ? null
                        : !shared
                          ? vaultBookBalance(g.vaultAcct.id, g.plaidType, data)
                          : (() => {
                              const total = vaultBookBalance(g.vaultAcct!.id, g.plaidType, data);
                              const plaidSum = plaidBalSumByVaultId.get(g.vaultAcct!.id) ?? 0;
                              // Degenerate cases -- split evenly instead of producing a silently
                              // misleading allocation: (a) any member of this group has a null
                              // Plaid balance (a failed fetch, not a real $0) -- see
                              // hasNullBalanceByVaultId above; (b) the combined Plaid balance
                              // nets to ~0, which would otherwise divide by ~0.
                              return hasNullBalanceByVaultId.get(g.vaultAcct!.id) || Math.abs(plaidSum) < 0.01
                                ? total / (vaultIdShareCount.get(g.vaultAcct!.id) ?? 1)
                                : total * ((g.plaidBal ?? 0) / plaidSum);
                            })();
                      const acctIdSet = new Set(g.plaidAccts.map((a) => a.account_id));

                      // Drill-down: identify which transactions explain the gap
                      const plaidTxsForGroup = [
                        ...rows.filter((r) => acctIdSet.has(r.plaidTx.account_id)),
                        ...pendingRows.filter((r) => acctIdSet.has(r.plaidTx.account_id)),
                      ].sort((a, b) => b.plaidTx.date.localeCompare(a.plaidTx.date));

                      // Vault entries for this account (last 90 days to cover Plaid window) --
                      // shown in full on every row sharing this GL account, since there's no real
                      // per-transaction split (the Vault Balance above is an allocated estimate,
                      // not a claim about which specific entries belong to this card). Excludes
                      // one-time "balance sync"/opening-load vouchers -- these represent a starting
                      // balance, not a real transaction, so they will NEVER have a matching Plaid
                      // entry no matter how long the reconciliation waits; without this they'd
                      // permanently show as an unexplained "Uncleared"/"no Plaid match" gap.
                      const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
                      const isBalanceSyncNarration = (n: string) => /balance\s*sync/i.test(n);
                      const recentVaultEntries = g.vaultAcct
                        ? data.transactions
                            .filter((v) => !v.deleted && !v.cancelled && v.date >= cutoff90 && !isBalanceSyncNarration(v.narration || ""))
                            .flatMap((v) =>
                              v.entries
                                .filter((e) => e.accountId === g.vaultAcct!.id)
                                .map((e) => ({ date: v.date, narration: v.narration ?? "", type: v.type, amount: e.amount, guid: v.guid }))
                            )
                            .sort((a, b) => b.date.localeCompare(a.date))
                        : [];

                      // Match vault entries against Plaid transactions (amount ±$0.05, date ±3 days)
                      // For credit cards: charge = positive on both Plaid and vault Cr entry
                      // For depository: deposit = negative on both Plaid and vault Dr entry
                      const usedPlaidForMatch = new Set<number>();
                      const matchedVaultIdx = new Set<number>();
                      const matchedPairs: { vi: number; pi: number }[] = [];
                      recentVaultEntries.forEach((ve, vi) => {
                        const vMs = new Date(ve.date + "T12:00:00Z").getTime();
                        plaidTxsForGroup.forEach((pr, pi) => {
                          if (matchedVaultIdx.has(vi) || usedPlaidForMatch.has(pi)) return;
                          const pMs = new Date(pr.plaidTx.date + "T12:00:00Z").getTime();
                          if (
                            Math.abs(pMs - vMs) / 86400000 <= 3 &&
                            Math.abs(pr.plaidTx.amount - ve.amount) < 0.05
                          ) {
                            matchedVaultIdx.add(vi);
                            usedPlaidForMatch.add(pi);
                            matchedPairs.push({ vi, pi });
                          }
                        });
                      });

                      // Unmatched settled transactions — Plaid pending are shown in Uncleared column, not here
                      const notInVault = plaidTxsForGroup.filter((r) => !r.alreadyImported && !r.plaidTx.pending);

                      // Investment accounts (401k/HSA/IRA) — Plaid has no "pending" concept here at
                      // all (confirmed directly: a Fidelity debit-card charge still "Processing"
                      // simply never appears in /investments/transactions/get), so plaidTxsForGroup
                      // is always empty for these and the credit-card matching above can't run.
                      // Match vault entries against Plaid's investment transaction feed instead —
                      // same amount/date matching as above, just a separate list and no negation
                      // needed (Plaid's investment amount sign already matches the vault's stored
                      // sign: a withdrawal is positive on both sides).
                      const investmentTxsForGroup = investmentTxs.filter((t) => acctIdSet.has(t.account_id));
                      const matchedAgainstInvestment = new Set<number>();
                      const matchedInvestmentTxId = new Map<number, string>();
                      if (g.plaidType === "investment") {
                        const usedInvestmentTxIdx = new Set<number>();
                        recentVaultEntries.forEach((ve, vi) => {
                          const vMs = new Date(ve.date + "T12:00:00Z").getTime();
                          const ti = investmentTxsForGroup.findIndex(
                            (t, idx) =>
                              !usedInvestmentTxIdx.has(idx) &&
                              Math.abs(new Date(t.date + "T12:00:00Z").getTime() - vMs) / 86400000 <= 5 &&
                              Math.abs(t.amount - ve.amount) < 0.05 &&
                              // A user-rejected pairing always stays uncleared, regardless of what the
                              // amount/date heuristic would otherwise conclude for THIS Plaid transaction
                              // -- see investmentMatchOverrides for why (same-amount coincidences at
                              // recurring merchants like a pharmacy can false-positive). A different,
                              // later Plaid transaction for the same voucher can still match.
                              !investmentMatchOverrides.has(`${ve.guid}|${t.investment_transaction_id}`)
                          );
                          if (ti !== -1) {
                            matchedAgainstInvestment.add(vi);
                            matchedInvestmentTxId.set(vi, investmentTxsForGroup[ti].investment_transaction_id);
                            usedInvestmentTxIdx.add(ti);
                          }
                        });
                      }
                      // Drilldown display only -- combines both matching passes so this panel
                      // agrees with whichever one actually ran for this account's Plaid type.
                      const onlyInVault = recentVaultEntries.filter(
                        (_, vi) => !matchedVaultIdx.has(vi) && !matchedAgainstInvestment.has(vi)
                      );

                      // Credit cards — Plaid current balance behaviour. Everything pending that Plaid's
                      // current balance hasn't caught up on yet folds into ONE "Uncleared" figure, per
                      // Difference = Plaid − Vault + Uncleared:
                      //   Not yet posted to vault (charge or merchant credit, not a payment): use the raw
                      //     Plaid amount — neither side reflects it yet, so this "pre-applies" it the way
                      //     it will look once posted.
                      //   Already matched to a vault entry (charge, credit, OR payment): use the vault
                      //     entry's own signed amount instead of the raw Plaid amount — this correctly
                      //     handles BofA's double-reported card payments, where Plaid reports the same
                      //     transfer from two accounts but only one leg (the Contra voucher) ever reaches
                      //     the vault.
                      // Depository: uses `available` (excludes holds) → no adjustment.
                      const matchedTxIds = new Set(
                        matchedPairs.map(({ pi }) => plaidTxsForGroup[pi].plaidTx.transaction_id)
                      );
                      type UnclearedItem = { date: string; name: string; amount: number; matched: boolean };
                      const unclearedItems: UnclearedItem[] =
                        g.plaidType === "credit"
                          ? [
                              ...(() => {
                                const pendingMatches = matchedPairs.filter(({ pi }) => plaidTxsForGroup[pi].plaidTx.pending);
                                // Whether a pending bill PAYMENT is already reflected in the issuer's running
                                // "current balance" or not is genuinely issuer-dependent -- confirmed directly
                                // both ways on the same day (Citi: balance already dropped by the full payment
                                // while the transaction still said pending; AMEX: name/category matched
                                // isCardPayment's loose heuristic on what was actually a regular +$51 CHARGE --
                                // a real bill payment can only ever be a Dr/balance-reducing entry in this
                                // app's sign convention, never a Cr, so that alone was a false positive). So
                                // this can't be a blanket rule; only genuine Dr candidates (isCardPayment AND
                                // balance-reducing) are even considered, and each is kept out of Uncleared only
                                // if doing so actually brings this group's own diff closer to zero -- an
                                // empirical, per-item decision, not a name/category guess.
                                const chargeItems = pendingMatches
                                  .filter(({ vi, pi }) => !(isCardPayment(plaidTxsForGroup[pi].plaidTx) && recentVaultEntries[vi].amount < 0))
                                  .map(({ vi, pi }) => ({
                                    date: plaidTxsForGroup[pi].plaidTx.date,
                                    name: plaidTxsForGroup[pi].plaidTx.name,
                                    amount: recentVaultEntries[vi].amount,
                                    matched: true,
                                  }));
                                const paymentCandidates = pendingMatches.filter(
                                  ({ vi, pi }) => isCardPayment(plaidTxsForGroup[pi].plaidTx) && recentVaultEntries[vi].amount < 0
                                );
                                const rawGap = (g.plaidBal ?? 0) - (vaultBal ?? 0);
                                const baseline = rawGap + chargeItems.reduce((s, u) => s + u.amount, 0);
                                const includedPayments = paymentCandidates
                                  .filter(({ vi }) => Math.abs(baseline + recentVaultEntries[vi].amount) < Math.abs(baseline))
                                  .map(({ vi, pi }) => ({
                                    date: plaidTxsForGroup[pi].plaidTx.date,
                                    name: plaidTxsForGroup[pi].plaidTx.name,
                                    amount: recentVaultEntries[vi].amount,
                                    matched: true,
                                  }));
                                return [...chargeItems, ...includedPayments];
                              })(),
                              ...pendingTxs
                                .filter((tx) =>
                                  acctIdSet.has(tx.account_id) &&
                                  !matchedTxIds.has(tx.transaction_id) &&
                                  (tx.amount > 0 || !isCardPayment(tx))
                                )
                                .map((tx) => ({ date: tx.date, name: tx.name, amount: tx.amount, matched: false })),
                            ]
                          : g.plaidType === "investment"
                            ? recentVaultEntries
                                .map((ve, vi) => ({ ve, vi }))
                                .filter(({ vi }) => !matchedAgainstInvestment.has(vi))
                                // Negated: the vault already reflects this decrease (an asset account,
                                // opposite convention from a credit card's balance-owed), so Plaid − Vault
                                // alone already shows the full gap -- subtracting it back out here (a
                                // negative Uncleared contribution) is what brings diff to ~0 once Plaid
                                // catches up, instead of double-counting it.
                                .map(({ ve }) => ({ date: ve.date, name: ve.narration || ve.type, amount: -ve.amount, matched: true }))
                            : g.plaidType === "depository"
                              ? (() => {
                                  // A bank→credit-card payment isn't instant -- the bank doesn't actually
                                  // debit checking for 1-3 business days, so Plaid's `available` balance
                                  // correctly still includes it while the vault (correctly) already recorded
                                  // the Contra voucher on the day it was initiated. Plaid exposes no
                                  // "pending withdrawal" signal for this the way it does for card charges
                                  // (same BofA limitation as the Manual Pending section), so the vault's own
                                  // Contra voucher is the only available signal. Capped to 7 days so a
                                  // still-unmatched Contra past that window surfaces as a real diff to
                                  // investigate instead of being silently absorbed forever.
                                  const contraCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
                                  return recentVaultEntries
                                    .map((ve, vi) => ({ ve, vi }))
                                    .filter(({ ve, vi }) => !matchedVaultIdx.has(vi) && ve.type.toLowerCase() === "contra" && ve.date >= contraCutoff)
                                    .map(({ ve }) => ({ date: ve.date, name: ve.narration || ve.type, amount: -ve.amount, matched: true }));
                                })()
                              : [];
                      // Investment entries the amount/date heuristic auto-matched to a settled Plaid
                      // transaction -- shown separately (not folded into Uncleared) with a one-click
                      // way to reject a wrong match, since there's no stronger signal available to
                      // tell two same-amount charges at a recurring merchant apart automatically.
                      const investmentMatchedEntries =
                        g.plaidType === "investment"
                          ? recentVaultEntries
                              .map((ve, vi) => ({ ve, vi }))
                              .filter(({ vi }) => matchedAgainstInvestment.has(vi))
                              .map(({ ve, vi }) => ({ ve, plaidTxId: matchedInvestmentTxId.get(vi)! }))
                          : [];
                      const uncleared = unclearedItems.reduce((s, u) => s + u.amount, 0);
                      const diff = g.plaidBal !== null && vaultBal !== null
                        ? g.plaidBal - vaultBal + uncleared
                        : null;
                      rowSummaries.push({ vaultAcctId: g.vaultAcct?.id, plaidBal: g.plaidBal, uncleared });
                      const pendingClearingTotal = unclearedItems.reduce((s, u) => s + Math.abs(u.amount), 0);
                      const balanced = diff !== null && Math.abs(diff) < 1;
                      const isExpanded = expandedReconIdx === i;
                      const isUnclearedExpanded = expandedUnclearedIdx === i;

                      // Net contribution of each side to the difference (Plaid − Vault) from settled,
                      // non-pending transactions only — for the "In Plaid, not in vault" / "In vault, no
                      // Plaid match" columns above. Purely diagnostic (candidate causes to review) — not
                      // arithmetic that needs subtracting from diff, since diff (Plaid balance − Vault
                      // balance + Uncleared) is already the complete, self-contained figure.
                      const plaidOnlyNet = notInVault.reduce((s, r) => s + r.plaidTx.amount, 0);
                      const vaultOnlyNet = onlyInVault.reduce((s, ve) => s + ve.amount, 0);
                      const rawGap = g.plaidBal !== null && vaultBal !== null ? g.plaidBal - vaultBal : null;

                      // No-vault-match display balance: mirrors Plaid's balance for the Vault
                      // Balance column/total only -- diff/reconciliation logic above is untouched
                      // and still correctly treats this as "nothing to reconcile", not a match.
                      const displayVaultBal = vaultBal !== null ? vaultBal : g.plaidBal;
                      if (g.plaidBal !== null) columnTotals.plaid += g.plaidBal;
                      if (unclearedItems.length > 0) columnTotals.uncleared += uncleared;
                      if (displayVaultBal !== null) columnTotals.vault += displayVaultBal;

                      return (
                        <React.Fragment key={i}>
                          <tr
                            className={`plaid-recon-row${!balanced && diff !== null ? " plaid-recon-clickable" : ""}`}
                            onClick={() => !balanced && diff !== null && setExpandedReconIdx(isExpanded ? null : i)}
                          >
                            <td>{g.institutions.join(", ")}</td>
                            <td title={g.vaultAcct ? `Vault: ${g.vaultAcct.name}` : "No matching vault account"}>
                              {g.names
                                .map((n, ni) => {
                                  const owner = bofaCardOwnerLabel(g.plaidAccts[ni]?.name || "");
                                  return owner ? `${n} - ${owner}` : n;
                                })
                                .join(" + ")}
                              {g.plaidType === "investment" && g.plaidAccts.some((a) => a.pricingAsOf) && (
                                <div className="plaid-recon-pricing-note">
                                  Priced as of {g.plaidAccts.find((a) => a.pricingAsOf)?.pricingAsOf}
                                </div>
                              )}
                            </td>
                            <td className="plaid-recon-type">{g.types.join(" / ")}</td>
                            <td className="plaid-recon-amt">{g.plaidBal !== null ? `$${g.plaidBal.toFixed(2)}` : "—"}</td>
                            <td
                              className={`plaid-recon-pending${unclearedItems.length > 0 || investmentMatchedEntries.length > 0 ? " plaid-recon-clickable" : ""}`}
                              onClick={() => (unclearedItems.length > 0 || investmentMatchedEntries.length > 0) && setExpandedUnclearedIdx(isUnclearedExpanded ? null : i)}
                              title={pendingClearingTotal > 0 ? `Net of ${unclearedItems.length} pending transaction(s) — $${pendingClearingTotal.toFixed(2)} gross before refunds/credits` : undefined}
                            >
                              {unclearedItems.length > 0
                                ? <>{`${uncleared >= 0 ? "+" : ""}$${uncleared.toFixed(2)}`}<span className="plaid-recon-expand-icon">{isUnclearedExpanded ? " ▲" : " ▼"}</span></>
                                : investmentMatchedEntries.length > 0
                                  ? <><span className="plaid-recon-zero">$0.00</span><span className="plaid-recon-expand-icon">{isUnclearedExpanded ? " ▲" : " ▼"}</span></>
                                  : <span className="plaid-recon-zero">—</span>}
                            </td>
                            <td className="plaid-recon-amt">
                              {vaultBal !== null ? (
                                `$${vaultBal.toFixed(2)}`
                              ) : displayVaultBal !== null ? (
                                <span className="plaid-recon-nomatch" title="No vault ledger for this account -- showing Plaid balance">
                                  ${displayVaultBal.toFixed(2)}
                                </span>
                              ) : (
                                <span className="plaid-recon-nomatch">no match</span>
                              )}
                            </td>
                            <td className={`plaid-recon-diff${diff !== null ? (balanced ? " good" : " bad") : ""}`}>
                              {diff !== null ? `${diff >= 0 ? "+" : ""}$${diff.toFixed(2)}` : "—"}
                              {!balanced && diff !== null && <span className="plaid-recon-expand-icon">{isExpanded ? " ▲" : " ▼"}</span>}
                            </td>
                          </tr>
                          {isUnclearedExpanded && (
                            <tr className="plaid-recon-detail-row">
                              <td colSpan={7}>
                                <div className="plaid-recon-detail">
                                  <div className="plaid-recon-detail-col">
                                    <div className="plaid-recon-detail-title">
                                      Pending at bank — {unclearedItems.length} transaction{unclearedItems.length !== 1 ? "s" : ""} Plaid's current balance doesn't reflect yet
                                      {pendingClearingTotal > 0 && (
                                        <span className="plaid-recon-detail-total debit">
                                          {" "}· ${pendingClearingTotal.toFixed(2)} gross, {uncleared >= 0 ? "+" : ""}${uncleared.toFixed(2)} net
                                        </span>
                                      )}
                                    </div>
                                    {unclearedItems.length === 0
                                      ? <div className="plaid-recon-detail-empty">No uncleared charges for this account.</div>
                                      : [...unclearedItems]
                                          .sort((a, b) => b.date.localeCompare(a.date))
                                          .map((u, j) => (
                                            <div key={j} className="plaid-recon-detail-item di-missing">
                                              <span className="di-date">{fmtDate(u.date)}</span>
                                              <span className="di-name">{u.name}</span>
                                              <span className={`di-amt ${u.amount < 0 ? "credit" : "debit"}`}>
                                                {u.amount < 0 ? "+" : "−"}${Math.abs(u.amount).toFixed(2)}
                                              </span>
                                              <span className="di-status">⏳ {u.matched ? "in vault, awaiting Plaid" : "not yet posted"}</span>
                                            </div>
                                          ))
                                    }
                                  </div>
                                  {investmentMatchedEntries.length > 0 && (
                                    <div className="plaid-recon-detail-col">
                                      <div className="plaid-recon-detail-title">
                                        Matched to Plaid — {investmentMatchedEntries.length} entr{investmentMatchedEntries.length !== 1 ? "ies" : "y"}
                                      </div>
                                      <p className="field-hint" style={{ margin: "0 0 6px" }}>
                                        Auto-matched by amount + date. Same-amount coincidence at a recurring
                                        merchant can false-positive — click ✕ if this isn't really the same charge.
                                      </p>
                                      {investmentMatchedEntries.map(({ ve, plaidTxId }, j) => (
                                        <div key={j} className="plaid-recon-detail-item">
                                          <span className="di-date">{fmtDate(ve.date)}</span>
                                          <span className="di-name">{ve.narration || ve.type}</span>
                                          <span className="di-amt debit">${Math.abs(ve.amount).toFixed(2)}</span>
                                          <button
                                            type="button"
                                            className="plaid-recon-reject-btn"
                                            title="Not the same charge — mark as still pending"
                                            onClick={(ev) => {
                                              ev.stopPropagation();
                                              rejectInvestmentMatch(ve.guid, plaidTxId);
                                            }}
                                          >
                                            ✕ Not a match
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                          {isExpanded && (
                            <tr className="plaid-recon-detail-row">
                              <td colSpan={7}>
                                <div className="plaid-recon-detail">
                                  <div className="plaid-recon-detail-col">
                                    <div className="plaid-recon-detail-title">
                                      In Plaid, not in vault — {notInVault.length} transaction{notInVault.length !== 1 ? "s" : ""}
                                      {notInVault.length > 0 && (
                                        <span className={`plaid-recon-detail-total ${plaidOnlyNet >= 0 ? "debit" : "credit"}`}>
                                          {" "}· Net {plaidOnlyNet >= 0 ? "−" : "+"}${Math.abs(plaidOnlyNet).toFixed(2)}
                                        </span>
                                      )}
                                    </div>
                                    {notInVault.length === 0
                                      ? <div className="plaid-recon-detail-empty">All Plaid transactions from this fetch are already in vault ✓</div>
                                      : notInVault.map((row, j) => (
                                        <div key={j} className="plaid-recon-detail-item di-missing">
                                          <span className="di-date">{fmtDate(row.plaidTx.date)}</span>
                                          <span className="di-name">{row.plaidTx.name}</span>
                                          <span className={`di-amt ${row.plaidTx.amount < 0 ? "credit" : "debit"}`}>
                                            {row.plaidTx.amount < 0 ? "+" : "−"}${Math.abs(row.plaidTx.amount).toFixed(2)}
                                          </span>
                                          <span className="di-status">{row.plaidTx.pending ? "⏳ pending" : "✗ not posted"}</span>
                                        </div>
                                      ))
                                    }
                                  </div>
                                  <div className="plaid-recon-detail-col">
                                    <div className="plaid-recon-detail-title">
                                      In vault, no Plaid match — {onlyInVault.length} entr{onlyInVault.length !== 1 ? "ies" : "y"} (last 90 days)
                                      {onlyInVault.length > 0 && (
                                        <span className={`plaid-recon-detail-total ${vaultOnlyNet >= 0 ? "credit" : "debit"}`}>
                                          {" "}· Net {vaultOnlyNet >= 0 ? "Cr" : "Dr"} ${Math.abs(vaultOnlyNet).toFixed(2)}
                                        </span>
                                      )}
                                    </div>
                                    {onlyInVault.length === 0
                                      ? <div className="plaid-recon-detail-empty">All vault entries (last 90 days) matched to Plaid transactions ✓</div>
                                      : onlyInVault.map((ve, j) => (
                                        <div key={j} className="plaid-recon-detail-item di-vault">
                                          <span className="di-date">{fmtDate(ve.date)}</span>
                                          <span className="di-name">{ve.narration}</span>
                                          <span className={`di-amt ${ve.amount < 0 ? "debit" : "credit"}`}>
                                            {ve.amount < 0 ? "Dr" : "Cr"} ${Math.abs(ve.amount).toFixed(2)}
                                          </span>
                                          <span className="di-status">{ve.type}</span>
                                        </div>
                                      ))
                                    }
                                  </div>
                                </div>
                                {diff !== null && rawGap !== null && (
                                  <div className="plaid-recon-gap-summary">
                                    <span>Raw balance gap: <strong>{rawGap >= 0 ? "+" : ""}${rawGap.toFixed(2)}</strong></span>
                                    <span className="plaid-recon-gap-sep">·</span>
                                    <span>Uncleared: <strong>{uncleared >= 0 ? "+" : ""}${uncleared.toFixed(2)}</strong></span>
                                    <span className="plaid-recon-gap-sep">·</span>
                                    <span>Gap: <strong>{diff >= 0 ? "+" : ""}${diff.toFixed(2)}</strong></span>
                                    {!balanced && notInVault.length === 0 && onlyInVault.length === 0 && (
                                      <>
                                        <span className="plaid-recon-gap-sep">·</span>
                                        <span className="plaid-recon-gap-unexplained">
                                          No specific transaction explains the remaining ${Math.abs(diff).toFixed(2)} — check for entries older than 90 days, or a Plaid balance sync lag.
                                        </span>
                                      </>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    });

                    // For each GL account shared by multiple physical Plaid accounts, insert one
                    // "Total" row right after its last card row, summing every card's ALREADY
                    // correctly-signed figures (refunds/credits netted against charges exactly like
                    // every other card's own row) so it reconciles directly against the one real GL
                    // balance for this shared account. Each individual card row above is a
                    // proportional estimate; this Total row is the exact real figure.
                    const lastIndexForVaultId = new Map<number, number>();
                    groups.forEach((g, i) => { if (g.vaultAcct) lastIndexForVaultId.set(g.vaultAcct.id, i); });

                    const finalRows: React.ReactNode[] = [];
                    groups.forEach((g, i) => {
                      finalRows.push(realRows[i]);
                      if (!g.vaultAcct) return;
                      const vid = g.vaultAcct.id;
                      if ((vaultIdShareCount.get(vid) ?? 0) <= 1 || lastIndexForVaultId.get(vid) !== i) return;

                      const vName = g.vaultAcct.name;
                      const totalVaultBal = vaultBookBalance(vid, g.plaidType, data);
                      const memberSummaries = rowSummaries.filter((r) => r.vaultAcctId === vid);
                      const totalPlaidBal = memberSummaries.every((m) => m.plaidBal !== null)
                        ? memberSummaries.reduce((s, m) => s + (m.plaidBal ?? 0), 0)
                        : null;
                      const totalUncleared = memberSummaries.reduce((s, m) => s + m.uncleared, 0);
                      const totalDiff = totalPlaidBal !== null ? totalPlaidBal - totalVaultBal + totalUncleared : null;
                      const totalBalanced = totalDiff !== null && Math.abs(totalDiff) < 1;
                      finalRows.push(
                        <tr key={`total-${vid}`} className="plaid-recon-row plaid-recon-total-row">
                          <td colSpan={2}><strong>Total — {vName}</strong></td>
                          <td className="plaid-recon-type">—</td>
                          <td className="plaid-recon-amt"><strong>{totalPlaidBal !== null ? `$${totalPlaidBal.toFixed(2)}` : "—"}</strong></td>
                          <td className="plaid-recon-amt"><strong>{totalUncleared >= 0 ? "+" : ""}${totalUncleared.toFixed(2)}</strong></td>
                          <td className="plaid-recon-amt"><strong>${totalVaultBal.toFixed(2)}</strong></td>
                          <td className={`plaid-recon-diff${totalDiff !== null ? (totalBalanced ? " good" : " bad") : ""}`}>
                            <strong>{totalDiff !== null ? `${totalDiff >= 0 ? "+" : ""}$${totalDiff.toFixed(2)}` : "—"}</strong>
                          </td>
                        </tr>
                      );
                    });
                    finalRows.push(
                      <tr key="grand-total" className="plaid-recon-row plaid-recon-total-row plaid-recon-grand-total">
                        <td colSpan={3}><strong>Total liquidity (Plaid)</strong></td>
                        <td className="plaid-recon-amt"><strong>${columnTotals.plaid.toFixed(2)}</strong></td>
                        <td className="plaid-recon-amt"><strong>{columnTotals.uncleared >= 0 ? "+" : ""}${columnTotals.uncleared.toFixed(2)}</strong></td>
                        <td className="plaid-recon-amt"><strong>${columnTotals.vault.toFixed(2)}</strong></td>
                        <td></td>
                      </tr>
                    );
                    return finalRows;
                  })()}
                </tbody>
              </table>
              <div className="plaid-recon-note">
                <strong>Uncleared</strong> = the NET of pending charges and credits at the bank that Plaid's current
                balance doesn't reflect yet but the vault already does (a refund reduces this figure, it isn't just
                added up as if everything were a charge). Pending payments are excluded — they're already applied in
                both Plaid and vault. Click (▼) to see the individual transactions, including the gross total before
                netting refunds/credits.
                <strong>Difference = Plaid − Vault + Uncleared</strong>; when $0.00, vault matches Plaid's settled position.
                Click any non-zero row (▼) to drill down into which transactions explain the remaining gap.
                {" "}<strong>Note:</strong> Plaid credit card balances can lag 1–2 days for settled transactions — the drill-down "Remaining gap" will show whether it's a sync lag or missing entries.
              </div>
            </>
          )}
        </div>
      )}
      {/* Duplicates tab */}
    </div>
  );
}
