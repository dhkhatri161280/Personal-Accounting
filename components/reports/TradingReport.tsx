"use client";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { WATCHLIST_DEFAULT } from "@/lib/watchlist-default";
import type { WatchlistEntry } from "@/lib/watchlist-default";
import type { Trade } from "@/lib/vault-types";
import { fmtDate } from "@/lib/format-date";
import { StatIcon } from "@/components/Icon";

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
  const [closedSort, setClosedSort]   = useState<"date" | "gl" | "pct">("date");
  const [watchFilter, setWatchFilter] = useState<"all" | "short" | "long" | "cyclical">("all");

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

  const sortedClosed = [...closed].sort((a, b) => {
    if (closedSort === "gl")  return glOf(b) - glOf(a);
    if (closedSort === "pct") return pctOf(b) - pctOf(a);
    return new Date(b.buyDate).getTime() - new Date(a.buyDate).getTime();
  });

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
        <button className="tr-refresh-btn" onClick={() => fetchPrices(false)} disabled={priceLoading || pricesRefreshing}>
          ↻ Refresh prices
        </button>
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
        {activeTab !== "watchlist" && !showTradeForm && (
          <button onClick={openAddTrade}>+ Add Trade</button>
        )}
      </div>

      {showTradeForm && (
        <div className="equity-form">
          <h5>{editTradeId ? "Edit Trade" : "New Trade"}</h5>
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
          </div>
        </div>
      )}

      {/* ── Open Positions ── */}
      {activeTab === "open" && (
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead><tr>
              <th>Stock</th><th className="right">Buy Date</th><th className="right">Units</th>
              <th className="right">Cost/Sh</th><th className="right">Total Cost</th>
              <th className="right">Current Price</th><th className="right">Market Value</th>
              <th className="right">G/(L)</th><th className="right">Daily G/(L)</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {open.map((t) => {
                const gl = glOf(t), pct = pctOf(t), mv = t.units * curPrice(t), tc = costOf(t);
                const dailyGL = t.units * (curPrice(t) - prevClose(t));
                const dailyPct = ((curPrice(t) - prevClose(t)) / prevClose(t)) * 100;
                return (
                  <tr key={t.id} className={gl < 0 ? "tr-row-loss" : "tr-row-gain"}>
                    <td><div className="tr-stock-cell"><span className="tr-symbol">{t.symbol}</span><span className="tr-company-sub">{t.company}</span></div></td>
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
                    <td className="right">
                      <button onClick={() => openEditTrade(t)} title="Edit or close this trade">✎</button>{" "}
                      <button onClick={() => deleteTrade(t.id)} title="Delete this trade">🗑</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr>
              <th colSpan={4}>Total Open</th>
              <th className="right trading-amt">{fmt(open.reduce((s, t) => s + costOf(t), 0))}</th>
              <th />
              <th className="right trading-amt">{fmt(open.reduce((s, t) => s + t.units * curPrice(t), 0))}</th>
              <th className={`right trading-amt ${glClass(totalUnrealized)}`}>{fmt(totalUnrealized)}</th>
              {(() => { const td = open.reduce((s, t) => s + vsToday(t), 0); return <th className={`right trading-amt ${glClass(td)}`}>{td >= 0 ? "+" : ""}{fmt(td)}</th>; })()}
              <th />
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* ── Closed Positions ── */}
      {activeTab === "closed" && (
        <div className="tr-table-wrap">
          <div className="tr-sort-row">
            <span>Sort by:</span>
            <button className={closedSort === "date" ? "selected" : ""} onClick={() => setClosedSort("date")}>Buy Date</button>
            <button className={closedSort === "gl"   ? "selected" : ""} onClick={() => setClosedSort("gl")}>G/(L) $</button>
            <button className={closedSort === "pct"  ? "selected" : ""} onClick={() => setClosedSort("pct")}>G/(L) %</button>
          </div>
          <table className="tr-table">
            <thead><tr>
              <th>Stock</th><th className="right">Buy Date</th><th className="right">Sale Date</th>
              <th className="right">Days</th><th className="right">Units</th>
              <th className="right">Cost/Sh</th><th className="right">Sale/Sh</th>
              <th className="right">Total Cost</th><th className="right">Proceeds</th><th className="right">G/(L)</th><th className="right">Actions</th>
            </tr></thead>
            <tbody>
              {sortedClosed.map((t) => {
                const gl = glOf(t), pct = pctOf(t), tc = costOf(t);
                const proceeds = t.units * t.marketOrSalePrice;
                const days = daysBetween(t.buyDate, t.saleDate!);
                return (
                  <tr key={t.id} className={gl < 0 ? "tr-row-loss" : "tr-row-gain"}>
                    <td><div className="tr-stock-cell"><span className="tr-symbol">{t.symbol}</span><span className="tr-company-sub">{t.company}</span></div></td>
                    <td className="right">{fmtDate(t.buyDate)}</td>
                    <td className="right">{fmtDate(t.saleDate!)}</td>
                    <td className="right">{days === 0 ? "Same day" : `${days}d`}</td>
                    <td className="right trading-amt">{t.units % 1 === 0 ? t.units : t.units.toFixed(2)}</td>
                    <td className="right trading-amt">${t.costPerSh.toFixed(2)}</td>
                    <td className="right trading-amt">${t.marketOrSalePrice.toFixed(2)}</td>
                    <td className="right trading-amt">{fmt(tc)}</td>
                    <td className="right trading-amt">{fmt(proceeds)}</td>
                    <td className="right"><div className="tr-gl-cell"><span className={`trading-amt ${glClass(gl)}`}>{fmt(gl)}</span><span className={`tr-badge ${badge(pct)}`}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span></div></td>
                    <td className="right">
                      <button onClick={() => openEditTrade(t)} title="Edit, or clear the sale date to reopen">✎</button>{" "}
                      <button onClick={() => deleteTrade(t.id)} title="Delete this trade">🗑</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr>
              <th colSpan={7}>Total Closed</th>
              <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + costOf(t), 0))}</th>
              <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + t.units * t.marketOrSalePrice, 0))}</th>
              <th className={`right trading-amt ${glClass(totalRealized)}`}>{fmt(totalRealized)}</th>
              <th />
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
