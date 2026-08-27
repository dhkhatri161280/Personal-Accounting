import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getValidAccessToken } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

interface SchwabQuoteResult {
  ticker: string;
  price: number;
  previousClose: number | null;
}

// Real-time quote from Schwab, when connected -- falls back to Yahoo (below) if not connected,
// or if Schwab's response doesn't have a usable price for this ticker (e.g. an OTC symbol Schwab
// doesn't cover). Never throws; returns null on any failure so the caller falls back cleanly.
async function fetchSchwabQuote(ticker: string): Promise<SchwabQuoteResult | null> {
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

async function fetchYahooQuote(ticker: string): Promise<SchwabQuoteResult> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`,
    { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> };
  };
  const meta = json?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const previousClose = meta?.chartPreviousClose ?? null;
  if (typeof price !== "number") throw new Error("No price");
  return { ticker, price, previousClose };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NVDA").toUpperCase().replace(/[^A-Z]/g, "");

  const schwab = await fetchSchwabQuote(ticker);
  if (schwab) return Response.json({ ...schwab, source: "schwab" });

  try {
    const yahoo = await fetchYahooQuote(ticker);
    return Response.json({ ...yahoo, source: "yahoo" });
  } catch (e) {
    return Response.json({ ticker, price: null, error: String(e) }, { status: 502 });
  }
}
