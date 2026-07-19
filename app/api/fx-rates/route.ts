import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const FX_KEY = "fintech-by-dk.fx-rates.usd-inr";

export async function GET() {
  let raw: string | null = null;
  try {
    raw = await bindings.VAULT.get(FX_KEY);
  } catch {}
  const rates = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  return Response.json({ rates });
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

  const missing = months.filter((m) => stored[m] == null);
  for (const month of missing) {
    try {
      const [year, mon] = month.split("-");
      const start = `${year}-${mon}-01`;
      const nextMonthDate = new Date(Number(year), Number(mon), 1);
      const end = new Date(nextMonthDate.getTime() - 86400000).toISOString().slice(0, 10);
      const url = `https://api.frankfurter.app/${start}..${end}?from=USD&to=INR`;
      const resp = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!resp.ok) continue;
      const data = (await resp.json()) as { rates?: Record<string, { INR?: number }> };
      if (!data.rates) continue;
      const daily = Object.values(data.rates)
        .map((r) => r.INR)
        .filter((v): v is number => typeof v === "number");
      if (daily.length) {
        stored[month] = Math.round((daily.reduce((s, v) => s + v, 0) / daily.length) * 10000) / 10000;
      }
    } catch {}
  }

  // Merge any custom rate overrides provided by the caller
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
