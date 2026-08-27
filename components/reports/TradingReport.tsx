"use client";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { WATCHLIST_DEFAULT } from "@/lib/watchlist-default";
import type { WatchlistEntry } from "@/lib/watchlist-default";
import type { Trade } from "@/lib/vault-types";
import { fmtDate } from "@/lib/format-date";
import { StatIcon } from "@/components/Icon";
import { FloatingWindow as Modal } from "@/components/FloatingWindow";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// One-time seed for the migration to persisted vault storage (see the `trades === undefined`
// effect below) -- stable "seed-N" ids so the migration is deterministic, not the trade data
// this app now reads from day to day.
const TRADING_SEED: Trade[] = ([
  { company: "MicroStrategy", symbol: "MSTR", broker: "CST", buyDate: "2025-07-22", units: 20, costPerSh: 420.71, marketOrSalePrice: 100.20, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CST", buyDate: "2025-07-22", units: 80, costPerSh: 186.20, marketOrSalePrice: 100.20, yesterday: 100.01 },
  { company: "Oracle", symbol: "ORCL", broker: "CST", buyDate: "2025-12-10", units: 44, costPerSh: 219.59, marketOrSalePrice: 149.80, yesterday: 147.02 },
  { company: "Sarepta Therapeutics", symbol: "SRPT", broker: "CST", buyDate: "2025-10-28", units: 300, costPerSh: 24.30, marketOrSalePrice: 16.645, yesterday: 16.78 },
  { company: "Nokia", symbol: "NOK", broker: "CSS", buyDate: "2025-10-28", saleDate: "2026-03-12", units: 1000, costPerSh: 7.49, marketOrSalePrice: 8.25, yesterday: 9.26 },
  { company: "Palantir", symbol: "PLTR", broker: "CSS", buyDate: "2025-02-20", saleDate: "2025-12-09", units: 50, costPerSh: 96.00, marketOrSalePrice: 182.30, yesterday: 179.04 },
  { company: "Oklo", symbol: "OKLO", broker: "CSS", buyDate: "2025-09-17", saleDate: "2025-10-10", units: 150, costPerSh: 94.68, marketOrSalePrice: 155.75, yesterday: 45.32 },
  { company: "Robinhood", symbol: "HOOD", broker: "CSS", buyDate: "2025-08-07", saleDate: "2025-09-30", units: 135, costPerSh: 110.00, marketOrSalePrice: 142.25, yesterday: 93.29 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-12-10", saleDate: "2024-12-11", units: 10, costPerSh: 371.00, marketOrSalePrice: 405.00, yesterday: 100.01 },
  { company: "Broadcom", symbol: "AVGO", broker: "CSS", buyDate: "2024-12-12", saleDate: "2025-02-07", units: 50, costPerSh: 178.00, marketOrSalePrice: 232.55, yesterday: 427.76 },
  { company: "Uber", symbol: "UBER", broker: "CSS", buyDate: "2025-07-15", saleDate: "2025-09-15", units: 150, costPerSh: 92.10, marketOrSalePrice: 96.80, yesterday: 75.02 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-12-10", saleDate: "2025-08-01", units: 50, costPerSh: 391.00, marketOrSalePrice: 301.21, yesterday: 328.58 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-12-19", saleDate: "2025-01-17", units: 50, costPerSh: 345.00, marketOrSalePrice: 443.00, yesterday: 100.01 },
  { company: "Super Micro", symbol: "SMCI", broker: "CSS", buyDate: "2024-12-16", saleDate: "2025-02-10", units: 150, costPerSh: 33.35, marketOrSalePrice: 38.50, yesterday: 31.13 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2025-01-27", saleDate: "2025-07-15", units: 50, costPerSh: 365.44, marketOrSalePrice: 388.00, yesterday: 100.01 },
  { company: "Meta", symbol: "META", broker: "CSS", buyDate: "2024-11-15", saleDate: "2024-11-18", units: 88, costPerSh: 558.60, marketOrSalePrice: 554.12, yesterday: 592.10 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-11-22", saleDate: "2024-11-22", units: 25, costPerSh: 405.90, marketOrSalePrice: 425.00, yesterday: 100.01 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-11-25", saleDate: "2024-11-29", units: 150, costPerSh: 339.00, marketOrSalePrice: 343.00, yesterday: 328.58 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-11-18", saleDate: "2024-11-22", units: 148, costPerSh: 331.55, marketOrSalePrice: 342.00, yesterday: 328.58 },
  { company: "Apple", symbol: "AAPL", broker: "RBS", buyDate: "2020-10-28", saleDate: "2024-11-13", units: 9.10, costPerSh: 113.18, marketOrSalePrice: 223.96, yesterday: 313.06 },
  { company: "Nio", symbol: "NIO", broker: "RBS", buyDate: "2020-11-13", saleDate: "2024-11-13", units: 2552, costPerSh: 9.82, marketOrSalePrice: 4.67, yesterday: 4.74 },
  { company: "Workhorse", symbol: "WKHS", broker: "RBS", buyDate: "2021-03-09", saleDate: "2024-11-05", units: 9, costPerSh: 222.22, marketOrSalePrice: 0.76, yesterday: 3.33 },
  { company: "DraftKings", symbol: "DKNG", broker: "RBS", buyDate: "2020-11-13", saleDate: "2024-03-21", units: 68.8, costPerSh: 44.04, marketOrSalePrice: 47.65, yesterday: 24.03 },
  { company: "Meta", symbol: "META", broker: "RBS", buyDate: "2024-10-17", saleDate: "2024-11-18", units: 347, costPerSh: 571.56, marketOrSalePrice: 552.85, yesterday: 592.10 },
  { company: "Tesla", symbol: "TSLA", broker: "RBS", buyDate: "2024-11-18", saleDate: "2024-11-22", units: 605, costPerSh: 343.10, marketOrSalePrice: 347.50, yesterday: 328.58 },
  { company: "Tesla", symbol: "TSLA", broker: "RBS", buyDate: "2024-11-25", saleDate: "2024-11-27", units: 450, costPerSh: 353.20, marketOrSalePrice: 348.90, yesterday: 328.58 },
  { company: "Block (SQ)", symbol: "SQ", broker: "RBS", buyDate: "2024-11-27", saleDate: "2024-12-04", units: 80, costPerSh: 96.00, marketOrSalePrice: 95.37, yesterday: 79.00 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-12-09", saleDate: "2024-12-11", units: 32, costPerSh: 378.50, marketOrSalePrice: 405.00, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-12-05", saleDate: "2024-12-06", units: 12, costPerSh: 391.50, marketOrSalePrice: 401.50, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-11-27", saleDate: "2024-12-04", units: 135, costPerSh: 377.00, marketOrSalePrice: 407.50, yesterday: 100.01 },
] as Omit<Trade, "id">[]).map((t, i) => ({ ...t, id: `seed-${i}` }));

const BLANK_TRADE_FORM = { company: "", symbol: "", broker: "CST" as Trade["broker"], buyDate: "", units: "", costPerSh: "", saleDate: "", salePrice: "" };

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const BROKER_LABEL: Record<string, string> = { CST: "Charles Schwab (CST)", CSS: "Charles Schwab (CSS)", RBS: "Robinhood (RBS)" };

// Symbols that live in the Equity report instead of Trading (RSU/ESPP), even though they show
// up as regular positions in the same Schwab account -- never synced into Trading as a "trade".
const SCHWAB_SYNC_EXCLUDE = new Set(["NVDA"]);
// Schwab's OAuth connection only covers one linked account, which matches the "CST" broker label
// in this app's existing trade data (verified against real positions) -- sync only ever targets
// that broker; CSS/RBS stay fully manual since they aren't connected.
const SCHWAB_SYNC_BROKER: Trade["broker"] = "CST";

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
// detail is available, see lib/schwab-oauth.ts / the transactions route) against what's already
// tracked in Trading, and proposes changes. Never applied automatically -- see applySchwabSync
// below, which only runs once the user reviews and confirms this plan.
function computeSchwabSyncPlan(trades: Trade[], positions: SchwabPosition[]): SchwabSyncAction[] {
  const actions: SchwabSyncAction[] = [];
  const openForBroker = trades.filter((t) => !t.saleDate && t.broker === SCHWAB_SYNC_BROKER && !SCHWAB_SYNC_EXCLUDE.has(t.symbol));
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
function applySchwabSync(trades: Trade[], actions: SchwabSyncAction[], todayIso: string, priceForSymbol: (sym: string) => number): Trade[] {
  let next = [...trades];
  for (const a of actions) {
    if (a.kind === "new" || a.kind === "increase") {
      next.push({
        id: uid(), symbol: a.symbol, company: a.company, broker: SCHWAB_SYNC_BROKER, buyDate: todayIso,
        units: a.deltaUnits, costPerSh: a.estPrice, marketOrSalePrice: a.estPrice, yesterday: a.estPrice,
      });
      continue;
    }
    let remaining = a.deltaUnits;
    const salePrice = priceForSymbol(a.symbol) || a.estPrice;
    const openLots = next
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !t.saleDate && t.symbol === a.symbol && t.broker === SCHWAB_SYNC_BROKER)
      .sort((x, y) => x.t.buyDate.localeCompare(y.t.buyDate));
    for (const { t, i } of openLots) {
      if (remaining <= 0.0001) break;
      if (t.units <= remaining + 0.0001) {
        next[i] = { ...t, saleDate: todayIso, marketOrSalePrice: salePrice };
        remaining -= t.units;
      } else {
        next[i] = { ...t, units: t.units - remaining };
        next.push({ ...t, id: uid(), units: remaining, saleDate: todayIso, marketOrSalePrice: salePrice });
        remaining = 0;
      }
    }
  }
  return next;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 13 * 60 + 30 && utcMin < 20 * 60; // 9:30–16:00 ET (covers EDT & EST)
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function daysBetween(d1: string, d2: string) {
  return Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86400000);
}
export function TradingReport({
  fmt, uiTheme, trades, onSave,
}: {
  fmt: (n: number) => string;
  uiTheme?: "classic" | "refresh";
  trades: Trade[] | undefined; // undefined = never migrated to vault storage yet, see effect below
  onSave: (trades: Trade[]) => Promise<void>;
}) {
  const [activeTab, setActiveTab]     = useState<"open" | "closed" | "watchlist">("open");
  // Click-any-column-header sorting, Excel-style: null = default order, otherwise sort by that
  // column's key, toggling direction on repeated clicks. Open and Closed tables sort independently.
  const [openSort, setOpenSort]     = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [closedSort, setClosedSort] = useState<{ key: string; dir: 1 | -1 } | null>({ key: "buyDate", dir: -1 });
  function toggleSort(current: { key: string; dir: 1 | -1 } | null, setSort: (s: { key: string; dir: 1 | -1 }) => void, key: string) {
    if (current?.key === key) setSort({ key, dir: current.dir === 1 ? -1 : 1 });
    else setSort({ key, dir: 1 });
  }
  function sortTh(
    label: string, key: string,
    sort: { key: string; dir: 1 | -1 } | null,
    setSort: (s: { key: string; dir: 1 | -1 }) => void,
    align: "left" | "right" = "right"
  ) {
    const active = sort?.key === key;
    return (
      <th
        className={`tr-th-sortable${align === "right" ? " right" : ""}${active ? " tr-th-sortable--active" : ""}`}
        onClick={() => toggleSort(sort, setSort, key)}
      >
        {label}{active && (sort!.dir === 1 ? " ▲" : " ▼")}
      </th>
    );
  }
  const [watchFilter, setWatchFilter] = useState<"all" | "short" | "long" | "cyclical">("all");

  // ── Schwab connection status (Phase 1: OAuth only, no live data wired in yet) ────────────
  const [schwabStatus, setSchwabStatus] = useState<
    { connected: false } | { connected: true; daysUntilReauth: number } | null
  >(null);
  useEffect(() => {
    fetch("/api/schwab/status")
      .then((r) => r.json())
      .then((raw: unknown) => {
        const d = raw as { connected: boolean; daysUntilReauth?: number };
        setSchwabStatus(d.connected ? { connected: true, daysUntilReauth: d.daysUntilReauth ?? 0 } : { connected: false });
      })
      .catch(() => setSchwabStatus({ connected: false }));
  }, []);
  async function disconnectSchwabClick() {
    if (!confirm("Disconnect from Schwab? You can reconnect any time.")) return;
    await fetch("/api/schwab/status", { method: "DELETE" });
    setSchwabStatus({ connected: false });
  }

  // The actual trade list this report reads/writes -- falls back to the fixed seed only until
  // the one-time migration below persists it to the vault (or the user's first edit does).
  const effectiveTrades = trades ?? TRADING_SEED;
  const [showTradeForm, setShowTradeForm] = useState(false);
  const [editTradeId, setEditTradeId]     = useState<string | null>(null);
  const [tradeForm, setTradeForm]         = useState(BLANK_TRADE_FORM);
  const [savingTrade, setSavingTrade]     = useState(false);

  // One-time migration: the first time this report loads for a vault that predates persisted
  // trades, write the seed data into the vault so it's no longer just hardcoded in source --
  // from then on `trades` is always defined (even if the user later deletes everything down to
  // an empty array), so this never fires again.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (trades === undefined && !migratedRef.current) {
      migratedRef.current = true;
      onSave(TRADING_SEED);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades]);

  function openAddTrade() {
    setEditTradeId(null);
    setTradeForm(BLANK_TRADE_FORM);
    setShowTradeForm(true);
  }
  function openEditTrade(t: Trade) {
    setEditTradeId(t.id);
    setTradeForm({
      company: t.company, symbol: t.symbol, broker: t.broker, buyDate: t.buyDate,
      units: String(t.units), costPerSh: String(t.costPerSh),
      saleDate: t.saleDate ?? "", salePrice: t.saleDate ? String(t.marketOrSalePrice) : "",
    });
    setShowTradeForm(true);
  }
  function closeTradeForm() {
    setShowTradeForm(false);
    setEditTradeId(null);
    setTradeForm(BLANK_TRADE_FORM);
  }
  async function saveTradeForm() {
    setSavingTrade(true);
    try {
      const closing = tradeForm.saleDate.trim() !== "";
      const units = Number(tradeForm.units);
      const costPerSh = Number(tradeForm.costPerSh);
      if (editTradeId) {
        const next = effectiveTrades.map((t) =>
          t.id === editTradeId
            ? {
                ...t,
                company: tradeForm.company, symbol: tradeForm.symbol.toUpperCase(), broker: tradeForm.broker,
                buyDate: tradeForm.buyDate, units, costPerSh,
                saleDate: closing ? tradeForm.saleDate : undefined,
                marketOrSalePrice: closing ? Number(tradeForm.salePrice) : t.marketOrSalePrice,
              }
            : t
        );
        await onSave(next);
      } else {
        const t: Trade = {
          id: uid(), company: tradeForm.company, symbol: tradeForm.symbol.toUpperCase(), broker: tradeForm.broker,
          buyDate: tradeForm.buyDate, units, costPerSh,
          saleDate: closing ? tradeForm.saleDate : undefined,
          marketOrSalePrice: closing ? Number(tradeForm.salePrice) : costPerSh,
          yesterday: costPerSh,
        };
        await onSave([...effectiveTrades, t]);
      }
      closeTradeForm();
    } finally {
      setSavingTrade(false);
    }
  }
  async function deleteTrade(id: string) {
    if (!confirm("Delete this trade record? This can't be undone.")) return;
    await onSave(effectiveTrades.filter((t) => t.id !== id));
    closeTradeForm();
  }

  // ── Layer 1: Live prices with auto-refresh ───────────────────────────────
  const [livePrices, setLivePrices]       = useState<Record<string, { price: number; prevClose: number | null }>>({});
  const [priceLoading, setPriceLoading]   = useState(true);
  const [pricesRefreshing, setPricesRefreshing] = useState(false);
  const [lastPriceUpdate, setLastPriceUpdate]   = useState<Date | null>(null);

  // ── Layer 2: Watchlist from KV ───────────────────────────────────────────
  const [watchlistItems, setWatchlistItems] = useState<WatchlistEntry[]>(WATCHLIST_DEFAULT);
  const [watchlistMeta, setWatchlistMeta]   = useState<{ updatedAt: string | null; source: string | null; marketSnapshot?: { spy?: number; qqq?: number; vix?: number } }>({ updatedAt: null, source: null });

  // ── Layer 3: AI refresh state ────────────────────────────────────────────
  const [aiRefreshing, setAiRefreshing]     = useState(false);
  const [aiError, setAiError]               = useState<string | null>(null);
  const [alertsExpanded, setAlertsExpanded] = useState(false);
  const aiTriggeredRef                  = useRef(false);

  const currentMonth = new Date().getMonth() + 1;
  const inBuyWindow  = (w: WatchlistEntry) => w.buyMonths?.includes(currentMonth) ?? false;
  const inSellWindow = (w: WatchlistEntry) => w.sellMonths?.includes(currentMonth) ?? false;

  // All symbols to fetch prices for (open positions + watchlist)
  const allFetchSymbols = useMemo(() => {
    const open  = [...new Set(effectiveTrades.filter(t => !t.saleDate).map(t => t.symbol))];
    const watch = [...new Set(watchlistItems.map(w => w.symbol))];
    return [...new Set([...open, ...watch])];
  }, [watchlistItems]);

  // ── Layer 1: price fetch ─────────────────────────────────────────────────
  const fetchPrices = useCallback(async (initial = false) => {
    if (initial) setPriceLoading(true); else setPricesRefreshing(true);
    try {
      const results = await Promise.all(
        allFetchSymbols.map(sym =>
          fetch(`/api/equity-price?ticker=${sym}`)
            .then(r => r.json())
            .then((d: unknown) => {
              const r = d as { price?: number | null; previousClose?: number | null };
              return { sym, price: typeof r.price === "number" ? r.price : null, prevClose: typeof r.previousClose === "number" ? r.previousClose : null };
            })
            .catch(() => ({ sym, price: null, prevClose: null }))
        )
      );
      const map: Record<string, { price: number; prevClose: number | null }> = {};
      for (const r of results) if (r.price !== null) map[r.sym] = { price: r.price, prevClose: r.prevClose };
      setLivePrices(map);
      setLastPriceUpdate(new Date());
    } finally {
      setPriceLoading(false);
      setPricesRefreshing(false);
    }
  }, [allFetchSymbols]);

  // Initial fetch + 5-min auto-refresh (market hours only)
  useEffect(() => {
    fetchPrices(true);
    const id = setInterval(() => { if (isMarketOpen()) fetchPrices(false); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchPrices]);

  // ── Layer 3: AI refresh ──────────────────────────────────────────────────
  const triggerAIRefresh = useCallback(async () => {
    setAiRefreshing(true);
    setAiError(null);
    try {
      const res  = await fetch("/api/watchlist/refresh", { method: "POST" });
      const data = await res.json() as { items?: WatchlistEntry[]; updatedAt?: string; source?: string; marketSnapshot?: { spy?: number; qqq?: number; vix?: number }; error?: string };
      if (data.items && data.items.length > 0) {
        setWatchlistItems(data.items);
        setWatchlistMeta({ updatedAt: data.updatedAt ?? null, source: data.source ?? null, marketSnapshot: data.marketSnapshot });
      } else {
        setAiError(data.error ?? "Unknown error from AI refresh");
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiRefreshing(false);
    }
  }, []);

  // ── Layer 2: load watchlist from KV on mount ─────────────────────────────
  useEffect(() => {
    fetch("/api/watchlist")
      .then(r => r.json())
      .then((raw: unknown) => {
        const data = raw as { items?: WatchlistEntry[]; updatedAt?: string | null; source?: string | null; marketSnapshot?: { spy?: number; qqq?: number; vix?: number } };
        if (data.items && data.items.length > 0) {
          setWatchlistItems(data.items);
          setWatchlistMeta({ updatedAt: data.updatedAt ?? null, source: data.source ?? null, marketSnapshot: data.marketSnapshot });
        }
      })
      .catch(() => { /* keep defaults */ });
  }, []);

  // Auto-trigger AI refresh when watchlist tab opens if data is stale (>6h) or never AI-refreshed
  useEffect(() => {
    if (activeTab !== "watchlist" || aiTriggeredRef.current || aiRefreshing) return;
    const isStale = !watchlistMeta.updatedAt || watchlistMeta.source !== "claude-ai" ||
      (Date.now() - new Date(watchlistMeta.updatedAt).getTime() > 6 * 60 * 60 * 1000);
    if (isStale) {
      aiTriggeredRef.current = true;
      triggerAIRefresh();
    }
  }, [activeTab, watchlistMeta, aiRefreshing, triggerAIRefresh]);

  // ── Trading calculations ─────────────────────────────────────────────────
  const livePrice    = (sym: string, fallback: number) => livePrices[sym]?.price ?? fallback;
  const livePrevClose = (sym: string, fallback: number) => livePrices[sym]?.prevClose ?? fallback;

  // ── Schwab position sync (preview-then-confirm; never writes silently) ──────────────────
  const [syncActions, setSyncActions] = useState<SchwabSyncAction[] | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError]     = useState<string | null>(null);
  const [syncApplying, setSyncApplying] = useState(false);
  async function loadSchwabSyncPreview() {
    setSyncLoading(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/schwab/positions");
      const data = (await res.json()) as {
        accounts?: Array<{ positions?: SchwabPosition[]; error?: string }>;
        error?: string;
      };
      if (data.error) throw new Error(data.error);
      const positions = (data.accounts ?? []).flatMap((a) => a.positions ?? []);
      const plan = computeSchwabSyncPlan(effectiveTrades, positions);
      setSyncActions(plan);
    } catch (e) {
      setSyncError(String(e instanceof Error ? e.message : e));
      setSyncActions([]);
    } finally {
      setSyncLoading(false);
    }
  }
  async function applySyncPlan() {
    if (!syncActions || syncActions.length === 0) return;
    setSyncApplying(true);
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const next = applySchwabSync(effectiveTrades, syncActions, todayIso, (sym) => livePrice(sym, 0));
      await onSave(next);
      setSyncActions(null);
    } finally {
      setSyncApplying(false);
    }
  }

  const open   = effectiveTrades.filter(t => !t.saleDate);
  const closed = effectiveTrades.filter(t => !!t.saleDate);

  const curPrice  = (t: Trade) => t.saleDate ? t.marketOrSalePrice : livePrice(t.symbol, t.marketOrSalePrice);
  const prevClose = (t: Trade) => t.saleDate ? t.yesterday : livePrevClose(t.symbol, t.yesterday);
  const glOf      = (t: Trade) => t.units * (curPrice(t) - t.costPerSh);
  const pctOf     = (t: Trade) => ((curPrice(t) - t.costPerSh) / t.costPerSh) * 100;
  const costOf    = (t: Trade) => t.units * t.costPerSh;
  const vsToday   = (t: Trade) => t.units * (curPrice(t) - prevClose(t));

  const totalUnrealized = open.reduce((s, t) => s + glOf(t), 0);
  const totalRealized   = closed.reduce((s, t) => s + glOf(t), 0);
  const netPL           = totalUnrealized + totalRealized;
  const totalDailyGL    = open.reduce((s, t) => s + vsToday(t), 0);

  const brokerGL: Record<string, number> = {};
  effectiveTrades.forEach(t => { brokerGL[t.broker] = (brokerGL[t.broker] ?? 0) + glOf(t); });

  // IRS holding-period rule (26 U.S.C. § 1222): long-term once held for MORE than a year --
  // matches the 365-day threshold this app's own tax engine uses elsewhere (lib/tax-usa-rules.ts).
  // For an open position that's "as of today" (and can flip Short -> Long while still held);
  // for a closed one it's the actual realized holding period that determines real tax treatment.
  const todayIso = new Date().toISOString().slice(0, 10);
  const heldDaysOf = (t: Trade) => daysBetween(t.buyDate, t.saleDate ?? todayIso);
  const isLongTerm = (t: Trade) => heldDaysOf(t) >= 365;

  const openRowsBase = open.map((t) => {
    const gl = glOf(t), pct = pctOf(t), mv = t.units * curPrice(t), tc = costOf(t);
    const dailyGL = t.units * (curPrice(t) - prevClose(t));
    const dailyPct = ((curPrice(t) - prevClose(t)) / prevClose(t)) * 100;
    return { t, gl, pct, mv, tc, dailyGL, dailyPct, curP: curPrice(t), isLong: isLongTerm(t) };
  });
  const openSortGetters: Record<string, (r: (typeof openRowsBase)[number]) => string | number> = {
    symbol: (r) => r.t.symbol,
    term: (r) => (r.isLong ? 1 : 0),
    buyDate: (r) => r.t.buyDate,
    units: (r) => r.t.units,
    costPerSh: (r) => r.t.costPerSh,
    totalCost: (r) => r.tc,
    currentPrice: (r) => r.curP,
    marketValue: (r) => r.mv,
    gl: (r) => r.gl,
    dailyGL: (r) => r.dailyGL,
  };
  const openRows = openSort
    ? [...openRowsBase].sort((a, b) => {
        const va = openSortGetters[openSort.key](a), vb = openSortGetters[openSort.key](b);
        return (va < vb ? -1 : va > vb ? 1 : 0) * openSort.dir;
      })
    : openRowsBase;

  const closedRowsBase = closed.map((t) => {
    const gl = glOf(t), pct = pctOf(t), tc = costOf(t);
    const proceeds = t.units * t.marketOrSalePrice;
    const days = daysBetween(t.buyDate, t.saleDate!);
    return { t, gl, pct, tc, proceeds, days, isLong: isLongTerm(t) };
  });
  const closedSortGetters: Record<string, (r: (typeof closedRowsBase)[number]) => string | number> = {
    symbol: (r) => r.t.symbol,
    term: (r) => (r.isLong ? 1 : 0),
    buyDate: (r) => r.t.buyDate,
    saleDate: (r) => r.t.saleDate!,
    days: (r) => r.days,
    units: (r) => r.t.units,
    costPerSh: (r) => r.t.costPerSh,
    salePerSh: (r) => r.t.marketOrSalePrice,
    totalCost: (r) => r.tc,
    proceeds: (r) => r.proceeds,
    gl: (r) => r.gl,
  };
  const sortedClosed = closedSort
    ? [...closedRowsBase].sort((a, b) => {
        const va = closedSortGetters[closedSort.key](a), vb = closedSortGetters[closedSort.key](b);
        return (va < vb ? -1 : va > vb ? 1 : 0) * closedSort.dir;
      })
    : closedRowsBase;

  const glClass = (v: number) => v > 0 ? "tr-gain-pos" : v < 0 ? "tr-gain-neg" : "";
  const badge   = (v: number) => v >= 0 ? "tr-badge-pos" : "tr-badge-neg";

  const missedGains     = closed.filter(t => glOf(t) > 0 && t.yesterday > t.marketOrSalePrice);
  const longSpeculative = closed.filter(t => daysBetween(t.buyDate, t.saleDate!) > 365 && glOf(t) < 0);
  const mstrTrades      = effectiveTrades.filter(t => t.symbol === "MSTR");
  const mstrConc        = (mstrTrades.reduce((s, t) => s + costOf(t), 0) / effectiveTrades.reduce((s, t) => s + costOf(t), 0)) * 100;

  return (
    <div className="trading-report">
      {/* Summary bar */}
      <div className="tr-summary-bar">
        <div className="tr-summary-card tr-summary-card--neutral">
          {uiTheme === "refresh" && <StatIcon kind="stock" color="#64748b" />}
          <div className="tr-summary-card-body">
            <span>Open Positions</span>
            <strong>{open.length}</strong>
          </div>
        </div>
        <div className={`tr-summary-card ${totalUnrealized < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          {uiTheme === "refresh" && <StatIcon kind="trending-up" color={totalUnrealized < 0 ? "#dc2626" : "#16a34a"} />}
          <div className="tr-summary-card-body">
            <span>Unrealized G/(L)</span>
            <strong className="trading-amt">{fmt(totalUnrealized)}</strong>
          </div>
        </div>
        <div className={`tr-summary-card ${totalRealized < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          {uiTheme === "refresh" && <StatIcon kind="cash" color={totalRealized < 0 ? "#dc2626" : "#16a34a"} />}
          <div className="tr-summary-card-body">
            <span>Realized G/(L)</span>
            <strong className="trading-amt">{fmt(totalRealized)}</strong>
          </div>
        </div>
        <div className={`tr-summary-card ${netPL < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          {uiTheme === "refresh" && <StatIcon kind="scale" color={netPL < 0 ? "#dc2626" : "#16a34a"} />}
          <div className="tr-summary-card-body">
            <span>Net P&amp;L</span>
            <strong className="trading-amt">{fmt(netPL)}</strong>
          </div>
        </div>
        <div className={`tr-summary-card ${totalDailyGL < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          {uiTheme === "refresh" && <StatIcon kind="calendar" color={totalDailyGL < 0 ? "#dc2626" : "#16a34a"} />}
          <div className="tr-summary-card-body">
            <span>Daily G/(L)</span>
            <strong className="trading-amt">{totalDailyGL >= 0 ? "+" : ""}{fmt(totalDailyGL)}</strong>
          </div>
        </div>
        <div className="tr-summary-card tr-summary-card--neutral">
          {uiTheme === "refresh" && <StatIcon kind="receipt" color="#64748b" />}
          <div className="tr-summary-card-body">
            <span>Total Trades</span>
            <strong>{effectiveTrades.length}</strong>
          </div>
        </div>
      </div>

      {/* Price refresh status bar */}
      <div className="tr-price-bar">
        <span className="tr-price-status">
          {priceLoading ? "Loading prices…" : pricesRefreshing ? "Refreshing…" : lastPriceUpdate ? `Prices updated ${timeAgo(lastPriceUpdate.toISOString())} · auto-refresh every 5 min${isMarketOpen() ? " (market open)" : " (market closed)"}` : ""}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          {schwabStatus?.connected === true ? (
            <span style={{ fontSize: 12, color: schwabStatus.daysUntilReauth <= 1 ? "#dc2626" : "#16a34a" }}>
              ✓ Schwab connected
              {schwabStatus.daysUntilReauth <= 1 ? " — re-auth needed today" : ` — re-auth in ${schwabStatus.daysUntilReauth}d`}
              {" "}<button className="tr-refresh-btn" onClick={disconnectSchwabClick}>Disconnect</button>
              {" "}<button className="tr-refresh-btn" onClick={loadSchwabSyncPreview} disabled={syncLoading}>
                {syncLoading ? "Checking…" : "🔄 Sync from Schwab"}
              </button>
            </span>
          ) : schwabStatus?.connected === false ? (
            <a href="/api/schwab/authorize" className="tr-refresh-btn" style={{ textDecoration: "none" }}>
              🔗 Connect Schwab
            </a>
          ) : null}
          <button className="tr-refresh-btn" onClick={() => fetchPrices(false)} disabled={priceLoading || pricesRefreshing}>
            ↻ Refresh prices
          </button>
        </div>
      </div>

      {/* Broker breakdown */}
      <div className="tr-broker-row">
        {Object.entries(brokerGL).map(([b, gl]) => (
          <div key={b} className="tr-broker-chip">
            <span className="tr-broker-name">{BROKER_LABEL[b] ?? b}</span>
            <span className={`tr-broker-gl ${glClass(gl)}`}>{fmt(gl)}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tr-tabs" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <button className={activeTab === "open"      ? "selected" : ""} onClick={() => setActiveTab("open")}>Open Positions ({open.length})</button>
          <button className={activeTab === "closed"    ? "selected" : ""} onClick={() => setActiveTab("closed")}>Closed Positions ({closed.length})</button>
          <button className={activeTab === "watchlist" ? "selected" : ""} onClick={() => setActiveTab("watchlist")}>Watchlist ({watchlistItems.length})</button>
        </div>
        {activeTab !== "watchlist" && (
          <button onClick={openAddTrade}>+ Add Trade</button>
        )}
      </div>

      {showTradeForm && (
        <Modal title={editTradeId ? "Edit Trade" : "New Trade"} onClose={closeTradeForm}>
          <div className="equity-form-grid">
            <label>
              Company
              <input value={tradeForm.company} onChange={(e) => setTradeForm((f) => ({ ...f, company: e.target.value }))} placeholder="MicroStrategy" />
            </label>
            <label>
              Symbol
              <input value={tradeForm.symbol} onChange={(e) => setTradeForm((f) => ({ ...f, symbol: e.target.value }))} placeholder="MSTR" />
            </label>
            <label>
              Broker
              <select value={tradeForm.broker} onChange={(e) => setTradeForm((f) => ({ ...f, broker: e.target.value as Trade["broker"] }))}>
                <option value="CST">Charles Schwab (CST)</option>
                <option value="CSS">Charles Schwab (CSS)</option>
                <option value="RBS">Robinhood (RBS)</option>
              </select>
            </label>
            <label>
              Buy Date
              <input type="date" value={tradeForm.buyDate} onChange={(e) => setTradeForm((f) => ({ ...f, buyDate: e.target.value }))} />
            </label>
            <label>
              Units
              <input type="number" value={tradeForm.units} onChange={(e) => setTradeForm((f) => ({ ...f, units: e.target.value }))} step="any" placeholder="100" />
            </label>
            <label>
              Cost/Share
              <input type="number" value={tradeForm.costPerSh} onChange={(e) => setTradeForm((f) => ({ ...f, costPerSh: e.target.value }))} step="0.01" placeholder="150.00" />
            </label>
            <label>
              Sale Date <em style={{ fontWeight: 400 }}>(leave blank if still open)</em>
              <input type="date" value={tradeForm.saleDate} onChange={(e) => setTradeForm((f) => ({ ...f, saleDate: e.target.value }))} />
            </label>
            {tradeForm.saleDate.trim() !== "" && (
              <label>
                Sale Price/Share
                <input type="number" value={tradeForm.salePrice} onChange={(e) => setTradeForm((f) => ({ ...f, salePrice: e.target.value }))} step="0.01" placeholder="180.00" />
              </label>
            )}
          </div>
          <div className="equity-form-actions">
            <button
              onClick={saveTradeForm}
              disabled={
                savingTrade || !tradeForm.company || !tradeForm.symbol || !tradeForm.buyDate ||
                !tradeForm.units || !tradeForm.costPerSh ||
                (tradeForm.saleDate.trim() !== "" && !tradeForm.salePrice)
              }
            >
              {savingTrade ? "Saving…" : editTradeId ? "Save Changes" : "Add Trade"}
            </button>
            <button onClick={closeTradeForm} disabled={savingTrade}>Cancel</button>
            {editTradeId && (
              <button
                onClick={() => deleteTrade(editTradeId)}
                disabled={savingTrade}
                style={{ marginLeft: "auto", color: "#dc2626" }}
              >
                🗑 Delete Trade
              </button>
            )}
          </div>
        </Modal>
      )}

      {syncActions !== null && (
        <Modal title="Sync from Schwab" onClose={() => setSyncActions(null)} wide>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 1rem" }}>
            Compares your real Schwab positions (quantity + blended average cost) against what's
            tracked here for Charles Schwab (CST). Schwab doesn't expose individual trade dates or
            prices to this app, so any new/changed lot below uses an <strong>estimated</strong> date
            (today) and price — review before applying. NVDA is never included here; it's tracked
            in the Equity report instead.
          </p>
          {syncError && <p style={{ fontSize: 12, color: "#dc2626", margin: "0 0 1rem" }}>Error: {syncError}</p>}
          {syncActions.length === 0 && !syncError && (
            <p style={{ fontSize: 13 }}>Everything matches — no changes proposed.</p>
          )}
          {syncActions.map((a, i) => (
            <div key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.65rem 0.85rem", marginBottom: "0.5rem" }}>
              <strong style={{ fontSize: 13 }}>
                {a.symbol} — {a.kind === "new" ? "New position" : a.kind === "increase" ? "Add to position" : a.kind === "reduce" ? "Partial sale" : "Fully sold"}
              </strong>
              <p style={{ fontSize: 12, margin: "0.3rem 0 0", color: "#334155" }}>{a.note}</p>
            </div>
          ))}
          <div className="equity-form-actions">
            <button onClick={applySyncPlan} disabled={syncApplying || syncActions.length === 0}>
              {syncApplying ? "Applying…" : "Apply Sync"}
            </button>
            <button onClick={() => setSyncActions(null)} disabled={syncApplying}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ── Open Positions ── */}
      {activeTab === "open" && (
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead><tr>
              {sortTh("Stock", "symbol", openSort, setOpenSort, "left")}
              {sortTh("Term", "term", openSort, setOpenSort)}
              {sortTh("Buy Date", "buyDate", openSort, setOpenSort)}
              {sortTh("Units", "units", openSort, setOpenSort)}
              {sortTh("Cost/Sh", "costPerSh", openSort, setOpenSort)}
              {sortTh("Total Cost", "totalCost", openSort, setOpenSort)}
              {sortTh("Current Price", "currentPrice", openSort, setOpenSort)}
              {sortTh("Market Value", "marketValue", openSort, setOpenSort)}
              {sortTh("G/(L)", "gl", openSort, setOpenSort)}
              {sortTh("Daily G/(L)", "dailyGL", openSort, setOpenSort)}
            </tr></thead>
            <tbody>
              {openRows.map(({ t, gl, pct, mv, tc, dailyGL, dailyPct, isLong }) => (
                <tr key={t.id} className={`tr-row-clickable ${gl < 0 ? "tr-row-loss" : "tr-row-gain"}`} onClick={() => openEditTrade(t)}>
                  <td><div className="tr-stock-cell"><span className="tr-symbol">{t.symbol}</span><span className="tr-company-sub">{t.company}</span></div></td>
                  <td className="right"><span className={`tr-term-badge ${isLong ? "tr-term-badge--long" : "tr-term-badge--short"}`}>{isLong ? "Long" : "Short"}</span></td>
                  <td className="right">{fmtDate(t.buyDate)}</td>
                  <td className="right trading-amt">{t.units % 1 === 0 ? t.units : t.units.toFixed(2)}</td>
                  <td className="right trading-amt">${t.costPerSh.toFixed(2)}</td>
                  <td className="right trading-amt">{fmt(tc)}</td>
                  <td className="right trading-amt">
                    ${curPrice(t).toFixed(2)}
                    {priceLoading && !livePrices[t.symbol] && <span style={{fontSize:"9px",color:"#94a3b8",marginLeft:"3px"}}>…</span>}
                  </td>
                  <td className="right trading-amt">{fmt(mv)}</td>
                  <td className="right"><div className="tr-gl-cell"><span className={`trading-amt ${glClass(gl)}`}>{fmt(gl)}</span><span className={`tr-badge ${badge(pct)}`}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span></div></td>
                  <td className="right"><div className="tr-gl-cell"><span className={`trading-amt ${glClass(dailyGL)}`}>{dailyGL >= 0 ? "+" : ""}{fmt(dailyGL)}</span><span className={`tr-badge ${badge(dailyPct)}`}>{dailyPct >= 0 ? "+" : ""}{dailyPct.toFixed(2)}%</span></div></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <th colSpan={5}>Total Open</th>
              <th className="right trading-amt">{fmt(open.reduce((s, t) => s + costOf(t), 0))}</th>
              <th />
              <th className="right trading-amt">{fmt(open.reduce((s, t) => s + t.units * curPrice(t), 0))}</th>
              <th className={`right trading-amt ${glClass(totalUnrealized)}`}>{fmt(totalUnrealized)}</th>
              {(() => { const td = open.reduce((s, t) => s + vsToday(t), 0); return <th className={`right trading-amt ${glClass(td)}`}>{td >= 0 ? "+" : ""}{fmt(td)}</th>; })()}
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* ── Closed Positions ── */}
      {activeTab === "closed" && (
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead><tr>
              {sortTh("Stock", "symbol", closedSort, setClosedSort, "left")}
              {sortTh("Term", "term", closedSort, setClosedSort)}
              {sortTh("Buy Date", "buyDate", closedSort, setClosedSort)}
              {sortTh("Sale Date", "saleDate", closedSort, setClosedSort)}
              {sortTh("Days", "days", closedSort, setClosedSort)}
              {sortTh("Units", "units", closedSort, setClosedSort)}
              {sortTh("Cost/Sh", "costPerSh", closedSort, setClosedSort)}
              {sortTh("Sale/Sh", "salePerSh", closedSort, setClosedSort)}
              {sortTh("Total Cost", "totalCost", closedSort, setClosedSort)}
              {sortTh("Proceeds", "proceeds", closedSort, setClosedSort)}
              {sortTh("G/(L)", "gl", closedSort, setClosedSort)}
            </tr></thead>
            <tbody>
              {sortedClosed.map(({ t, gl, pct, tc, proceeds, days, isLong }) => (
                <tr key={t.id} className={`tr-row-clickable ${gl < 0 ? "tr-row-loss" : "tr-row-gain"}`} onClick={() => openEditTrade(t)}>
                  <td><div className="tr-stock-cell"><span className="tr-symbol">{t.symbol}</span><span className="tr-company-sub">{t.company}</span></div></td>
                  <td className="right"><span className={`tr-term-badge ${isLong ? "tr-term-badge--long" : "tr-term-badge--short"}`}>{isLong ? "Long" : "Short"}</span></td>
                  <td className="right">{fmtDate(t.buyDate)}</td>
                  <td className="right">{fmtDate(t.saleDate!)}</td>
                  <td className="right">{days === 0 ? "Same day" : `${days}d`}</td>
                  <td className="right trading-amt">{t.units % 1 === 0 ? t.units : t.units.toFixed(2)}</td>
                  <td className="right trading-amt">${t.costPerSh.toFixed(2)}</td>
                  <td className="right trading-amt">${t.marketOrSalePrice.toFixed(2)}</td>
                  <td className="right trading-amt">{fmt(tc)}</td>
                  <td className="right trading-amt">{fmt(proceeds)}</td>
                  <td className="right"><div className="tr-gl-cell"><span className={`trading-amt ${glClass(gl)}`}>{fmt(gl)}</span><span className={`tr-badge ${badge(pct)}`}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span></div></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <th colSpan={8}>Total Closed</th>
              <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + costOf(t), 0))}</th>
              <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + t.units * t.marketOrSalePrice, 0))}</th>
              <th className={`right trading-amt ${glClass(totalRealized)}`}>{fmt(totalRealized)}</th>
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* ── Watchlist Tab ── */}
      {activeTab === "watchlist" && (() => {
        const filtered   = watchFilter === "all" ? watchlistItems : watchlistItems.filter(w => w.horizon === watchFilter);
        const activeBuy  = watchlistItems.filter(w => w.horizon === "cyclical" && inBuyWindow(w));
        const activeSell = watchlistItems.filter(w => w.horizon === "cyclical" && inSellWindow(w));
        const horizonLabel: Record<string, string> = { short: "Short-term", long: "Long-term", cyclical: "Cyclical" };
        const horizonClass: Record<string, string> = { short: "wl-card--short", long: "wl-card--long", cyclical: "wl-card--cyclical" };

        return (
          <div className="wl-wrap">
            {/* AI status bar */}
            <div className="wl-ai-bar">
              <div className="wl-ai-status">
                {aiRefreshing ? (
                  <span className="wl-ai-loading">⟳ AI is analysing market data and updating watchlist…</span>
                ) : watchlistMeta.source === "claude-ai" && watchlistMeta.updatedAt ? (
                  <span className="wl-ai-ok">
                    ✦ AI-updated {timeAgo(watchlistMeta.updatedAt)}
                    {watchlistMeta.marketSnapshot && (
                      <em> · SPY ${watchlistMeta.marketSnapshot.spy?.toFixed(0)} · QQQ ${watchlistMeta.marketSnapshot.qqq?.toFixed(0)} · VIX ${watchlistMeta.marketSnapshot.vix?.toFixed(1)}</em>
                    )}
                  </span>
                ) : (
                  <span className="wl-ai-seed">Using default watchlist · AI refresh pending</span>
                )}
                {aiError && <span className="wl-ai-error" title={aiError}>⚠ {aiError.includes("GROQ_API_KEY") ? "Groq API key not configured — run: npx wrangler secret put GROQ_API_KEY --config wrangler.biometric.json" : "AI refresh failed"}</span>}
              </div>
              <button className="wl-ai-btn" onClick={() => { aiTriggeredRef.current = true; triggerAIRefresh(); }} disabled={aiRefreshing}>
                {aiRefreshing ? "Updating…" : "↻ Refresh with AI"}
              </button>
            </div>

            {/* Active window alerts — compact summary */}
            {(activeBuy.length > 0 || activeSell.length > 0) && (
              <div className="wl-alert-summary">
                <div className="wl-alert-summary-line">
                  {activeBuy.length > 0 && <span className="wl-alert-chip wl-alert-chip--buy">▲ Buy: {activeBuy.map(w => w.symbol).join(", ")}</span>}
                  {activeSell.length > 0 && <span className="wl-alert-chip wl-alert-chip--sell">▼ Sell: {activeSell.map(w => w.symbol).join(", ")}</span>}
                  <button className="wl-alert-toggle" onClick={() => setAlertsExpanded(p => !p)}>
                    {alertsExpanded ? "▲ hide" : "▼ details"}
                  </button>
                </div>
                {alertsExpanded && (
                  <div className="wl-alerts">
                    {activeBuy.map(w => (
                      <div key={w.symbol} className="wl-alert wl-alert--buy">
                        <strong>▲ BUY — {w.symbol}</strong>
                        <span>{w.seasonNote} · Entry ≤ ${w.buyBelow?.toLocaleString()}</span>
                      </div>
                    ))}
                    {activeSell.map(w => (
                      <div key={w.symbol} className="wl-alert wl-alert--sell">
                        <strong>▼ SELL — {w.symbol}</strong>
                        <span>{w.seasonNote} · Exit ≥ ${w.sellAbove?.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Filter pills */}
            <div className="wl-filters">
              <span className="wl-filter-label">Show:</span>
              {(["all","short","long","cyclical"] as const).map(f => (
                <button key={f} className={`wl-filter-pill ${watchFilter === f ? "wl-filter-pill--active" : ""}`} onClick={() => setWatchFilter(f)}>
                  {f === "all" ? "All" : f === "short" ? "Short-term" : f === "long" ? "Long-term" : "Cyclical"}
                </button>
              ))}
            </div>

            <p className="wl-source-note">Educational context only — not a trade order. AI uses live price data + Claude to refresh strategy every 6 hours.</p>

            {/* Cards */}
            <div className="wl-grid">
              {filtered.map(w => {
                const lp       = livePrices[w.symbol];
                const pricePct = lp && w.analystTarget ? ((w.analystTarget - lp.price) / lp.price * 100) : null;
                const isBuy    = w.horizon === "cyclical" && inBuyWindow(w);
                const isSell   = w.horizon === "cyclical" && inSellWindow(w);
                const aboveSell = lp && w.sellAbove && lp.price > w.sellAbove;
                const belowBuy  = lp && w.buyBelow  && lp.price < w.buyBelow;
                return (
                  <div key={`${w.symbol}-${w.horizon}`} className={`wl-card ${horizonClass[w.horizon]} ${isBuy ? "wl-card--in-buy" : ""} ${isSell ? "wl-card--in-sell" : ""}`}>
                    <div className="wl-card-header">
                      <div>
                        <span className="wl-symbol">{w.symbol}</span>
                        <span className="wl-company">{w.company}</span>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:"3px"}}>
                        <span className={`wl-horizon-badge wl-horizon-badge--${w.horizon}`}>{horizonLabel[w.horizon]}</span>
                        {aboveSell && <span className="wl-price-flag wl-price-flag--above">Above target</span>}
                        {belowBuy  && <span className="wl-price-flag wl-price-flag--entry">Entry range</span>}
                      </div>
                    </div>

                    <p className="wl-thesis">{w.thesis}</p>

                    <div className="wl-targets">
                      {lp && (
                        <div className="wl-target-row">
                          <span className="wl-target-label">Live</span>
                          <span className="wl-target-val wl-live">${lp.price.toFixed(2)}</span>
                        </div>
                      )}
                      {w.buyBelow && (
                        <div className="wl-target-row">
                          <span className="wl-target-label">Buy below</span>
                          <span className="wl-target-val wl-buy">${w.buyBelow.toLocaleString()}</span>
                        </div>
                      )}
                      {w.sellAbove && (
                        <div className="wl-target-row">
                          <span className="wl-target-label">Sell above</span>
                          <span className="wl-target-val wl-sell">${w.sellAbove.toLocaleString()}</span>
                        </div>
                      )}
                      {w.analystTarget && (
                        <div className="wl-target-row">
                          <span className="wl-target-label">Analyst target</span>
                          <span className="wl-target-val wl-analyst">
                            ${w.analystTarget.toLocaleString()}
                            {pricePct !== null && <em className={pricePct >= 0 ? "wl-upside-pos" : "wl-upside-neg"}> ({pricePct >= 0 ? "+" : ""}{pricePct.toFixed(0)}%)</em>}
                          </span>
                        </div>
                      )}
                    </div>

                    {w.horizon === "cyclical" && w.buyMonths && w.sellMonths && (
                      <div className="wl-season-bar">
                        {MONTHS.map((m, i) => {
                          const mn = i + 1;
                          return (
                            <div key={m} className={["wl-month", w.buyMonths!.includes(mn) ? "wl-month--buy" : "", w.sellMonths!.includes(mn) ? "wl-month--sell" : "", mn === currentMonth ? "wl-month--cur" : ""].join(" ").trim()}>
                              {m}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {w.horizon === "cyclical" && (isBuy || isSell) && (
                      <div className={`wl-window-badge ${isBuy ? "wl-window-badge--buy" : "wl-window-badge--sell"}`}>
                        {isBuy ? "▲ BUY WINDOW ACTIVE" : "▼ SELL WINDOW ACTIVE"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Advisor Insights */}
      <div className="tr-insights">
        <h4 className="tr-insights-heading">Advisor Insights</h4>
        <div className="tr-insights-grid">
          <div className="tr-insight tr-insight--warn">
            <div className="tr-insight-icon">⚠</div>
            <div className="tr-insight-body">
              <strong>All 4 open positions are losing</strong>
              <p>Every open trade is in the red, totaling <span className="tr-gain-neg">{fmt(totalUnrealized)}</span> unrealized loss. MSTR has two open positions bought at $420 and $186 — currently at $100 — suggesting you were averaging down in a declining stock. Consider whether a stop-loss or exit discipline could limit further damage.</p>
            </div>
          </div>
          <div className="tr-insight tr-insight--warn">
            <div className="tr-insight-icon">⚠</div>
            <div className="tr-insight-body">
              <strong>High concentration in MicroStrategy ({mstrConc.toFixed(0)}% of total capital deployed)</strong>
              <p>MSTR appears across all 3 brokers in {mstrTrades.length} trades. While your closed MSTR trades were profitable short swings, the open positions at CST are deep losses. Trading the same volatile stock across multiple accounts amplifies both risk and emotional bias.</p>
            </div>
          </div>
          {longSpeculative.length > 0 && (
            <div className="tr-insight tr-insight--warn">
              <div className="tr-insight-icon">⚠</div>
              <div className="tr-insight-body">
                <strong>Long-term speculative holds destroyed capital</strong>
                <ul className="tr-insight-list">
                  {longSpeculative.map((t, i) => (
                    <li key={i}><strong>{t.symbol}</strong> — held {daysBetween(t.buyDate, t.saleDate!)} days, lost <span className="tr-gain-neg">{fmt(glOf(t))}</span> ({pctOf(t).toFixed(1)}%)</li>
                  ))}
                </ul>
                <p>Speculative small-caps carried without a stop-loss can go to near-zero. A hard rule (exit any position down &gt;25–30%) would have saved most of this capital.</p>
              </div>
            </div>
          )}
          {missedGains.length > 0 && (
            <div className="tr-insight tr-insight--info">
              <div className="tr-insight-icon">ℹ</div>
              <div className="tr-insight-body">
                <strong>Strong exits — but some left significant gains on the table</strong>
                <ul className="tr-insight-list">
                  {missedGains.slice(0, 5).map((t, i) => {
                    const missed = t.units * (t.yesterday - t.marketOrSalePrice);
                    return <li key={i}><strong>{t.symbol}</strong> — sold @ ${t.marketOrSalePrice.toFixed(2)}, now ${t.yesterday.toFixed(2)}, missed extra <span className="tr-gain-pos">{fmt(missed)}</span></li>;
                  })}
                </ul>
                <p>These were good exits — you locked in gains. The "missed" column is hindsight.</p>
              </div>
            </div>
          )}
          <div className="tr-insight tr-insight--pos">
            <div className="tr-insight-icon">✓</div>
            <div className="tr-insight-body">
              <strong>Excellent short-term discipline — keep repeating this</strong>
              <p>OKLO (+64.5% in 23 days), HOOD (+29.3% in 54 days), PLTR (+89.9% in 292 days), UBER (+5.1% in 62 days), SMCI (+15.4% in 56 days). These exits show strong instinct for taking profits. Your CSS broker account runs a disciplined swing-trade style that works.</p>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
