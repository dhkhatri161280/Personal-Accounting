import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { WATCHLIST_DEFAULT, type WatchlistEntry } from "@/lib/watchlist-default";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";
const KV_KEY = "watchlist:v1";
const MIN_ITEMS = 10;
const MAX_ITEMS = 24;

async function fetchPrice5d(symbol: string) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    const json = await res.json() as {
      chart?: { result?: Array<{
        meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
      }> };
    };
    const meta = json?.chart?.result?.[0]?.meta;
    return { symbol, price: meta?.regularMarketPrice ?? null, prevClose: meta?.chartPreviousClose ?? null };
  } catch {
    return { symbol, price: null, prevClose: null };
  }
}

function change5d(price: number | null, prevClose: number | null) {
  return price !== null && prevClose !== null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;
}

function isValidEntry(e: unknown): e is WatchlistEntry {
  if (!e || typeof e !== "object") return false;
  const w = e as Record<string, unknown>;
  if (typeof w.symbol !== "string" || !w.symbol.trim()) return false;
  if (typeof w.company !== "string" || !w.company.trim()) return false;
  if (w.horizon !== "short" && w.horizon !== "long" && w.horizon !== "cyclical") return false;
  if (typeof w.thesis !== "string" || !w.thesis.trim()) return false;
  if (w.horizon === "cyclical" && (!Array.isArray(w.buyMonths) || !Array.isArray(w.sellMonths))) return false;
  return true;
}

export async function POST() {
  const apiKey = bindings.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GROQ_API_KEY not configured. Run: npx wrangler secret put GROQ_API_KEY --config wrangler.biometric.json" }, { status: 503 });
  }

  // 1. Load current watchlist from KV (fall back to defaults) -- kept only as the
  // returned-unchanged fallback if the AI response is unusable, not as a fixed ticker set.
  let currentItems: WatchlistEntry[] = WATCHLIST_DEFAULT;
  try {
    const raw = await bindings.VAULT.get(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.items?.length > 0) currentItems = parsed.items;
    }
  } catch { /* use defaults */ }

  // 2. Market-wide context only (index levels) -- the AI picks its own tickers below, so there's
  // no fixed symbol list to pre-fetch prices for.
  const marketSymbols = ["SPY", "QQQ", "^VIX"];
  const marketPrices  = await Promise.all(marketSymbols.map(fetchPrice5d));
  const marketCtx = marketPrices
    .map((p) => `${p.symbol.replace("^", "")}: $${p.price?.toFixed(2) ?? "N/A"} (5d: ${change5d(p.price, p.prevClose)?.toFixed(1) ?? "N/A"}%)`)
    .join(" | ");

  const today        = new Date().toISOString().slice(0, 10);
  const currentMonth = new Date().getMonth() + 1;
  const currentSymbols = currentItems.map((w) => w.symbol).join(", ");

  const prompt = `You are a US equity strategist building an actively-managed watchlist from scratch each cycle -- not just updating commentary on a fixed list.

TODAY: ${today} (month ${currentMonth})
MARKET: ${marketCtx}
YESTERDAY'S WATCHLIST (for context only, not a requirement to keep any of these): ${currentSymbols}

TASK: Scan for what's actually moving markets right now -- recent earnings surprises, major company news, sector momentum, macro events (Fed policy, rates, geopolitics) -- and propose a fresh watchlist of exactly 18 US-listed stocks worth actively watching this cycle. Drop names whose catalyst has played out; keep or add names with a live, current reason to watch them. It is fine and expected for this list to differ from yesterday's.

Mix: 6-8 short-term momentum names, 5-7 long-term structural holds, 3-5 cyclical/seasonal plays whose buy/sell window is relevant to month ${currentMonth} specifically.

Rules:
- NEVER include NVDA.
- No duplicate symbols.
- Every thesis must reference a SPECIFIC, real, current reason (an actual earnings result, a named product/deal, a macro event) -- not generic filler like "strong fundamentals."
- For horizon "cyclical" entries only, include buyMonths and sellMonths (arrays of month numbers 1-12) and a short seasonNote.

Return ONLY a JSON array of exactly 18 objects, each with these fields:
{ "symbol": "TICKER", "company": "Full Company Name", "horizon": "short" | "long" | "cyclical", "thesis": "1-2 sentences with a specific, current reason", "analystTarget": number, "buyBelow": number, "sellAbove": number, "buyMonths": [numbers] (cyclical only), "sellMonths": [numbers] (cyclical only), "seasonNote": "short phrase" (cyclical only) }

No markdown. No explanation. Just the JSON array.`;

  // 3. Call Groq API (OpenAI-compatible)
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 6144,
      messages: [
        { role: "system", content: "You are a US equity strategist. Return only valid JSON arrays, no markdown, no explanation." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return Response.json({ error: `Groq API error: ${err}` }, { status: 502 });
  }

  const groqJson = await groqRes.json() as { choices?: Array<{ message?: { content?: string } }> };
  const rawText  = groqJson?.choices?.[0]?.message?.content ?? "";

  // 4. Parse + validate the AI's proposed watchlist. A malformed or too-short response leaves
  // the existing watchlist untouched rather than overwriting it with something broken.
  let updatedItems: WatchlistEntry[];
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");

    const seen = new Set<string>();
    const valid: WatchlistEntry[] = [];
    for (const raw of parsed) {
      if (!isValidEntry(raw)) continue;
      const symbol = raw.symbol.toUpperCase().trim();
      if (symbol === "NVDA" || seen.has(symbol)) continue;
      seen.add(symbol);
      valid.push({ ...raw, symbol });
      if (valid.length >= MAX_ITEMS) break;
    }

    if (valid.length < MIN_ITEMS) {
      throw new Error(`Only ${valid.length} valid entries after filtering (need at least ${MIN_ITEMS})`);
    }
    updatedItems = valid;
  } catch (e) {
    return Response.json({ error: `Parse error: ${String(e)}`, raw: rawText.slice(0, 500) }, { status: 502 });
  }

  // 5. Save to KV
  const result = {
    items: updatedItems,
    updatedAt: new Date().toISOString(),
    source: "claude-ai",
    marketSnapshot: {
      spy: marketPrices.find((p) => p.symbol === "SPY")?.price ?? undefined,
      qqq: marketPrices.find((p) => p.symbol === "QQQ")?.price ?? undefined,
      vix: marketPrices.find((p) => p.symbol === "^VIX")?.price ?? undefined,
    },
  };
  try {
    await bindings.VAULT.put(KV_KEY, JSON.stringify(result));
  } catch (e: any) {
    return Response.json({ error: "Watchlist storage unavailable: " + (e?.message || "write failed") }, { status: 503 });
  }

  return Response.json(result);
}
