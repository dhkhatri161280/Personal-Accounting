import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { WATCHLIST_DEFAULT, type WatchlistEntry } from "@/lib/watchlist-default";
import { requireAccessToken } from "@/lib/api-auth";

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

// Real technical reference levels for a picked ticker's buy/sell band -- replaces the earlier
// flat live-price +/-8% (which was pure cosmetic math: since buyBelow/sellAbove were DERIVED
// from live itself, live sat in the middle of the band by construction, every single cycle, for
// every ticker regardless of its actual trend or volatility -- a $3 stock and a $525 stock got
// literally the same percentage width, and "Buy below" could essentially never trigger without
// an 8%+ single-day move; confirmed live via the Oct 2026 Watchlist: every one of 18 names had
// live sitting squarely between its band, which read as fake, not as an actual signal). The
// 50-day moving average (a standard trend-following support reference) and the 52-week high (a
// standard resistance/profit-take reference) are both real history for the specific stock, and
// -- unlike the old band -- CAN already be triggered relative to today's live price (e.g. a stock
// trading below its own 50-day average is a real "already in the dip zone" signal, not
// algebraically impossible the way it was before).
async function fetchPriceLevels(symbol: string) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=3mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; chartPreviousClose?: number; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
    // Need a reasonable sample before trusting a "50-day" average as meaningful (e.g. a stock
    // that IPO'd recently won't have 3 months of history yet) -- falls back to the 52-week low
    // as the buy reference in that case instead of a thin/misleading average.
    const last50 = closes.slice(-50);
    const fiftyDayMA = last50.length >= 20 ? last50.reduce((s, c) => s + c, 0) / last50.length : null;
    return {
      symbol,
      price: meta?.regularMarketPrice ?? null,
      prevClose: meta?.chartPreviousClose ?? null,
      fiftyTwoWeekHigh: typeof meta?.fiftyTwoWeekHigh === "number" ? meta.fiftyTwoWeekHigh : null,
      fiftyTwoWeekLow: typeof meta?.fiftyTwoWeekLow === "number" ? meta.fiftyTwoWeekLow : null,
      fiftyDayMA,
    };
  } catch {
    return { symbol, price: null, prevClose: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, fiftyDayMA: null };
  }
}

// Only the fields the AI actually has a basis to know: which tickers are in the news and why.
// Price levels are NOT requested from the AI -- see the live-price pass below for why.
type AiPick = { symbol: string; company: string; horizon: WatchlistEntry["horizon"]; thesis: string; buyMonths?: number[]; sellMonths?: number[]; seasonNote?: string };

function isValidPick(e: unknown): e is AiPick {
  if (!e || typeof e !== "object") return false;
  const w = e as Record<string, unknown>;
  if (typeof w.symbol !== "string" || !w.symbol.trim()) return false;
  if (typeof w.company !== "string" || !w.company.trim()) return false;
  if (w.horizon !== "short" && w.horizon !== "long" && w.horizon !== "cyclical") return false;
  if (typeof w.thesis !== "string" || !w.thesis.trim()) return false;
  if (w.horizon === "cyclical" && (!Array.isArray(w.buyMonths) || !Array.isArray(w.sellMonths))) return false;
  return true;
}

export async function POST(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

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

Do NOT include any price levels, price targets, or dollar figures -- you don't have live market data, so any price you wrote would likely be stale or wrong. Prices are looked up separately, from a live feed, after you pick the tickers.

Return ONLY a JSON array of exactly 18 objects, each with these fields:
{ "symbol": "TICKER", "company": "Full Company Name", "horizon": "short" | "long" | "cyclical", "thesis": "1-2 sentences with a specific, current reason", "buyMonths": [numbers] (cyclical only), "sellMonths": [numbers] (cyclical only), "seasonNote": "short phrase" (cyclical only) }

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

  // 4. Parse + validate the AI's proposed tickers (symbol/company/horizon/thesis only -- no
  // price data, see the prompt above for why). A malformed or too-short response leaves the
  // existing watchlist untouched rather than overwriting it with something broken.
  let picks: AiPick[];
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");

    const seen = new Set<string>();
    const valid: AiPick[] = [];
    for (const raw of parsed) {
      if (!isValidPick(raw)) continue;
      const symbol = raw.symbol.toUpperCase().trim();
      if (symbol === "NVDA" || seen.has(symbol)) continue;
      seen.add(symbol);
      valid.push({ ...raw, symbol });
      if (valid.length >= MAX_ITEMS) break;
    }

    if (valid.length < MIN_ITEMS) {
      throw new Error(`Only ${valid.length} valid entries after filtering (need at least ${MIN_ITEMS})`);
    }
    picks = valid;
  } catch (e) {
    return Response.json({ error: `Parse error: ${String(e)}`, raw: rawText.slice(0, 500) }, { status: 502 });
  }

  // 5. Look up REAL technical levels for the AI's chosen tickers (52-week high/low, 50-day
  // moving average) and derive buy/sell bands from those -- real per-stock history, not another
  // AI guess and not the old flat live +/-8% (see fetchPriceLevels above for why that read as
  // fake). No analystTarget: this app has no reliable source for actual Wall Street consensus
  // figures, and showing a fabricated one next to a real live price is exactly the kind of
  // mismatch that made the AI-invented price levels look broken (e.g. "Live $480" next to
  // "Target $140").
  const pickLevels = await Promise.all(picks.map((p) => fetchPriceLevels(p.symbol)));
  const pickLevelMap = Object.fromEntries(pickLevels.map((p) => [p.symbol, p]));
  const updatedItems: WatchlistEntry[] = picks.map((p) => {
    const lvl = pickLevelMap[p.symbol];
    const entry: WatchlistEntry = { symbol: p.symbol, company: p.company, horizon: p.horizon, thesis: p.thesis };
    if (p.horizon === "cyclical") {
      entry.buyMonths = p.buyMonths;
      entry.sellMonths = p.sellMonths;
      entry.seasonNote = p.seasonNote;
    }
    const live = lvl?.price ?? null;
    // The UI's "Entry range" badge (TradingReport.tsx) fires whenever live < buyBelow -- a
    // contract the old flat live x0.92 band always satisfied by construction. The 50-day MA can
    // legitimately sit ABOVE live for a stock currently trading below its own average, which
    // would fire that badge on roughly half the list immediately on every refresh, not only once
    // price genuinely dropped into range -- confirmed live: exactly this on the actual watchlist.
    // Only use the MA when it's a real target BELOW today's price; otherwise fall back to the
    // 52-week low, which (being the trailing year's minimum, today included) can never exceed
    // live, so it always keeps the "buyBelow <= live" contract the UI depends on. The 52-week
    // high needs no equivalent guard the other way -- as the trailing year's maximum it can never
    // sit below live either, so sellAbove >= live always holds already.
    const buyBelow = lvl?.fiftyDayMA != null && live != null && lvl.fiftyDayMA < live ? lvl.fiftyDayMA : (lvl?.fiftyTwoWeekLow ?? null);
    const sellAbove = lvl?.fiftyTwoWeekHigh ?? null;
    // Sanity guard, not expected in practice: the 52-week high is the max of a full year's
    // closes including the last 50 days, so it should essentially always sit at or above their
    // average -- but never show an inverted or degenerate band if the data ever disagrees.
    if (buyBelow != null && sellAbove != null && buyBelow > 0 && buyBelow < sellAbove) {
      entry.buyBelow = Math.round(buyBelow * 100) / 100;
      entry.sellAbove = Math.round(sellAbove * 100) / 100;
    }
    return entry;
  });

  // 6. Save to KV
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
