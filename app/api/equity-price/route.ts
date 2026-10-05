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
  // Yahoo's own all-sessions price (pre + regular + post/overnight combined) -- confirmed live
  // against a real quote (2026-10) to be the same number Yahoo's own UI prominently shows as
  // "Overnight: $X" outside regular hours, distinct from and more current than
  // regularMarketPrice once the regular session has closed. Absent (or equal to
  // regularMarketPrice) during/before regular hours, when there's nothing "extra" to reflect yet.
  fulldayPrice: number | null;
  previousClose: number | null;
}

async function fetchYahooQuote(ticker: string): Promise<YahooQuote> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`,
    { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; fulldayPrice?: number; chartPreviousClose?: number } }> };
  };
  const meta = json?.chart?.result?.[0]?.meta;
  const regularMarketPrice = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
  const fulldayPrice = typeof meta?.fulldayPrice === "number" ? meta.fulldayPrice : null;
  const previousClose = meta?.chartPreviousClose ?? null;
  if (regularMarketPrice == null && fulldayPrice == null) throw new Error("No price");
  return { regularMarketPrice, fulldayPrice, previousClose };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NVDA").toUpperCase().replace(/[^A-Z]/g, "");

  // Always fetch Yahoo (not only as a Schwab-down fallback) -- it's the only source here that
  // ever has a more-current-than-regular-hours price at all. Priority: Yahoo's fulldayPrice
  // (freshest -- captures post-market/overnight movement Schwab's plain quote never does) >
  // Schwab's real-time regular-session quote (when connected, and Yahoo had nothing extra to
  // offer) > Yahoo's regularMarketPrice (last resort, e.g. Schwab not connected and no
  // extended-hours activity yet).
  const yahoo = await fetchYahooQuote(ticker).catch(() => null);
  if (yahoo?.fulldayPrice != null) {
    return Response.json({ ticker, price: yahoo.fulldayPrice, previousClose: yahoo.previousClose, source: "yahoo-fullday" });
  }

  const schwab = await fetchSchwabQuote(ticker);
  if (schwab) return Response.json({ ...schwab, source: "schwab" });

  if (yahoo?.regularMarketPrice != null) {
    return Response.json({ ticker, price: yahoo.regularMarketPrice, previousClose: yahoo.previousClose, source: "yahoo" });
  }

  return Response.json({ ticker, price: null, error: "No price available from Schwab or Yahoo" }, { status: 502 });
}
