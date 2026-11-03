"use client";
import { useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";

// Real orders submitted by the standalone Alpaca paper-trading bot (a separate Python project --
// see its own README for how it's built). Deliberately a SEPARATE report from TradingReport.tsx,
// never merged into its data: that report's Unrealized/Realized/Net P&L totals are real money
// (Schwab/Robinhood), and paper trading has no business touching those figures while the bot is
// still being iterated on. Every "PAPER" label below is load-bearing, not decoration -- this
// exists specifically so paper and real trading are never visually confusable.
export function PaperTradingReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const trades = useMemo(
    () => [...(data.alpacaPaperTrades ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [data.alpacaPaperTrades]
  );

  const stats = useMemo(() => {
    const tickers = new Set(trades.map((t) => t.ticker));
    const buys = trades.filter((t) => t.action === "BUY");
    const sells = trades.filter((t) => t.action === "SELL");
    const committed = buys.reduce((s, t) => s + t.qty * t.price, 0) - sells.reduce((s, t) => s + t.qty * t.price, 0);
    return { total: trades.length, buys: buys.length, sells: sells.length, tickers: tickers.size, committed };
  }, [trades]);

  return (
    <div className="data-panel">
      <h3>Paper Trading (Alpaca)</h3>
      <div className="equity-summary-row" style={{ marginBottom: 16 }}>
        <div className="equity-summary-card">
          <span>Status</span>
          <strong style={{ color: "#2563eb" }}>PAPER MONEY</strong>
        </div>
        <div className="equity-summary-card">
          <span>Orders</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Buys / Sells</span>
          <strong>
            {stats.buys} / {stats.sells}
          </strong>
        </div>
        <div className="equity-summary-card">
          <span>Tickers traded</span>
          <strong>{stats.tickers}</strong>
        </div>
        <div className="equity-summary-card">
          <span>Net committed (paper $)</span>
          <strong>{fmt(stats.committed)}</strong>
        </div>
      </div>

      <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 10px" }}>
        Every row here is simulated money from a standalone paper-trading bot, imported straight from
        its own trade log -- none of it is real, and none of it is included in any other report's
        net worth, income, or gain/loss figures in this app. "Net committed" is a rough running total
        (buys minus sells, at submission-time price), not a real cost-basis/P&L calculation.
      </p>

      {trades.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No paper trades imported yet. Run the sync tool at <code>tools/alpaca-paper-sync/</code>, then
          import the file it produces from Masters → Paper Trading.
        </p>
      ) : (
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
      )}
    </div>
  );
}
