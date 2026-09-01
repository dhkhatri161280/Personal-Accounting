import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { plaidBase, plaidCreds, type PlaidClientKey } from "@/lib/plaid-client";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const CONNECTIONS_KEY = "plaid.connections";

export async function POST(request: Request) {
  // Optional item_id -> "update mode": re-authenticates the SAME existing Item (same access
  // token, same transaction history) instead of creating a brand new connection. Required
  // whenever a bank reports ITEM_LOGIN_REQUIRED (credentials/MFA changed) -- just going through
  // the normal "Connect a bank" flow again would add a duplicate connection for that institution,
  // since Plaid has no way to know "fix this one" without being told which access_token to repair.
  // products: only meaningful for a NEW connection (no item_id). Defaults to ["transactions"].
  let itemId: string | undefined;
  let products: string[] | undefined;
  let requestedClient: PlaidClientKey | undefined;
  try {
    const body = (await request.json()) as { item_id?: string; products?: string[]; client?: PlaidClientKey };
    itemId = body.item_id;
    products = body.products;
    requestedClient = body.client;
  } catch {
    // No body / not JSON -- fine, this is the normal new-connection path.
  }

  let accessToken: string | undefined;
  let client: PlaidClientKey | undefined;
  if (itemId) {
    // Update mode fixes an EXISTING item -- it must reuse whichever Plaid project originally
    // created it, not whatever the caller happens to pass, since access_token only works
    // paired with the client_id/secret that issued it.
    let connections: Array<{ access_token: string; item_id: string; client?: PlaidClientKey }> = [];
    try {
      const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
      if (raw) connections = JSON.parse(raw);
    } catch (e: any) {
      return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
    }
    const conn = connections.find((c) => c.item_id === itemId);
    if (!conn) return new Response("Unknown item_id -- it may have been disconnected already", { status: 404 });
    accessToken = conn.access_token;
    client = conn.client;
  } else {
    // New connection: default to the secondary Plaid project once it's configured, so every
    // new bank added from here on consumes ITS free-tier limit, leaving the primary project's
    // (already-maxed-out) existing connections completely untouched. Falls back to primary
    // automatically (via plaidCreds) if the secondary pair isn't set up yet.
    client = requestedClient ?? (bindings.PLAID_CLIENT_ID_2 && bindings.PLAID_SECRET_2 ? "secondary" : "primary");
  }

  const { clientId, secret } = plaidCreds(bindings, client);
  if (!clientId || !secret)
    return new Response("Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET worker secrets", { status: 503 });

  const resp = await fetch(`${plaidBase(bindings)}/link/token/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      client_name: "Personal Ledger",
      user: { client_user_id: "personal-ledger-dk" },
      country_codes: ["US"],
      language: "en",
      // Update mode: pass the existing item's access_token and omit `products` entirely --
      // Plaid infers them from the Item itself and rejects the call if products is included
      // alongside access_token.
      ...(accessToken ? { access_token: accessToken } : { products: products?.length ? products : ["transactions"] }),
    }),
  });

  const data = (await resp.json()) as any;
  if (!resp.ok) {
    console.error("Plaid link-token error:", data?.error_code, data?.error_type);
    return Response.json(data, { status: 400 });
  }
  // Tell the client which project this link session used, so it can tag the resulting
  // connection correctly at exchange time (new connections only -- update mode's client is
  // already fixed by the existing connection record).
  return Response.json({ ...data, client });
}
