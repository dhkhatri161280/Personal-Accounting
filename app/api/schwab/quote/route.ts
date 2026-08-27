import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getValidAccessToken } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Thin pass-through to Schwab's real-time quote endpoint. Returns Schwab's response shape
// as-is (not yet normalized to this app's own price format) -- this route exists first so we
// can inspect a REAL response before deciding how to map it into the UI, rather than guessing
// field names ahead of time.
export async function GET(request: Request) {
  const symbols = new URL(request.url).searchParams.get("symbols");
  if (!symbols) return Response.json({ error: "Missing ?symbols=A,B,C" }, { status: 400 });

  const token = await getValidAccessToken(bindings);
  if (!token.ok) return Response.json({ error: `Schwab not usable: ${token.reason}` }, { status: 401 });

  const resp = await fetch(
    `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(symbols)}&fields=quote`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } }
  );
  const text = await resp.text();
  if (!resp.ok) return Response.json({ error: `Schwab quote API error (${resp.status})`, raw: text.slice(0, 1000) }, { status: 502 });

  try {
    return Response.json(JSON.parse(text));
  } catch {
    return Response.json({ error: "Non-JSON response from Schwab", raw: text.slice(0, 1000) }, { status: 502 });
  }
}
