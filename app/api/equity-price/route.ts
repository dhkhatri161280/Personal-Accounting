export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "NVDA").toUpperCase().replace(/[^A-Z]/g, "");
  try {
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
    return Response.json({ ticker, price, previousClose });
  } catch (e) {
    return Response.json({ ticker, price: null, error: String(e) }, { status: 502 });
  }
}
