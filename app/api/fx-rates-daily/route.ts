import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { withEdgeCache } from "@/lib/edge-cache";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Sibling to /api/fx-rates, but keyed by exact calendar date ("YYYY-MM-DD") instead of month --
// for translating an individual transaction at the real rate on its own posting date, rather than
// a monthly average. Separate KV key/cache so the existing monthly-average consumers (GR
// Consolidated) are untouched.
const FX_DAILY_KEY = "fintech-by-dk.fx-rates.usd-inr-daily";

export async function GET(request: Request) {
  return withEdgeCache(request, 3600, async () => {
    let raw: string | null = null;
    try {
      raw = await bindings.VAULT.get(FX_DAILY_KEY);
    } catch {}
    const rates = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return Response.json({ rates });
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { dates?: string[] };
  const dates = Array.isArray(body.dates) ? body.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];

  let stored: Record<string, number> = {};
  try {
    const raw = await bindings.VAULT.get(FX_DAILY_KEY);
    if (raw) stored = JSON.parse(raw) as Record<string, number>;
  } catch {}

  const missing = dates.filter((d) => stored[d] == null).sort();
  const errors: string[] = [];

  // frankfurter.app has no rate for weekends/holidays, so an exact-date miss can be a real gap OR
  // just a non-business day -- fetch the whole min..max span of missing dates in ONE range query
  // (same approach /api/fx-rates uses for months) rather than one request per date, and store
  // every business day the range actually returns, not just the ones originally requested -- that
  // way a later nearest-earlier-date fallback lookup has more real data to fall back on too.
  if (missing.length > 0) {
    const startDate = missing[0];
    const endDate = missing[missing.length - 1];
    try {
      const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=INR`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.ok) {
        const data = (await resp.json()) as { rates?: Record<string, { INR?: number }> };
        if (data.rates) {
          for (const [dateStr, rateObj] of Object.entries(data.rates)) {
            if (typeof rateObj.INR === "number") {
              stored[dateStr] = Math.round(rateObj.INR * 10000) / 10000;
            }
          }
        }
      } else {
        errors.push(`FX rate fetch failed: HTTP ${resp.status}`);
      }
    } catch (e: any) {
      errors.push("FX rate fetch failed: " + (e?.message || "network error"));
    }
  }

  if (missing.length) {
    try {
      await bindings.VAULT.put(FX_DAILY_KEY, JSON.stringify(stored));
    } catch (e: any) {
      errors.push("Failed to save fetched rates: " + (e?.message || "write failed"));
    }
  }

  return Response.json({ rates: stored, errors });
}
