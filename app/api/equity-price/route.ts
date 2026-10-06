import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getValidAccessToken } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

interface QuoteResult {
  ticker: string;
  price: number;
  previousClose: number | null;
}

// Real-time quote from Schwab, when connected. Schwab's own `fields=quote` response is the
// REGULAR-SESSION price only -- it has no equivalent of Yahoo's all-sessions fulldayPrice below,
// so this alone goes stale the moment regular hours end (confirmed live: showed $234.23 while
// NVDA was actually trading at $236+ in the post-market/overnight session). Never throws; returns
// null on any failure so the caller falls back cleanly.
async function fetchSchwabQuote(ticker: string): Promise<QuoteResult | null> {
  const token = await getValidAccessToken(bindings);
  if (!token.ok) return null;
  try {
    const res = await fetch(
      `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(ticker)}&fields=quote`,
      { headers: { Authorization: `Bearer ${token.accessToken}` } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { quote?: { lastPrice?: number; mark?: number; closePrice?: number } }>;
    const quote = json[ticker]?.quote;
    const price = quote?.lastPrice ?? quote?.mark;
    if (typeof price !== "number") return null;
    return { ticker, price, previousClose: typeof quote?.closePrice === "number" ? quote.closePrice : null };
  } catch {
    return null;
  }
}

interface YahooQuote {
  regularMarketPrice: number | null;
  // The most current price Yahoo's chart endpoint actually has. Originally this used meta's own
  // `fulldayPrice` field, on the assumption it was Yahoo's all-sessions price -- confirmed WRONG
  // live (2026-10): fulldayPrice sat frozen at the regular-session close (238.90) while the
  // response's own 1-minute intraday series kept printing real post-market ticks past it (last
  // bar 240.20), and meta's own fulldayChange (+6.26 on a 233.95 previous close = ~240.21)
  // independently confirmed 240-ish was the real number -- fulldayPrice itself just isn't
  // reliably kept current. The intraday series' own last non-null close is a direct observation,
  // not a derived summary field, so it's preferred; fulldayPrice is only a fallback for when the
  // series is empty. Note neither source ever reflects the newer separate "Overnight" (8pm-4am
  // ET) session Yahoo's own UI now shows -- this chart endpoint has no feed for that at all, so
  // the freshest price achievable here is "through the end of the post-market session."
  latestPrice: number | null;
  previousClose: number | null;
}

async function fetchYahooQuote(ticker: string): Promise<YahooQuote> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m&includePrePost=true`,
    { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: { regularMarketPrice?: number; fulldayPrice?: number; chartPreviousClose?: number };
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
    };
  };
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  const regularMarketPrice = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
  const fulldayPrice = typeof meta?.fulldayPrice === "number" ? meta.fulldayPrice : null;
  const previousClose = meta?.chartPreviousClose ?? null;

  // The latest minute bar can end in a trailing null if it hasn't fully printed yet -- scan
  // backward from the end for the last real tick instead of just reading the final array slot.
  const closes = result?.indicators?.quote?.[0]?.close;
  let lastIntradayClose: number | null = null;
  if (closes) {
    for (let i = closes.length - 1; i >= 0; i--) {
      if (typeof closes[i] === "number") {
        lastIntradayClose = closes[i] as number;
        break;
      }
    }
  }
  const latestPrice = lastIntradayClose ?? fulldayPrice;

  if (regularMarketPrice == null && latestPrice == null) throw new Error("No price");
  return { regularMarketPrice, latestPrice, previousClose };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NVDA").toUpperCase().replace(/[^A-Z]/g, "");

  // Always fetch Yahoo (not only as a Schwab-down fallback) -- it's the only source here that
  // ever has a more-current-than-regular-hours price at all. Priority: Yahoo's latestPrice
  // (freshest -- captures post-market movement Schwab's plain quote never does) > Schwab's
  // real-time regular-session quote (when connected, and Yahoo had nothing extra to offer) >
  // Yahoo's regularMarketPrice (last resort, e.g. Schwab not connected and no extended-hours
  // activity yet).
  const yahoo = await fetchYahooQuote(ticker).catch(() => null);
  if (yahoo?.latestPrice != null) {
    return Response.json({ ticker, price: yahoo.latestPrice, previousClose: yahoo.previousClose, source: "yahoo-intraday" });
  }

  const schwab = await fetchSchwabQuote(ticker);
  if (schwab) return Response.json({ ...schwab, source: "schwab" });

  if (yahoo?.regularMarketPrice != null) {
    return Response.json({ ticker, price: yahoo.regularMarketPrice, previousClose: yahoo.previousClose, source: "yahoo" });
  }

  return Response.json({ ticker, price: null, error: "No price available from Schwab or Yahoo" }, { status: 502 });
}
