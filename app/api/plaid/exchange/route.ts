import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { plaidBase, plaidCreds, type PlaidClientKey } from "@/lib/plaid-client";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const CONNECTIONS_KEY = "plaid.connections";

export async function POST(request: Request) {
  let body: { public_token?: string; institution_name?: string; institution_id?: string; client?: PlaidClientKey };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { public_token, institution_name, institution_id, client } = body;
  if (!public_token) return new Response("Missing public_token", { status: 400 });

  // Must match whichever project's client_id/secret actually created the public_token's
  // link_token (link-token/route.ts) -- Plaid rejects an exchange from a mismatched pair.
  const { clientId, secret } = plaidCreds(bindings, client);
  if (!clientId || !secret) return new Response("Plaid not configured", { status: 503 });

  const resp = await fetch(`${plaidBase(bindings)}/item/public_token/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, public_token }),
  });
  const data = (await resp.json()) as { access_token?: string; item_id?: string; error_message?: string };
  if (!resp.ok || !data.access_token)
    return Response.json({ error: data.error_message || "Exchange failed" }, { status: 400 });

  // Load existing connections. A failed read must NOT silently fall through to an empty list --
  // the write below replaces the whole key, so treating a storage hiccup as "no connections yet"
  // would wipe out every other already-connected bank.
  let connections: Array<{
    access_token: string;
    item_id: string;
    institution_name: string;
    institution_id: string;
    connected_at: string;
    client?: PlaidClientKey;
  }> = [];
  try {
    const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
    if (raw) connections = JSON.parse(raw);
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }

  // Replace if same institution already connected
  connections = connections.filter((c) => c.item_id !== data.item_id);
  connections.push({
    access_token: data.access_token,
    item_id: data.item_id!,
    institution_name: institution_name || "Bank",
    institution_id: institution_id || "",
    connected_at: new Date().toISOString(),
    client,
  });

  try {
    await bindings.VAULT.put(CONNECTIONS_KEY, JSON.stringify(connections));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true, institution_name: institution_name || "Bank" });
}
