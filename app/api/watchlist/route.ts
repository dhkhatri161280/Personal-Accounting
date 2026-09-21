import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { WATCHLIST_DEFAULT } from "@/lib/watchlist-default";
import { withEdgeCache } from "@/lib/edge-cache";
import { requireAccessToken } from "@/lib/api-auth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";
const KV_KEY = "watchlist:v1";

export async function GET(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  return withEdgeCache(request, 300, async () => {
    try {
      const raw = await bindings.VAULT.get(KV_KEY);
      if (raw) return Response.json(JSON.parse(raw));
      // First load — seed KV with defaults
      const seed = { items: WATCHLIST_DEFAULT, updatedAt: null, source: "seed" };
      await bindings.VAULT.put(KV_KEY, JSON.stringify(seed));
      return Response.json(seed);
    } catch {
      return Response.json({ items: WATCHLIST_DEFAULT, updatedAt: null, source: "fallback" });
    }
  });
}

export async function POST(req: Request) {
  const denied = requireAccessToken(req, bindings);
  if (denied) return denied;

  try {
    const body = await req.json();
    await bindings.VAULT.put(KV_KEY, JSON.stringify(body));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
