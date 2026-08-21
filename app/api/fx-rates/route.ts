import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { withEdgeCache } from "@/lib/edge-cache";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const FX_KEY = "fintech-by-dk.fx-rates.usd-inr";

export async function GET(request: Request) {
  return withEdgeCache(request, 3600, async () => {
    let raw: string | null = null;
    try {
      raw = await bindings.VAULT.get(FX_KEY);
    } catch {}
    const rates = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return Response.json({ rates });
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    months?: string[];
    customRates?: Record<string, number>;
  };
  const months: string[] = Array.isArray(body.months) ? body.months : [];

  let stored: Record<string, number> = {};
  try {
    const raw = await bindings.VAULT.get(FX_KEY);
    if (raw) stored = JSON.parse(raw) as Record<string, number>;
  } catch {}

  // Determine which months we need to fetch
  const missing = months.filter((m) => stored[m] == null).sort();

  // Fetch ALL missing months in a SINGLE range query to frankfurter.app
  if (missing.length > 0) {
    const firstMonth = missing[0];
    const lastMonth = missing[missing.length - 1];
    const startDate = `${firstMonth}-01`;
    const [ly, lm] = lastMonth.split("-").map(Number);
    const endDate = `${lastMonth}-${String(new Date(ly, lm, 0).getDate()).padStart(2, "0")}`;
    try {
      const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=INR`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.ok) {
        const data = (await resp.json()) as { rates?: Record<string, { INR?: number }> };
        if (data.rates) {
          const buckets = new Map<string, number[]>();
          for (const [dateStr, rateObj] of Object.entries(data.rates)) {
            const mk = dateStr.slice(0, 7);
            if (typeof rateObj.INR === "number") {
              if (!buckets.has(mk)) buckets.set(mk, []);
              buckets.get(mk)!.push(rateObj.INR);
            }
          }
          for (const [mk, vals] of buckets) {
            stored[mk] =
              Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10000) / 10000;
          }
        }
      }
    } catch {}
  }

  // Apply any custom rate overrides
  if (body.customRates && typeof body.customRates === "object") {
    for (const [k, v] of Object.entries(body.customRates)) {
      if (/^\d{4}-\d{2}$/.test(k) && typeof v === "number" && v > 0) {
        stored[k] = Math.round(v * 10000) / 10000;
      }
    }
  }

  if (missing.length || body.customRates) {
    try {
      await bindings.VAULT.put(FX_KEY, JSON.stringify(stored));
    } catch {}
  }

  return Response.json({ rates: stored });
}
