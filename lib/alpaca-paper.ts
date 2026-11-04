import type { AlpacaPaperTrade } from "./vault-types.ts";

// Real orders from the standalone Alpaca paper-trading bot -- see AlpacaPaperTrade's own comment
// in vault-types.ts for why this is deliberately separate from the real Schwab/Robinhood `trades`
// data TradingReport.tsx tracks.

// Merges a freshly-imported batch, deduped by orderId -- Alpaca's own order id is the one truly
// stable identifier here (unlike, say, timestamp+ticker, which a same-second double-fill could
// collide on). The incoming (presumably newer) one wins on a collision, since the bot's own
// trades.csv is append-only and a re-import should always reflect its latest status for an order
// (e.g. ACCEPTED -> FILLED).
export function mergeAlpacaPaperTrades(existing: AlpacaPaperTrade[], incoming: AlpacaPaperTrade[]): AlpacaPaperTrade[] {
  const byId = new Map(existing.map((t) => [t.orderId, t]));
  for (const t of incoming) byId.set(t.orderId, t);
  return [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

// One ticker's current simulated holding, average-cost basis -- not FIFO lots. Average cost (not
// lot-by-lot) is deliberate: this is what Robinhood/most retail apps' own main Positions screen
// shows, and FIFO-lot tax treatment (which the REAL Trading report needs -- see classifyTradingSales
// in lib/tax-classify.ts) is meaningless for simulated money with no tax consequences.
export type PaperPosition = {
  ticker: string;
  qty: number;
  avgCost: number;
  totalCost: number;
};

// One SELL order's realized result -- the qty sold, valued against whatever average cost basis
// was running at that exact moment (so two sells of the same ticker on different days can realize
// different $/share gains even at the same sell price, same as a real brokerage would compute it).
export type ClosedPaperTrade = {
  ticker: string;
  qty: number;
  buyAvgCost: number;
  sellPrice: number;
  timestamp: string;
  realizedGL: number;
  realizedPct: number;
};

// Alpaca order statuses that mean the order never actually executed -- a CANCELED/REJECTED/EXPIRED
// order still gets logged (trade_log.py logs whatever submit_market_order returned, see
// telegram_bot.py's own comment on that), but including it here would fabricate a position or
// realized gain for a trade that never actually happened. Still shown in the raw order history,
// just excluded from the position/P&L math below.
const NON_EXECUTED = /cancel|reject|expir/i;

// Turns the bot's flat, chronological list of fills into open positions + realized sells, using a
// running average-cost basis per ticker. Trades must be processed OLDEST FIRST regardless of the
// order they're passed in (the vault/report convention sorts newest-first for display).
export function computePaperPositions(trades: AlpacaPaperTrade[]): { open: PaperPosition[]; closed: ClosedPaperTrade[] } {
  const chronological = trades
    .filter((t) => !NON_EXECUTED.test(t.status))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const state = new Map<string, { qty: number; avgCost: number }>();
  const closed: ClosedPaperTrade[] = [];

  for (const t of chronological) {
    const cur = state.get(t.ticker) ?? { qty: 0, avgCost: 0 };
    if (t.action === "BUY") {
      const newQty = cur.qty + t.qty;
      const newAvgCost = newQty > 0 ? (cur.qty * cur.avgCost + t.qty * t.price) / newQty : 0;
      state.set(t.ticker, { qty: newQty, avgCost: newAvgCost });
    } else {
      // Capped at what's actually held -- a SELL this log never saw a matching BUY for (e.g. an
      // order placed before the sync tool existed) can't be priced against a real cost basis, so
      // the un-matchable portion is silently excluded rather than fabricating a loss/gain from $0.
      const sellQty = Math.min(t.qty, cur.qty);
      if (sellQty > 0) {
        const realizedGL = sellQty * (t.price - cur.avgCost);
        const realizedPct = cur.avgCost > 0 ? ((t.price - cur.avgCost) / cur.avgCost) * 100 : 0;
        closed.push({ ticker: t.ticker, qty: sellQty, buyAvgCost: cur.avgCost, sellPrice: t.price, timestamp: t.timestamp, realizedGL, realizedPct });
      }
      const remainingQty = cur.qty - sellQty;
      state.set(t.ticker, { qty: remainingQty, avgCost: remainingQty > 0 ? cur.avgCost : 0 });
    }
  }

  const open: PaperPosition[] = [];
  for (const [ticker, s] of state) {
    if (s.qty > 1e-9) open.push({ ticker, qty: s.qty, avgCost: s.avgCost, totalCost: s.qty * s.avgCost });
  }
  return {
    open: open.sort((a, b) => a.ticker.localeCompare(b.ticker)),
    closed: closed.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
  };
}

// Parses/validates an uploaded trades.csv-derived JSON -- permissive about extra fields, strict
// about the handful actually used, same convention as parseAmexBenefitsUpload.
export function parseAlpacaPaperTradesUpload(raw: unknown): AlpacaPaperTrade[] {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of paper trades.");
  return raw.map((t, i) => {
    if (typeof t !== "object" || t === null) throw new Error(`Trade ${i}: not an object.`);
    const o = t as Record<string, unknown>;
    if (typeof o.orderId !== "string" || !o.orderId) throw new Error(`Trade ${i}: missing "orderId".`);
    if (typeof o.ticker !== "string" || !o.ticker) throw new Error(`Trade ${i} (${o.orderId}): missing "ticker".`);
    const action = o.action === "SELL" ? "SELL" : "BUY";
    return {
      timestamp: typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString(),
      ticker: o.ticker,
      action,
      qty: typeof o.qty === "number" ? o.qty : 0,
      price: typeof o.price === "number" ? o.price : 0,
      orderId: o.orderId,
      status: typeof o.status === "string" ? o.status : "",
    };
  });
}
