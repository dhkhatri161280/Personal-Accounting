import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { WATCHLIST_DEFAULT } from "@/lib/watchlist-default";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";
const KV_KEY = "watchlist:v1";

async function fetchPrice5d(symbol: string) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    const json = await res.json() as {
      chart?: { result?: Array<{
        meta?: { regularMarketPrice?: number; chartPreviousClose?: number; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number };
        indicators?: { quote?: Array<{ close?: number[] }> };
      }> };
    };
    const meta   = json?.chart?.result?.[0]?.meta;
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((c): c is number => typeof c === "number") ?? [];
    const price  = meta?.regularMarketPrice ?? null;
    const first  = closes[0] ?? null;
    return {
      symbol,
      price,
      prevClose:  meta?.chartPreviousClose ?? null,
      change5d:   price !== null && first !== null ? ((price - first) / first * 100) : null,
      high52w:    meta?.fiftyTwoWeekHigh ?? null,
      low52w:     meta?.fiftyTwoWeekLow  ?? null,
    };
  } catch {
    return { symbol, price: null, prevClose: null, change5d: null, high52w: null, low52w: null };
  }
}

export async function POST() {
  const apiKey = bindings.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GROQ_API_KEY not configured. Run: npx wrangler secret put GROQ_API_KEY --config wrangler.biometric.json" }, { status: 503 });
  }

  // 1. Load current watchlist from KV (fall back to defaults)
  let currentItems = WATCHLIST_DEFAULT;
  try {
    const raw = await bindings.VAULT.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.items?.length > 0) currentItems = parsed.items;
    }
  } catch { /* use defaults */ }

  // 2. Fetch 5-day price data for all symbols + market indices
  const symbols       = [...new Set(currentItems.map(w => w.symbol))];
  const marketSymbols = ["SPY", "QQQ", "^VIX"];
  const priceResults  = await Promise.all([...symbols, ...marketSymbols].map(fetchPrice5d));
  const priceMap      = Object.fromEntries(priceResults.map(p => [p.symbol, p]));

  // 3. Build prompt context
  const today         = new Date().toISOString().slice(0, 10);
  const currentMonth  = new Date().getMonth() + 1;

  const marketCtx = marketSymbols
    .map(s => { const p = priceMap[s]; return `${s.replace("^", "")}: $${p.price?.toFixed(2) ?? "N/A"} (5d: ${p.change5d?.toFixed(1) ?? "N/A"}%)`; })
    .join(" | ");

  const stockCtx = currentItems.map(w => {
    const p = priceMap[w.symbol];
    return `${w.symbol} (${w.company}, ${w.horizon}) — Live=$${p.price?.toFixed(2) ?? "N/A"} 5d=${p.change5d?.toFixed(1) ?? "N/A"}% 52wH=$${p.high52w?.toFixed(0) ?? "N/A"} 52wL=$${p.low52w?.toFixed(0) ?? "N/A"}`;
  }).join("\n");

  const prompt = `You are a US equity strategist providing short thesis updates. Today is ${today} (month ${currentMonth}).

MARKET: ${marketCtx}

STOCKS (symbol, horizon, live price, 5-day change, 52-week range):
${stockCtx}

TASK: For each stock above, write a 1-2 sentence thesis that reflects TODAY's price action and market context.
- Reference the actual live price and 5d movement in your thesis
- NEVER include NVDA
- For stocks down >8% in 5d: note if it is a buying dip or a broken thesis
- For stocks up >8% in 5d: note the momentum and whether to hold or trim

Return ONLY a JSON array of exactly ${currentItems.length} objects. Each object must have exactly two fields:
{ "symbol": "TICKER", "thesis": "1-2 sentence thesis here" }

No other fields. No markdown. No explanation. Just the JSON array.`;

  // 4. Call Groq API (OpenAI-compatible)
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 4096,
      messages: [
        { role: "system", content: "You are a US equity strategist. Return only valid JSON arrays, no markdown, no explanation." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return Response.json({ error: `Groq API error: ${err}` }, { status: 502 });
  }

  const groqJson = await groqRes.json() as { choices?: Array<{ message?: { content?: string } }> };
  const rawText  = groqJson?.choices?.[0]?.message?.content ?? "";

  // 5. Parse thesis updates and merge into existing items (all numeric fields preserved)
  let updatedItems: typeof WATCHLIST_DEFAULT;
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    const aiUpdates = JSON.parse(match[0]) as Array<{ symbol: string; thesis: string }>;
    if (!Array.isArray(aiUpdates) || aiUpdates.length === 0) throw new Error("Empty or invalid array");
    const thesisMap: Record<string, string> = {};
    for (const u of aiUpdates) if (u.symbol && u.thesis) thesisMap[u.symbol] = u.thesis;
    // Merge: numeric fields always come from WATCHLIST_DEFAULT (source of truth),
    // thesis comes from AI if available, otherwise keep existing thesis from currentItems
    const currentThesisMap: Record<string, string> = Object.fromEntries(currentItems.map(w => [w.symbol, w.thesis]));
    updatedItems = WATCHLIST_DEFAULT.map(def => ({
      ...def,
      thesis: thesisMap[def.symbol] ?? currentThesisMap[def.symbol] ?? def.thesis,
    }));
  } catch (e) {
    return Response.json({ error: `Parse error: ${String(e)}`, raw: rawText.slice(0, 500) }, { status: 502 });
  }

  // 6. Save to KV
  const result = {
    items: updatedItems,
    updatedAt: new Date().toISOString(),
    source: "claude-ai",
    marketSnapshot: {
      spy: priceMap["SPY"]?.price,
      qqq: priceMap["QQQ"]?.price,
      vix: priceMap["^VIX"]?.price,
    },
  };
  await bindings.VAULT.put(KV_KEY, JSON.stringify(result));

  return Response.json(result);
}
