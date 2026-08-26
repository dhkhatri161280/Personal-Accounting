export const dynamic = "force-dynamic";

// Daily closing prices for a ticker's full trading history -- used to value vested RSU/ESPP
// holdings as of a *past* date (e.g. a prior fiscal year-end for Net Worth), rather than
// applying today's price to every historical period.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NVDA").toUpperCase().replace(/[^A-Z]/g, "");
  try {
    // range=max silently coarsens to ~monthly bars for a ticker with decades of history --
    // explicit period1/period2 with interval=1d returns true daily closes for the full history.
    const period2 = Math.floor(Date.now() / 1000);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=0&period2=${period2}&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const points: { date: string; close: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (typeof close !== "number") continue;
      points.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close });
    }
    return Response.json({ ticker, points });
  } catch (e) {
    return Response.json({ ticker, points: [], error: String(e) }, { status: 502 });
  }
}
