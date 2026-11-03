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
