"use client";
import React, { useEffect, useMemo, useState } from "react";
import type { Ledger, Tx, Trade, RsuGrant, RsuVest, EsppPurchase } from "@/lib/vault-types";
import { nextVoucherNumber, nextTransactionIds, ledgerBalanceAsOf } from "@/lib/vault-accounting";
import { fmtDate } from "@/lib/format-date";
import {
  classifySchwabActivity,
  primaryInstrument,
  activityNarration,
  type SchwabActivity,
} from "@/lib/parse-schwab-transactions";
import { TRADING_SEED, SCHWAB_BROKER_CODES } from "@/components/reports/TradingReport";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fmtMoney(n: number): string {
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

// Schwab's OAuth connection only covers one linked account, which matches the "CST" broker label
// in this app's existing trade data (verified against real positions) -- both position sync and
// transaction sync only ever create/touch CST trades; CSS/RBS stay fully manual.
const SCHWAB_BROKER: Trade["broker"] = "CST";
const SCHWAB_SYNC_EXCLUDE = new Set(["NVDA"]); // tracked in Equity report instead (RSU-sourced)

interface SchwabPosition { symbol: string; quantity: number; avgPrice: number; marketValue: number }

interface SchwabSyncAction {
  symbol: string;
  company: string;
  kind: "new" | "increase" | "reduce" | "close";
  deltaUnits: number;
  estPrice: number;
  note: string;
}

// Compares Schwab's real current positions (quantity + blended average cost -- no lot-level
// detail available) against what's already tracked in Trading, and proposes changes. Never
// applied automatically -- only runs once the user reviews and confirms this plan.
function computeSchwabSyncPlan(trades: Trade[], positions: SchwabPosition[]): SchwabSyncAction[] {
  const actions: SchwabSyncAction[] = [];
  const openForBroker = trades.filter((t) => !t.saleDate && t.broker === SCHWAB_BROKER && !SCHWAB_SYNC_EXCLUDE.has(t.symbol));
  const trackedBySymbol = new Map<string, Trade[]>();
  for (const t of openForBroker) {
    const list = trackedBySymbol.get(t.symbol) ?? [];
    list.push(t);
    trackedBySymbol.set(t.symbol, list);
  }
  const schwabSymbols = new Set(positions.map((p) => p.symbol));

  for (const pos of positions) {
    if (SCHWAB_SYNC_EXCLUDE.has(pos.symbol) || pos.quantity <= 0) continue;
    const tracked = trackedBySymbol.get(pos.symbol) ?? [];
    const trackedQty = tracked.reduce((s, t) => s + t.units, 0);
    const trackedCost = tracked.reduce((s, t) => s + t.units * t.costPerSh, 0);
    const schwabTotalCost = pos.avgPrice * pos.quantity;

    if (pos.quantity > trackedQty + 0.0001) {
      const deltaUnits = pos.quantity - trackedQty;
      const estPrice = Math.max(0, (schwabTotalCost - trackedCost) / deltaUnits);
      actions.push({
        symbol: pos.symbol, company: tracked[0]?.company ?? pos.symbol,
        kind: trackedQty > 0 ? "increase" : "new", deltaUnits, estPrice,
        note: trackedQty > 0
          ? `Schwab shows ${pos.quantity} shares vs. ${trackedQty} tracked — adds ${deltaUnits.toFixed(2)} shares at an estimated $${estPrice.toFixed(2)}/share (back-calculated from Schwab's blended average; not a real trade date or price).`
          : `New position on Schwab, not yet tracked here — ${deltaUnits.toFixed(2)} shares at Schwab's average cost of $${estPrice.toFixed(2)}/share.`,
      });
    } else if (pos.quantity < trackedQty - 0.0001) {
      const deltaUnits = trackedQty - pos.quantity;
      actions.push({
        symbol: pos.symbol, company: tracked[0]?.company ?? pos.symbol,
        kind: "reduce", deltaUnits, estPrice: pos.avgPrice,
        note: `Schwab shows ${pos.quantity} shares vs. ${trackedQty} tracked — ${deltaUnits.toFixed(2)} shares appear to have been sold. Exact sale date/price is unknown (closes your oldest lot(s) first, dated today).`,
      });
    }
  }
  for (const [symbol, tracked] of trackedBySymbol) {
    if (!schwabSymbols.has(symbol)) {
      const trackedQty = tracked.reduce((s, t) => s + t.units, 0);
      actions.push({
        symbol, company: tracked[0]?.company ?? symbol, kind: "close", deltaUnits: trackedQty, estPrice: 0,
        note: `No longer appears in your Schwab account — looks fully sold. Exact sale date/price is unknown.`,
      });
    }
  }
  return actions;
}

// Applies a user-confirmed sync plan: new/increase add a lot dated today at the estimated cost;
// reduce/close consume oldest-open lots first (FIFO), splitting a lot if only part of it sold.
function applySchwabSync(trades: Trade[], actions: SchwabSyncAction[], todayIso: string): Trade[] {
  let next = [...trades];
  for (const a of actions) {
    if (a.kind === "new" || a.kind === "increase") {
      next.push({
        id: uid(), symbol: a.symbol, company: a.company, broker: SCHWAB_BROKER, buyDate: todayIso,
        units: a.deltaUnits, costPerSh: a.estPrice, marketOrSalePrice: a.estPrice, yesterday: a.estPrice,
      });
      continue;
    }
    let remaining = a.deltaUnits;
    const openLots = next
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !t.saleDate && t.symbol === a.symbol && t.broker === SCHWAB_BROKER)
      .sort((x, y) => x.t.buyDate.localeCompare(y.t.buyDate));
    for (const { t, i } of openLots) {
      if (remaining <= 0.0001) break;
      if (t.units <= remaining + 0.0001) {
        next[i] = { ...t, saleDate: todayIso, marketOrSalePrice: a.estPrice };
        remaining -= t.units;
      } else {
        next[i] = { ...t, units: t.units - remaining };
        next.push({ ...t, id: uid(), units: remaining, saleDate: todayIso, marketOrSalePrice: a.estPrice });
        remaining = 0;
      }
    }
  }
  return next;
}

type ImportedActivity = { activityId: number; kind: "trade" | "transferIn" | "dividendInterest" | "vest" | "esppPurchase" | "dismissed"; importedAt: string };

function isEquitySymbol(a: SchwabActivity): boolean {
  const inst = primaryInstrument(a);
  const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "";
  return SCHWAB_SYNC_EXCLUDE.has(symbol);
}

const ONE_YEAR_MS = 364 * 86_400_000;

interface Props {
  data: Ledger;
  onSave: (next: Ledger) => Promise<boolean>;
}

export function SchwabImport({ data, onSave }: Props) {
  // ── Connection status ────────────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<{ connected: false } | { connected: true; daysUntilReauth: number } | null>(null);
  useEffect(() => {
    fetch("/api/schwab/status")
      .then((r) => r.json())
      .then((raw: unknown) => {
        const d = raw as { connected: boolean; daysUntilReauth?: number };
        setStatus(d.connected ? { connected: true, daysUntilReauth: d.daysUntilReauth ?? 0 } : { connected: false });
      })
      .catch(() => setStatus({ connected: false }));
  }, []);
  async function disconnect() {
    if (!confirm("Disconnect from Schwab? You can reconnect any time.")) return;
    await fetch("/api/schwab/status", { method: "DELETE" });
    setStatus({ connected: false });
  }

  const effectiveTrades = data.trades ?? TRADING_SEED;

  // ── Position sync (quantity/avg-cost preview, moved here from Trading report) ───────────
  const [posSyncActions, setPosSyncActions] = useState<SchwabSyncAction[] | null>(null);
  const [posSyncLoading, setPosSyncLoading] = useState(false);
  const [posSyncError, setPosSyncError] = useState<string | null>(null);
  const [posSyncApplying, setPosSyncApplying] = useState(false);
  async function loadPositionSyncPreview() {
    setPosSyncLoading(true);
    setPosSyncError(null);
    try {
      const res = await fetch("/api/schwab/positions");
      const json = (await res.json()) as { accounts?: Array<{ positions?: SchwabPosition[]; error?: string }>; error?: string };
      if (json.error) throw new Error(json.error);
      const positions = (json.accounts ?? []).flatMap((a) => a.positions ?? []);
      setPosSyncActions(computeSchwabSyncPlan(effectiveTrades, positions));
    } catch (e) {
      setPosSyncError(String(e instanceof Error ? e.message : e));
      setPosSyncActions([]);
    } finally {
      setPosSyncLoading(false);
    }
  }
  async function applyPositionSync() {
    if (!posSyncActions || posSyncActions.length === 0) return;
    setPosSyncApplying(true);
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const next = applySchwabSync(effectiveTrades, posSyncActions, todayIso);
      const ok = await onSave({ ...data, trades: next });
      if (ok) setPosSyncActions(null);
    } finally {
      setPosSyncApplying(false);
    }
  }

  // ── Transaction history sync (new) ───────────────────────────────────────────────────────
  const [imported, setImported] = useState<ImportedActivity[]>([]);
  useEffect(() => {
    fetch("/api/schwab/imported-activities")
      .then((r) => r.json())
      .then((raw: unknown) => setImported(raw as ImportedActivity[]))
      .catch(() => setImported([]));
  }, []);
  const importedIds = useMemo(() => new Set(imported.map((x) => x.activityId)), [imported]);

  const [activities, setActivities] = useState<SchwabActivity[] | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txProgress, setTxProgress] = useState("");

  async function fetchWindow(startDate: string, endDate: string): Promise<SchwabActivity[]> {
    const url = `/api/schwab/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
    const res = await fetch(url);
    const json = (await res.json()) as { accounts?: Array<{ data?: SchwabActivity[]; error?: string }>; error?: string };
    if (json.error) throw new Error(json.error);
    return (json.accounts ?? []).flatMap((a) => a.data ?? []);
  }

  // Last 30 days -- well inside Schwab's 1-year single-call cap, and enough to catch anything
  // since the last check without a full backfill walk.
  async function checkForNewActivity() {
    setTxLoading(true);
    setTxError(null);
    setTxProgress("");
    try {
      const endDate = new Date().toISOString();
      const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const fetched = await fetchWindow(startDate, endDate);
      setActivities((prev) => mergeActivities(prev ?? [], fetched));
    } catch (e) {
      setTxError(String(e instanceof Error ? e.message : e));
    } finally {
      setTxLoading(false);
    }
  }

  // Schwab caps a single call's date range at ~1 year, so full history is walked backward in
  // <=365-day windows. Stops early (rather than a fixed year count) once a window comes back
  // empty -- that's the account's real start, no point paging further into the past.
  async function backfillHistory() {
    setTxLoading(true);
    setTxError(null);
    try {
      let end = new Date();
      let all: SchwabActivity[] = activities ?? [];
      for (let i = 0; i < 10; i++) {
        const endDate = end.toISOString();
        const start = new Date(end.getTime() - ONE_YEAR_MS);
        const startDate = start.toISOString();
        setTxProgress(`Fetching ${startDate.slice(0, 10)} to ${endDate.slice(0, 10)}…`);
        const fetched = await fetchWindow(startDate, endDate);
        if (fetched.length === 0) break;
        all = mergeActivities(all, fetched);
        end = start;
      }
      setActivities(all);
    } catch (e) {
      setTxError(String(e instanceof Error ? e.message : e));
    } finally {
      setTxProgress("");
      setTxLoading(false);
    }
  }

  function mergeActivities(prev: SchwabActivity[], fresh: SchwabActivity[]): SchwabActivity[] {
    const byId = new Map(prev.map((a) => [a.activityId, a]));
    for (const a of fresh) byId.set(a.activityId, a);
    return [...byId.values()].sort((a, b) => b.time.localeCompare(a.time));
  }

  const pending = useMemo(() => (activities ?? []).filter((a) => !importedIds.has(a.activityId)), [activities, importedIds]);
  // NVDA (and anything else in SCHWAB_SYNC_EXCLUDE) is RSU-sourced and tracked in the Equity
  // report, not Trading -- split out BEFORE classifying so it can never end up with a "Confirm
  // cost basis" button that would create a duplicate/wrong Trading lot for it.
  const equityOnly = useMemo(() => pending.filter(isEquitySymbol), [pending]);
  const tradingPending = useMemo(() => pending.filter((a) => !isEquitySymbol(a)), [pending]);
  const classified = useMemo(() => classifySchwabActivity(tradingPending), [tradingPending]);

  async function markImported(a: SchwabActivity, kind: ImportedActivity["kind"]) {
    const body = { activityId: a.activityId, kind };
    await fetch("/api/schwab/imported-activities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setImported((prev) => [...prev, { ...body, importedAt: new Date().toISOString() }]);
  }

  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  // For an activity that's already reflected elsewhere (e.g. the transfer-in event that
  // originally seeded a position already tracked in Trading/Equity) -- marks it seen without
  // creating anything, so it stops reappearing on future "check for new activity" runs.
  async function dismiss(a: SchwabActivity) {
    setConfirmingId(a.activityId);
    try {
      await markImported(a, "dismissed");
    } finally {
      setConfirmingId(null);
    }
  }

  // Dismisses every currently-pending activity at once -- meant for the initial "I already track
  // all of this by hand, just set today as the starting point" case, not routine use. Skipped
  // rows aren't silently dropped: this only ever adds to the dedup list, never posts anything, so
  // it's always safe to re-fetch and individually confirm something dismissed by mistake later
  // (it just won't reappear on its own -- see the DELETE handler on imported-activities).
  const [bulkDismissing, setBulkDismissing] = useState(false);
  async function bulkDismissAll() {
    if (!pending.length) return;
    if (!confirm(`Mark all ${pending.length} pending activities as already tracked? None of them will be added to Trading/Equity -- this just stops them from showing up again.`)) return;
    setBulkDismissing(true);
    try {
      for (const a of pending) await markImported(a, "dismissed");
    } finally {
      setBulkDismissing(false);
    }
  }

  // trade / transferIn -> new open Trade lot. transferIn rows are pre-filled but editable
  // (units/price) before confirm -- see the review UI below -- so the cost basis actually gets
  // looked at, not just accepted from Schwab's transfer record sight-unseen.
  async function confirmTradeOrTransfer(a: SchwabActivity, units: number, price: number, kind: "trade" | "transferIn") {
    const inst = primaryInstrument(a);
    const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "?";
    setConfirmingId(a.activityId);
    try {
      const todayIso = (a.tradeDate || a.time).slice(0, 10);
      const next: Trade = {
        id: uid(), company: symbol, symbol, broker: SCHWAB_BROKER,
        buyDate: todayIso, units, costPerSh: price, marketOrSalePrice: price, yesterday: price,
      };
      const ok = await onSave({ ...data, trades: [...effectiveTrades, next] });
      if (ok) await markImported(a, kind);
    } finally {
      setConfirmingId(null);
    }
  }

  // ── Dividend / interest income voucher (same shape as the CSV tool's addIncomeVoucher) ────
  const [divDebitAcctId, setDivDebitAcctId] = useState<number | "">("");
  const [divCreditAcctId, setDivCreditAcctId] = useState<number | "">("");
  useEffect(() => {
    setDivDebitAcctId((cur) => {
      if (cur !== "") return cur;
      const active = data.accounts.filter((acc) => acc.active !== false);
      // Prefer an EXACT "Charles Schwab" match over a loose /schwab/i substring match -- the
      // vault can also have "Charles Schwab (CST)"/"(CSS)" trading cost-basis accounts (much
      // larger balances, a different purpose entirely), and a substring match's .find() would
      // silently grab whichever one happens to sort first, not necessarily the dividend ledger.
      const exact = active.find((acc) => /^charles schwab$/i.test(acc.name.trim()));
      return exact?.id ?? active.find((acc) => /schwab/i.test(acc.name))?.id ?? "";
    });
    setDivCreditAcctId((cur) => cur !== "" ? cur : (data.accounts.find((acc) => acc.active !== false && /other income/i.test(acc.name))?.id ?? data.accounts.find((acc) => acc.active !== false && /dividend/i.test(acc.name))?.id ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.accounts]);

  // ── Review-before-post: clicking "Add voucher" opens an inline, editable preview (narration,
  // Dr/Cr account, amount) instead of posting immediately -- the shared Debit/Credit dropdowns
  // above only set the DEFAULT for new reviews, they don't post anything by themselves.
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [reviewNarration, setReviewNarration] = useState("");
  const [reviewDebitId, setReviewDebitId] = useState<number | "">("");
  const [reviewCreditId, setReviewCreditId] = useState<number | "">("");
  const [reviewAmount, setReviewAmount] = useState("");

  function openReview(a: SchwabActivity, defaultNarration: string) {
    setReviewingId(a.activityId);
    setReviewNarration(`${defaultNarration} (${fmtDate(a.time.slice(0, 10))})`);
    setReviewDebitId(divDebitAcctId);
    setReviewCreditId(divCreditAcctId);
    setReviewAmount(Math.abs(a.netAmount).toFixed(2));
  }
  function cancelReview() {
    setReviewingId(null);
  }

  async function confirmIncome(a: SchwabActivity) {
    if (reviewDebitId === "" || reviewCreditId === "") return;
    const debitAcct = data.accounts.find((acc) => acc.id === reviewDebitId);
    const creditAcct = data.accounts.find((acc) => acc.id === reviewCreditId);
    const amt = Math.abs(Number(reviewAmount) || 0);
    if (!debitAcct || !creditAcct || amt <= 0) return;
    setConfirmingId(a.activityId);
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const tx: Tx = {
        id: nextTransactionIds(data.transactions, 1)[0],
        guid: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        date: todayIso, // catch-up entry posted today, not backdated -- same convention as the CSV tool
        number: nextVoucherNumber(data, "Receipt", todayIso),
        type: "Receipt",
        narration: reviewNarration || `${activityNarration(a)} (${fmtDate(a.time.slice(0, 10))})`,
        historical: false,
        cancelled: false,
        syncStatus: "pending",
        entries: [
          { accountId: debitAcct.id, accountName: debitAcct.name, amount: -amt },
          { accountId: creditAcct.id, accountName: creditAcct.name, amount: amt },
        ],
      };
      const ok = await onSave({ ...data, transactions: [...data.transactions, tx] });
      if (ok) {
        await markImported(a, "dividendInterest");
        setReviewingId(null);
      }
    } finally {
      setConfirmingId(null);
    }
  }

  // ── Reconciliation: Schwab cost basis + live cash vs. the vault's Schwab ledger balance.
  // Confirmed directly against real numbers that the vault's "Charles Schwab" GL account is NOT
  // a dividends-only ledger -- it carries the account's full value (stock cost basis + cash +
  // dividends together), matching Trading's own "Total Open + Cash" figure almost exactly (off by
  // precisely the one pending, not-yet-posted dividend). So the comparable figure is the same one
  // Trading's own CSV-based reconciliation tool already uses -- open-position cost basis (CST +
  // CSS, excl. NVDA) plus Schwab's live uninvested cash balance -- just sourced from live data
  // here instead of a manually uploaded CSV.
  const [schwabCashBalance, setSchwabCashBalance] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/schwab/positions")
      .then((r) => r.json())
      .then((d: unknown) => {
        const j = d as { accounts?: { cashBalance?: number }[] };
        if (j.accounts?.length) setSchwabCashBalance(j.accounts.reduce((s, a) => s + (a.cashBalance ?? 0), 0));
      })
      .catch(() => {});
  }, []);
  const openCostBasis = useMemo(
    () => effectiveTrades
      .filter((t) => !t.saleDate && SCHWAB_BROKER_CODES.has(t.broker) && !SCHWAB_SYNC_EXCLUDE.has(t.symbol))
      .reduce((s, t) => s + t.units * t.costPerSh, 0),
    [effectiveTrades]
  );
  const expectedVaultBalance = schwabCashBalance !== null ? openCostBasis + schwabCashBalance : null;
  const vaultSchwabBalance = divDebitAcctId !== ""
    ? ledgerBalanceAsOf(data, divDebitAcctId, new Date().toISOString().slice(0, 10))
    : null;
  const schwabVaultDiff = expectedVaultBalance !== null && vaultSchwabBalance !== null ? expectedVaultBalance - vaultSchwabBalance : null;

  // Possible unlabeled dividend/interest: a JOURNAL-type activity (Schwab's generic "cash moved"
  // type, covering both real income credits and internal sweeps) with money coming IN and no
  // same-day offsetting activity elsewhere -- a same-day opposite-sign match means it's just an
  // internal sweep leg (e.g. Equity account -> Trust), not new income. Surfaced for manual
  // per-item review/confirm, never auto-posted -- most JOURNAL entries genuinely aren't income,
  // so a blanket rule here would invent fake income on the ones that are just transfers.
  const possibleIncome = useMemo(() => {
    // One-to-one pairing, not "does ANY opposite-sign match exist" -- the latter let a single
    // -$X sweep leg cancel out every +$X candidate that happened to share its day/magnitude
    // (confirmed directly: one -$82.70 sweep spuriously canceled BOTH a real +$82.70 sweep pair
    // AND a genuine +$82.70 dividend that coincidentally matched the same amount). Each negative
    // can only consume one positive.
    const journalActivities = classified.other.filter((a) => a.type === "JOURNAL");
    const positives = journalActivities.filter((a) => a.netAmount > 0.005);
    const negatives = journalActivities.filter((a) => a.netAmount < -0.005);
    const usedNegativeIds = new Set<number>();
    return positives.filter((pos) => {
      const day = pos.time.slice(0, 10);
      const match = negatives.find(
        (neg) => !usedNegativeIds.has(neg.activityId) && neg.time.slice(0, 10) === day && Math.abs(neg.netAmount + pos.netAmount) < 0.01
      );
      if (match) {
        usedNegativeIds.add(match.activityId);
        return false;
      }
      return true;
    });
  }, [classified.other]);

  // ── Equity (NVDA): match a vest activity to an existing scheduled tranche, or record a new
  // ESPP purchase. Never a new Trading lot -- Equity report stays the single source of truth for
  // NVDA regardless of which account (Equity Award Center or, after transfer, Trust) holds it. ─
  const allGrants = data.equity?.grants ?? [];
  const allEsppPurchases = data.equity?.esppPurchases ?? [];

  // Every still-open scheduled tranche across every grant, closest-date-first to whichever
  // activity is being matched -- mirrors the "confirm pending vest" flow already in Equity
  // report (saveRecordVest/saveVestDay), just entered from a live Schwab activity instead of a
  // manual click.
  function pendingVestsNear(activityDate: string): { grant: RsuGrant; vest: RsuVest }[] {
    const list: { grant: RsuGrant; vest: RsuVest; diff: number }[] = [];
    for (const g of allGrants) {
      for (const v of g.vests) {
        if (!v.pending) continue;
        list.push({ grant: g, vest: v, diff: Math.abs(new Date(v.vestDate).getTime() - new Date(activityDate).getTime()) });
      }
    }
    return list.sort((a, b) => a.diff - b.diff).map(({ grant, vest }) => ({ grant, vest }));
  }

  async function confirmVestMatch(a: SchwabActivity, grantId: string, vestId: string, vestPrice: number, sharesHeld: number, taxShares: number) {
    setConfirmingId(a.activityId);
    try {
      const nextGrants = allGrants.map((g) =>
        g.id !== grantId ? g : {
          ...g,
          vests: g.vests.map((v) => (v.id !== vestId ? v : { ...v, vestPrice, sharesHeld: Math.max(0, sharesHeld), taxShares, pending: false })),
        }
      );
      const ok = await onSave({ ...data, equity: { grants: nextGrants, esppPurchases: allEsppPurchases } });
      if (ok) await markImported(a, "vest");
    } finally {
      setConfirmingId(null);
    }
  }

  async function confirmEsppPurchase(a: SchwabActivity, shares: number, purchasePrice: number, offeringPrice: number, marketPriceAtPurchase: number, purchaseDate: string) {
    setConfirmingId(a.activityId);
    try {
      const inst = primaryInstrument(a);
      const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "NVDA";
      const purchase: EsppPurchase = {
        id: uid(), ticker: symbol, offeringDate: purchaseDate, purchaseDate,
        shares, offeringPrice, purchasePrice, marketPriceAtPurchase, sharesHeld: shares,
      };
      const ok = await onSave({ ...data, equity: { grants: allGrants, esppPurchases: [...allEsppPurchases, purchase] } });
      if (ok) await markImported(a, "esppPurchase");
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <div className="plaid-import">
      <h3 style={{ margin: "0 0 4px" }}>Charles Schwab</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 12px" }}>
        Connect, fetch, and confirm here — Trading and Equity reports just show whatever's already
        been confirmed, same as Plaid transactions never need a separate confirm step in Daybook.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: 14 }}>
        {status?.connected === true ? (
          <span style={{ fontSize: 12, color: status.daysUntilReauth <= 1 ? "#dc2626" : "#16a34a" }}>
            ✓ Schwab connected
            {status.daysUntilReauth <= 1 ? " — re-auth needed today" : ` — re-auth in ${status.daysUntilReauth}d`}
            {" "}<button className="tr-refresh-btn" onClick={disconnect}>Disconnect</button>
          </span>
        ) : status?.connected === false ? (
          <a href="/api/schwab/authorize" className="tr-refresh-btn" style={{ textDecoration: "none" }}>🔗 Connect Schwab</a>
        ) : null}
        {status?.connected === true && (
          <>
            <button className="tr-refresh-btn" onClick={loadPositionSyncPreview} disabled={posSyncLoading}>
              {posSyncLoading ? "Checking…" : "🔄 Sync positions"}
            </button>
            <button className="tr-refresh-btn" onClick={checkForNewActivity} disabled={txLoading}>
              {txLoading && !txProgress ? "Checking…" : "📥 Check for new activity"}
            </button>
            <button className="tr-refresh-btn" onClick={backfillHistory} disabled={txLoading}>
              {txProgress || "⏳ Backfill history"}
            </button>
          </>
        )}
      </div>

      {posSyncActions !== null && (
        <div className="data-panel" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 6px" }}>Position sync</h4>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
            Compares real Schwab positions (quantity + blended average cost) against what's tracked
            for Charles Schwab (CST). Schwab doesn't expose individual trade dates/prices, so any
            new/changed lot uses an <strong>estimated</strong> date (today) and price — review before
            applying. NVDA is never included; it's tracked in the Equity report instead.
          </p>
          {posSyncError && <p style={{ fontSize: 12, color: "#dc2626" }}>Error: {posSyncError}</p>}
          {posSyncActions.length === 0 && !posSyncError && <p style={{ fontSize: 13 }}>Everything matches — no changes proposed.</p>}
          {posSyncActions.map((a, i) => (
            <div key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.65rem 0.85rem", marginBottom: "0.5rem" }}>
              <strong style={{ fontSize: 13 }}>
                {a.symbol} — {a.kind === "new" ? "New position" : a.kind === "increase" ? "Add to position" : a.kind === "reduce" ? "Partial sale" : "Fully sold"}
              </strong>
              <p style={{ fontSize: 12, margin: "0.3rem 0 0", color: "#334155" }}>{a.note}</p>
            </div>
          ))}
          <div className="equity-form-actions">
            <button onClick={applyPositionSync} disabled={posSyncApplying || posSyncActions.length === 0}>
              {posSyncApplying ? "Applying…" : "Apply Sync"}
            </button>
            <button onClick={() => setPosSyncActions(null)} disabled={posSyncApplying}>Close</button>
          </div>
        </div>
      )}

      {txError && <p style={{ fontSize: 12, color: "#dc2626" }}>Error: {txError}</p>}

      {activities !== null && (
        <div className="data-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
              {pending.length} new activit{pending.length === 1 ? "y" : "ies"} since last import
              ({activities.length} fetched, {activities.length - pending.length} already confirmed).
            </p>
            {pending.length > 0 && (
              <button
                className="tr-refresh-btn"
                disabled={bulkDismissing}
                onClick={bulkDismissAll}
                title="Use this once, right after connecting, to set today as the starting point -- everything currently listed gets marked seen without creating anything, so only genuinely new activity shows up from here on."
              >
                {bulkDismissing ? "Dismissing…" : "Dismiss all as already tracked"}
              </button>
            )}
          </div>

          {classified.trades.length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px" }}>Trades ({classified.trades.length})</h4>
              {classified.trades.map((a) => {
                const inst = primaryInstrument(a);
                const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "?";
                const units = Math.abs(inst?.amount ?? 0);
                const price = inst?.price ?? 0;
                return (
                  <div key={a.activityId} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13 }}>
                      <strong>{symbol}</strong> {a.netAmount < 0 ? "Buy" : "Sell"} {units} @ ${price.toFixed(2)}
                      <span style={{ opacity: 0.6 }}> — {fmtDate((a.tradeDate || a.time).slice(0, 10))} — {a.description}</span>
                    </span>
                    <span style={{ display: "flex", gap: 6 }}>
                      <button
                        className="tr-refresh-btn"
                        disabled={confirmingId === a.activityId}
                        onClick={() => confirmTradeOrTransfer(a, units, price, "trade")}
                      >
                        {confirmingId === a.activityId ? "Adding…" : "Add to Trading"}
                      </button>
                      <button className="tr-refresh-btn" disabled={confirmingId === a.activityId} onClick={() => dismiss(a)}>
                        Dismiss
                      </button>
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {classified.transfersIn.length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px" }}>Transfers in — review cost basis ({classified.transfersIn.length})</h4>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
                Shares moved into this account (not a purchase) — Schwab reports a cost basis but no
                real trade date. Check the numbers below before confirming; each one requires an
                explicit confirm, never bulk-added.
              </p>
              {classified.transfersIn.map((a) => (
                <TransferInRow
                  key={a.activityId}
                  activity={a}
                  busy={confirmingId === a.activityId}
                  onConfirm={(units, price) => confirmTradeOrTransfer(a, units, price, "transferIn")}
                  onDismiss={() => dismiss(a)}
                />
              ))}
            </>
          )}

          {equityOnly.length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px" }}>Equity (NVDA) ({equityOnly.length})</h4>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
                Never becomes a Trading lot — match a vest to its scheduled tranche in Equity report,
                record a new ESPP purchase, or dismiss if it's just the account's existing balance
                (e.g. an old transfer-in from before this sync existed).
              </p>
              {equityOnly.map((a) => (
                <EquityActivityRow
                  key={a.activityId}
                  activity={a}
                  busy={confirmingId === a.activityId}
                  pendingVests={pendingVestsNear((a.tradeDate || a.time).slice(0, 10))}
                  onConfirmVest={(grantId, vestId, vestPrice, sharesHeld, taxShares) => confirmVestMatch(a, grantId, vestId, vestPrice, sharesHeld, taxShares)}
                  onConfirmEspp={(shares, purchasePrice, offeringPrice, marketPrice, purchaseDate) => confirmEsppPurchase(a, shares, purchasePrice, offeringPrice, marketPrice, purchaseDate)}
                  onDismiss={() => dismiss(a)}
                />
              ))}
            </>
          )}

          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.8rem" }}>
            <h4 style={{ margin: "0 0 6px" }}>Schwab (cost basis + cash) vs. Vault</h4>
            <div style={{ display: "flex", gap: "1.4rem", fontSize: 13, flexWrap: "wrap" }}>
              <span>Open cost basis (CST+CSS, excl. NVDA): <strong>{fmtMoney(openCostBasis)}</strong></span>
              <span>+ Live cash: <strong>{schwabCashBalance !== null ? fmtMoney(schwabCashBalance) : "—"}</strong></span>
              <span>= Expected: <strong>{expectedVaultBalance !== null ? fmtMoney(expectedVaultBalance) : "—"}</strong></span>
              <span>Vault balance: <strong>{vaultSchwabBalance !== null ? fmtMoney(vaultSchwabBalance) : "select an account below"}</strong></span>
              <span>
                Difference:{" "}
                <strong style={{ color: schwabVaultDiff === null ? undefined : Math.abs(schwabVaultDiff) < 0.5 ? "#16a34a" : "#dc2626" }}>
                  {schwabVaultDiff !== null ? fmtMoney(schwabVaultDiff) : "—"}
                </strong>
              </span>
            </div>
            <p style={{ fontSize: 11, opacity: 0.6, margin: "6px 0 0" }}>
              Your "Charles Schwab" ledger tracks the account's full value (cost basis + cash + dividends together),
              not just dividend income -- so this compares against the same "cost basis + cash" figure Trading's own
              GL-comparison tool uses, just from live data instead of an uploaded CSV. A remaining difference usually
              means an activity below (like a pending dividend) hasn't been posted yet.
            </p>
          </div>

          {possibleIncome.length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px", color: "#b45309" }}>Possible dividend/interest — review ({possibleIncome.length})</h4>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
                A JOURNAL-type activity with money coming in and no matching same-day sweep-out elsewhere -- may be
                unlabeled income Schwab didn't tag as a dividend/interest. Review before adding; not auto-posted.
              </p>
              {possibleIncome.map((a) =>
                reviewingId === a.activityId ? (
                  <IncomeReviewRow
                    key={a.activityId}
                    accounts={data.accounts}
                    narration={reviewNarration}
                    setNarration={setReviewNarration}
                    debitId={reviewDebitId}
                    setDebitId={setReviewDebitId}
                    creditId={reviewCreditId}
                    setCreditId={setReviewCreditId}
                    amount={reviewAmount}
                    setAmount={setReviewAmount}
                    busy={confirmingId === a.activityId}
                    onConfirm={() => confirmIncome(a)}
                    onCancel={cancelReview}
                  />
                ) : (
                  <div key={a.activityId} style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13 }}>
                      {a.description || a.type} — ${Math.abs(a.netAmount).toFixed(2)}
                      <span style={{ opacity: 0.6 }}> — {fmtDate(a.time.slice(0, 10))}</span>
                    </span>
                    <button className="tr-refresh-btn" onClick={() => openReview(a, a.description || a.type)}>
                      Add as dividend/interest
                    </button>
                  </div>
                )
              )}
            </>
          )}

          {classified.dividendsInterest.length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px" }}>Dividends / interest ({classified.dividendsInterest.length})</h4>
              <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: 8, fontSize: 12 }}>
                <span>Debit</span>
                <select value={divDebitAcctId} onChange={(e) => setDivDebitAcctId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">— choose —</option>
                  {data.accounts.filter((acc) => acc.active !== false).map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                </select>
                <span>Credit</span>
                <select value={divCreditAcctId} onChange={(e) => setDivCreditAcctId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">— choose —</option>
                  {data.accounts.filter((acc) => acc.active !== false).map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                </select>
              </div>
              {classified.dividendsInterest.map((a) =>
                reviewingId === a.activityId ? (
                  <IncomeReviewRow
                    key={a.activityId}
                    accounts={data.accounts}
                    narration={reviewNarration}
                    setNarration={setReviewNarration}
                    debitId={reviewDebitId}
                    setDebitId={setReviewDebitId}
                    creditId={reviewCreditId}
                    setCreditId={setReviewCreditId}
                    amount={reviewAmount}
                    setAmount={setReviewAmount}
                    busy={confirmingId === a.activityId}
                    onConfirm={() => confirmIncome(a)}
                    onCancel={cancelReview}
                  />
                ) : (
                  <div key={a.activityId} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13 }}>
                      {activityNarration(a)} — ${Math.abs(a.netAmount).toFixed(2)}
                      <span style={{ opacity: 0.6 }}> — {fmtDate(a.time.slice(0, 10))}</span>
                    </span>
                    <button className="tr-refresh-btn" onClick={() => openReview(a, activityNarration(a))}>
                      Add voucher
                    </button>
                  </div>
                )
              )}
            </>
          )}

          {classified.other.filter((a) => !possibleIncome.includes(a)).length > 0 && (
            <>
              <h4 style={{ margin: "10px 0 6px", opacity: 0.6 }}>
                Other / not actionable ({classified.other.filter((a) => !possibleIncome.includes(a)).length})
              </h4>
              {classified.other.filter((a) => !possibleIncome.includes(a)).map((a) => (
                <div key={a.activityId} style={{ fontSize: 12, opacity: 0.55, padding: "0.3rem 0" }}>
                  {a.type} — {a.description} — {fmtDate(a.time.slice(0, 10))} — ${a.netAmount.toFixed(2)}
                </div>
              ))}
            </>
          )}

          {pending.length === 0 && <p style={{ fontSize: 13, opacity: 0.6 }}>Nothing new to review.</p>}
        </div>
      )}
    </div>
  );
}

// Inline, editable preview of the proposed Receipt voucher (narration, Dr/Cr account, amount)
// shown before anything is actually posted -- opened by "Add voucher"/"Add as dividend/interest"
// instead of posting immediately on click, so a wrong default account or an amount that needs
// adjusting can be caught before it becomes a real vault entry.
function IncomeReviewRow({
  accounts, narration, setNarration, debitId, setDebitId, creditId, setCreditId, amount, setAmount, busy, onConfirm, onCancel,
}: {
  accounts: { id: number; name: string; active?: boolean }[];
  narration: string;
  setNarration: (v: string) => void;
  debitId: number | "";
  setDebitId: (v: number | "") => void;
  creditId: number | "";
  setCreditId: (v: number | "") => void;
  amount: string;
  setAmount: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const active = accounts.filter((acc) => acc.active !== false);
  return (
    <div style={{ border: "1px solid #93c5fd", background: "#eff6ff", borderRadius: 8, padding: "0.7rem 0.8rem", marginBottom: "0.5rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <label>
          Narration
          <input type="text" value={narration} onChange={(e) => setNarration(e.target.value)} style={{ width: "100%", marginTop: 2 }} />
        </label>
        <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", alignItems: "center" }}>
          <label>
            Dr{" "}
            <select value={debitId} onChange={(e) => setDebitId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— choose —</option>
              {active.map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
            </select>
          </label>
          <label>
            Cr{" "}
            <select value={creditId} onChange={(e) => setCreditId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— choose —</option>
              {active.map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
            </select>
          </label>
          <label>
            Amount{" "}
            <input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 100 }} />
          </label>
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: 8 }}>
        <button className="tr-refresh-btn" disabled={busy || debitId === "" || creditId === ""} onClick={onConfirm}>
          {busy ? "Posting…" : "Post voucher"}
        </button>
        <button className="tr-refresh-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TransferInRow({ activity, busy, onConfirm, onDismiss }: { activity: SchwabActivity; busy: boolean; onConfirm: (units: number, price: number) => void; onDismiss: () => void }) {
  const inst = primaryInstrument(activity);
  const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "?";
  const [units, setUnits] = useState(String(Math.abs(inst?.amount ?? 0)));
  const [price, setPrice] = useState(String(inst?.price ?? 0));
  return (
    <div style={{ border: "1px solid #f0c987", background: "#fffaf0", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <span style={{ fontSize: 13 }}>
        <strong>{symbol}</strong>
        <span style={{ opacity: 0.6 }}> — {fmtDate((activity.tradeDate || activity.time).slice(0, 10))} — {activity.description}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        units <input value={units} onChange={(e) => setUnits(e.target.value)} style={{ width: 70 }} />
        @$ <input value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 80 }} />
        <button
          className="tr-refresh-btn"
          disabled={busy || !Number(units) || !Number(price)}
          onClick={() => onConfirm(Number(units), Number(price))}
        >
          {busy ? "Adding…" : "Confirm cost basis"}
        </button>
        <button className="tr-refresh-btn" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

function EquityActivityRow({
  activity, busy, pendingVests, onConfirmVest, onConfirmEspp, onDismiss,
}: {
  activity: SchwabActivity;
  busy: boolean;
  pendingVests: { grant: RsuGrant; vest: RsuVest }[];
  onConfirmVest: (grantId: string, vestId: string, vestPrice: number, sharesHeld: number, taxShares: number) => void;
  onConfirmEspp: (shares: number, purchasePrice: number, offeringPrice: number, marketPriceAtPurchase: number, purchaseDate: string) => void;
  onDismiss: () => void;
}) {
  const inst = primaryInstrument(activity);
  const symbol = inst?.instrument?.uniformSymbol || inst?.instrument?.symbol || "?";
  const activityDate = (activity.tradeDate || activity.time).slice(0, 10);
  const schwabQty = Math.abs(inst?.amount ?? 0);
  const schwabPrice = inst?.price ?? 0;

  const [mode, setMode] = useState<"none" | "vest" | "espp">("none");
  const [vestId, setVestId] = useState<string>(pendingVests[0]?.vest.id ?? "");
  const selected = pendingVests.find((p) => p.vest.id === vestId);
  const [vestPrice, setVestPrice] = useState(String(schwabPrice));
  const [sharesHeld, setSharesHeld] = useState(String(schwabQty));
  const [taxShares, setTaxShares] = useState(String(Math.max(0, (selected?.vest.shares ?? 0) - schwabQty)));

  const [esppShares, setEsppShares] = useState(String(schwabQty));
  const [esppPurchasePrice, setEsppPurchasePrice] = useState(String(schwabPrice));
  const [esppOfferingPrice, setEsppOfferingPrice] = useState("");
  const [esppMarketPrice, setEsppMarketPrice] = useState(String(schwabPrice));

  function pickVest(id: string) {
    setVestId(id);
    const p = pendingVests.find((x) => x.vest.id === id);
    setTaxShares(String(Math.max(0, (p?.vest.shares ?? 0) - schwabQty)));
  }

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.8rem", marginBottom: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 13 }}>
          <strong>{symbol}</strong> {schwabQty} sh @ ${schwabPrice.toFixed(2)}
          <span style={{ opacity: 0.6 }}> — {fmtDate(activityDate)} — {activity.description}</span>
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <button className="tr-refresh-btn" disabled={busy || pendingVests.length === 0} onClick={() => setMode(mode === "vest" ? "none" : "vest")}>
            Match vest {pendingVests.length > 0 ? `(${pendingVests.length} pending)` : "(none pending)"}
          </button>
          <button className="tr-refresh-btn" disabled={busy} onClick={() => setMode(mode === "espp" ? "none" : "espp")}>
            New ESPP purchase
          </button>
          <button className="tr-refresh-btn" disabled={busy} onClick={onDismiss}>Dismiss</button>
        </span>
      </div>

      {mode === "vest" && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e2e8f0", fontSize: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <select value={vestId} onChange={(e) => pickVest(e.target.value)}>
            {pendingVests.map(({ grant, vest }) => (
              <option key={vest.id} value={vest.id}>
                {grant.ticker} · {fmtDate(vest.vestDate)} · {vest.shares.toLocaleString()} sh scheduled
              </option>
            ))}
          </select>
          shares held <input value={sharesHeld} onChange={(e) => setSharesHeld(e.target.value)} style={{ width: 70 }} />
          tax shares <input value={taxShares} onChange={(e) => setTaxShares(e.target.value)} style={{ width: 70 }} />
          @$ <input value={vestPrice} onChange={(e) => setVestPrice(e.target.value)} style={{ width: 80 }} />
          <button
            className="tr-refresh-btn"
            disabled={busy || !selected || !Number(vestPrice)}
            onClick={() => selected && onConfirmVest(selected.grant.id, selected.vest.id, Number(vestPrice), Number(sharesHeld), Number(taxShares))}
          >
            {busy ? "Confirming…" : "Confirm vest"}
          </button>
        </div>
      )}

      {mode === "espp" && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e2e8f0", fontSize: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          shares <input value={esppShares} onChange={(e) => setEsppShares(e.target.value)} style={{ width: 70 }} />
          purchase $ <input value={esppPurchasePrice} onChange={(e) => setEsppPurchasePrice(e.target.value)} style={{ width: 80 }} />
          offering $ <input value={esppOfferingPrice} onChange={(e) => setEsppOfferingPrice(e.target.value)} style={{ width: 80 }} placeholder="discount price" />
          market $ <input value={esppMarketPrice} onChange={(e) => setEsppMarketPrice(e.target.value)} style={{ width: 80 }} />
          <button
            className="tr-refresh-btn"
            disabled={busy || !Number(esppShares) || !Number(esppPurchasePrice)}
            onClick={() => onConfirmEspp(Number(esppShares), Number(esppPurchasePrice), Number(esppOfferingPrice || esppPurchasePrice), Number(esppMarketPrice), activityDate)}
          >
            {busy ? "Adding…" : "Confirm ESPP purchase"}
          </button>
        </div>
      )}
    </div>
  );
}
