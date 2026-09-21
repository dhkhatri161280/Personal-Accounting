import type { AppBindings } from "@/lib/cloudflare-env";

export const ACCESS_TOKEN_HEADER = "x-dk-access-token";

// Every route that returns or mutates real personal/financial data (Plaid/Teller/Schwab,
// attachments, vault PUT, watchlist, categorize) calls this first. Fails CLOSED when the secret
// isn't configured -- a forgotten `wrangler secret put API_ACCESS_TOKEN` should mean "nobody can
// call this route" (loud, obvious to the owner testing their own app), not "anyone can" (silent,
// only discoverable by an attacker). Timing-safe comparison isn't used here -- a 32+ byte random
// token makes a timing-based guess-and-check attack impractically slow regardless, and Workers'
// request overhead dwarfs any string-compare timing signal anyway.
export function requireAccessToken(request: Request, bindings: AppBindings): Response | null {
  const expected = bindings.API_ACCESS_TOKEN;
  if (!expected) {
    return Response.json({ error: "Server not configured for API access" }, { status: 503 });
  }
  // A plain browser navigation (e.g. an attachment's <a href target="_blank"> download link)
  // can't attach a custom header, so this also accepts the token as a `?token=` query param --
  // only for routes that specifically opt into that (see requireAccessTokenFromHeaderOrQuery
  // below). Everything else uses the header-only check.
  const provided = request.headers.get(ACCESS_TOKEN_HEADER);
  if (!provided || provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// Same check, but also accepts the token via `?token=` -- for the handful of routes reached by a
// plain browser navigation/link rather than a fetch() call this app's own JS controls (custom
// headers aren't possible there). Query-param tokens are more exposed (browser history, referrer,
// server logs) than a header, so this is opt-in per route, not the default.
export function requireAccessTokenFromHeaderOrQuery(request: Request, bindings: AppBindings): Response | null {
  const expected = bindings.API_ACCESS_TOKEN;
  if (!expected) {
    return Response.json({ error: "Server not configured for API access" }, { status: 503 });
  }
  const provided = request.headers.get(ACCESS_TOKEN_HEADER) || new URL(request.url).searchParams.get("token");
  if (!provided || provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
