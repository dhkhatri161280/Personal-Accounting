"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computePaperPositions } from "@/lib/alpaca-paper";

// Real orders submitted by the standalone Alpaca paper-trading bot (a separate Python project --
// see its own README for how it's built). Deliberately a SEPARATE report from TradingReport.tsx,
// never merged into its data: that report's Unrealized/Realized/Net P&L totals are real money
// (Schwab/Robinhood), and paper trading has no business touching those figures while the bot is
// still being iterated on. Every "PAPER" label below is load-bearing, not decoration -- this
// exists specifically so paper and real trading are never visually confusable.
export function PaperTradingReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [showInfo, setShowInfo] = useState(false);
  const trades = useMemo(
    () => [...(data.alpacaPaperTrades ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [data.alpacaPaperTrades]
  );

  const { open, closed } = useMemo(() => computePaperPositions(trades), [trades]);

  // Same live-quote source TradingReport.tsx already uses for the real Trading report -- no new
  // data source needed, it already handles ordinary tickers like ORCL fine.
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; prevClose: number | null }>>({});
  const [priceLoading, setPriceLoading] = useState(true);
  const openTickers = useMemo(() => open.map((p) => p.ticker), [open]);

  const fetchPrices = useCallback(async () => {
    if (openTickers.length === 0) { setPriceLoading(false); return; }
    setPriceLoading(true);
    try {
      const results = await Promise.all(
        openTickers.map((sym) =>
          fetch(`/api/equity-price?ticker=${sym}`)
            .then((r) => r.json())
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
    } finally {
      setPriceLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTickers.join(",")]);

  useEffect(() => { fetchPrices(); }, [fetchPrices]);

  const curPrice = (ticker: string, fallback: number) => livePrices[ticker]?.price ?? fallback;
  const prevClose = (ticker: string, fallback: number) => livePrices[ticker]?.prevClose ?? fallback;

  const openRows = useMemo(
    () =>
      open.map((p) => {
        const price = curPrice(p.ticker, p.avgCost);
        const prevC = prevClose(p.ticker, price);
        const marketValue = p.qty * price;
        const unrealizedGL = marketValue - p.totalCost;
        const unrealizedPct = p.totalCost > 0 ? (unrealizedGL / p.totalCost) * 100 : 0;
        const dayGL = p.qty * (price - prevC);
        const dayPct = prevC > 0 ? ((price - prevC) / prevC) * 100 : 0;
        return { ...p, price, marketValue, unrealizedGL, unrealizedPct, dayGL, dayPct };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, livePrices]
  );

  const totals = useMemo(() => {
    const portfolioValue = openRows.reduce((s, r) => s + r.marketValue, 0);
    const totalUnrealized = openRows.reduce((s, r) => s + r.unrealizedGL, 0);
    const totalRealized = closed.reduce((s, c) => s + c.realizedGL, 0);
    const totalDayGL = openRows.reduce((s, r) => s + r.dayGL, 0);
    return { portfolioValue, totalUnrealized, totalRealized, netPL: totalUnrealized + totalRealized, totalDayGL };
  }, [openRows, closed]);

  const stats = useMemo(() => {
    const tickers = new Set(trades.map((t) => t.ticker));
    return { total: trades.length, tickers: tickers.size };
  }, [trades]);

  const glColor = (v: number) => (v > 0 ? "#16a34a" : v < 0 ? "#dc2626" : undefined);

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Paper Trading (Alpaca)
        <span className="info-icon-wrap" onMouseEnter={() => setShowInfo(true)} onMouseLeave={() => setShowInfo(false)}>
          <button type="button" className="info-icon-btn" aria-label="About this report" onClick={() => setShowInfo((v) => !v)}>
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Every row here is simulated money from a standalone paper-trading bot, imported straight
              from its own trade log -- none of it is real, and none of it is included in any other
              report&apos;s net worth, income, or gain/loss figures in this app. Positions use a running
              average-cost basis (like Robinhood&apos;s own main Positions screen), not FIFO tax lots --
              there&apos;s no tax consequence to simulated money, so lot-level tracking (what the real
              Trading report needs) isn&apos;t meaningful here. Current prices come from the same live-quote
              source as the real Trading report.
            </div>
          )}
        </span>
      </h3>
      <div className="equity-summary-row" style={{ marginBottom: 16 }}>
        <div className="equity-summary-card">
          <span>Status</span>
          <strong style={{ color: "#2563eb" }}>PAPER MONEY</strong>
        </div>
        <div className="equity-summary-card">
          <span>Portfolio Value</span>
          <strong>{priceLoading && openTickers.length > 0 ? "…" : fmt(totals.portfolioValue)}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Unrealized G/L</span>
          <strong style={{ color: glColor(totals.totalUnrealized) }}>{priceLoading && openTickers.length > 0 ? "…" : fmt(totals.totalUnrealized)}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Realized G/L</span>
          <strong style={{ color: glColor(totals.totalRealized) }}>{fmt(totals.totalRealized)}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Net P/L</span>
          <strong style={{ color: glColor(totals.netPL) }}>{priceLoading && openTickers.length > 0 ? "…" : fmt(totals.netPL)}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Today&apos;s Change</span>
          <strong style={{ color: glColor(totals.totalDayGL) }}>{priceLoading && openTickers.length > 0 ? "…" : fmt(totals.totalDayGL)}</strong>
        </div>
      </div>

      {trades.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No paper trades imported yet. Run the sync tool at <code>tools/alpaca-paper-sync/</code>, then
          import the file it produces from Masters → Paper Trading.
        </p>
      ) : (
        <>
          <h4 style={{ margin: "0 0 8px" }}>Positions ({open.length})</h4>
          {open.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 13 }}>No open positions right now.</p>
          ) : (
            <table className="fx-ledger-table" style={{ marginBottom: 20 }}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="right">Qty</th>
                  <th className="right">Avg Cost</th>
                  <th className="right">Current Price</th>
                  <th className="right">Market Value</th>
                  <th className="right">Today&apos;s Change</th>
                  <th className="right">Unrealized G/L</th>
                </tr>
              </thead>
              <tbody>
                {openRows.map((r) => (
                  <tr key={r.ticker}>
                    <td className="fx-narration">{r.ticker}</td>
                    <td className="right">{r.qty}</td>
                    <td className="right">{fmt(r.avgCost)}</td>
                    <td className="right">{fmt(r.price)}</td>
                    <td className="right">{fmt(r.marketValue)}</td>
                    <td className="right" style={{ color: glColor(r.dayGL) }}>
                      {fmt(r.dayGL)} ({r.dayPct >= 0 ? "+" : ""}{r.dayPct.toFixed(2)}%)
                    </td>
                    <td className="right" style={{ color: glColor(r.unrealizedGL), fontWeight: 600 }}>
                      {fmt(r.unrealizedGL)} ({r.unrealizedPct >= 0 ? "+" : ""}{r.unrealizedPct.toFixed(2)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {closed.length > 0 && (
            <>
              <h4 style={{ margin: "0 0 8px" }}>Closed Positions ({closed.length})</h4>
              <table className="fx-ledger-table" style={{ marginBottom: 20 }}>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="right">Qty</th>
                    <th className="right">Buy Avg Cost</th>
                    <th className="right">Sell Price</th>
                    <th>Date</th>
                    <th className="right">Realized G/L</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((c, i) => (
                    <tr key={`${c.ticker}-${c.timestamp}-${i}`}>
                      <td className="fx-narration">{c.ticker}</td>
                      <td className="right">{c.qty}</td>
                      <td className="right">{fmt(c.buyAvgCost)}</td>
                      <td className="right">{fmt(c.sellPrice)}</td>
                      <td>{c.timestamp.slice(0, 10)}</td>
                      <td className="right" style={{ color: glColor(c.realizedGL), fontWeight: 600 }}>
                        {fmt(c.realizedGL)} ({c.realizedPct >= 0 ? "+" : ""}{c.realizedPct.toFixed(2)}%)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h4 style={{ margin: "0 0 8px" }}>Order History ({stats.total} orders, {stats.tickers} ticker{stats.tickers === 1 ? "" : "s"})</h4>
          <table className="fx-ledger-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Ticker</th>
                <th>Action</th>
                <th className="right">Qty</th>
                <th className="right">Price</th>
                <th className="right">Total</th>
                <th>Status</th>
                <th>Order ID</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.orderId}>
                  <td>{t.timestamp.slice(0, 16).replace("T", " ")}</td>
                  <td className="fx-narration">{t.ticker}</td>
                  <td style={{ color: t.action === "BUY" ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{t.action}</td>
                  <td className="right">{t.qty}</td>
                  <td className="right">{fmt(t.price)}</td>
                  <td className="right">{fmt(t.qty * t.price)}</td>
                  <td style={{ fontSize: 11, opacity: 0.75 }}>{t.status.replace("OrderStatus.", "")}</td>
                  <td style={{ fontSize: 10, opacity: 0.5, whiteSpace: "nowrap" }} title={t.orderId}>
                    {t.orderId.slice(0, 8)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
