import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { WATCHLIST_DEFAULT } from "@/lib/watchlist-default";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";
const KV_KEY = "watchlist:v1";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=300" };

export async function GET() {
  try {
    const raw = await bindings.VAULT.get(KV_KEY);
    if (raw) return Response.json(JSON.parse(raw), { headers: CACHE_HEADERS });
    // First load — seed KV with defaults
    const seed = { items: WATCHLIST_DEFAULT, updatedAt: null, source: "seed" };
    await bindings.VAULT.put(KV_KEY, JSON.stringify(seed));
    return Response.json(seed, { headers: CACHE_HEADERS });
  } catch {
    return Response.json(
      { items: WATCHLIST_DEFAULT, updatedAt: null, source: "fallback" },
      { headers: CACHE_HEADERS }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    await bindings.VAULT.put(KV_KEY, JSON.stringify(body));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
