import type { AppBindings } from "@/lib/cloudflare-env";

// Must exactly match the Callback URL registered on the Schwab Developer Portal app.
export const SCHWAB_REDIRECT_URI = "https://personal-ledger-dk.digneshkhatri.workers.dev/api/schwab/callback";

const TOKEN_ENDPOINT = "https://api.schwabapi.com/v1/oauth/token";
const KV_KEY = "schwab.connection";

// Schwab's own token lifetimes: access tokens last 30 minutes, refresh tokens last 7 days --
// after that the user has to click "Connect Schwab" again and log in fresh. There is no way
// around the 7-day limit; it's enforced by Schwab, not something this app can extend.
const ACCESS_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface SchwabConnection {
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string; // ISO
  refresh_token_expires_at: string; // ISO
  connected_at: string; // ISO
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

export async function saveConnection(bindings: AppBindings, tokens: { access_token: string; refresh_token: string }): Promise<void> {
  const now = Date.now();
  const connection: SchwabConnection = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: new Date(now + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
    refresh_token_expires_at: new Date(now + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    connected_at: new Date().toISOString(),
  };
  await bindings.VAULT.put(KV_KEY, JSON.stringify(connection));
}

export async function getConnection(bindings: AppBindings): Promise<SchwabConnection | null> {
  try {
    const raw = await bindings.VAULT.get(KV_KEY);
    return raw ? (JSON.parse(raw) as SchwabConnection) : null;
  } catch {
    return null;
  }
}

export async function disconnectSchwab(bindings: AppBindings): Promise<void> {
  await bindings.VAULT.delete(KV_KEY);
}

export type ValidAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not_connected" | "refresh_token_expired" | "refresh_failed" };

// Returns a currently-valid access token, transparently refreshing it via the refresh_token if
// the 30-minute access token has expired. If the refresh_token itself is past its 7-day life,
// there's nothing this function can do -- the caller needs to prompt the user to reconnect.
export async function getValidAccessToken(bindings: AppBindings): Promise<ValidAccessTokenResult> {
  const conn = await getConnection(bindings);
  if (!conn) return { ok: false, reason: "not_connected" };

  if (new Date(conn.access_token_expires_at).getTime() > Date.now() + 30_000) {
    return { ok: true, accessToken: conn.access_token };
  }

  if (new Date(conn.refresh_token_expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "refresh_token_expired" };
  }

  const clientId = bindings.SCHWAB_CLIENT_ID, clientSecret = bindings.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, reason: "refresh_failed" };

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
  });
  if (!resp.ok) return { ok: false, reason: "refresh_failed" };

  const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) return { ok: false, reason: "refresh_failed" };

  // Schwab may or may not rotate the refresh_token on refresh -- keep the old one if a new
  // one isn't returned, since the 7-day clock is tied to when it was issued, not this refresh.
  await saveConnection(bindings, { access_token: data.access_token, refresh_token: data.refresh_token ?? conn.refresh_token });
  return { ok: true, accessToken: data.access_token };
}

export async function exchangeCodeForTokens(
  bindings: AppBindings,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clientId = bindings.SCHWAB_CLIENT_ID, clientSecret = bindings.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "Schwab not configured" };

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SCHWAB_REDIRECT_URI }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `Token exchange failed (${resp.status}): ${text.slice(0, 300)}` };
  }
  const data = (await resp.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) return { ok: false, error: "Token response missing access_token/refresh_token" };

  await saveConnection(bindings, { access_token: data.access_token, refresh_token: data.refresh_token });
  return { ok: true };
}
