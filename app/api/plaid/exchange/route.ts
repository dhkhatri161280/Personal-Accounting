import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

function plaidBase(b: AppBindings) {
  return (b.PLAID_ENV || "sandbox") === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";
}

const CONNECTIONS_KEY = "plaid.connections";

export async function POST(request: Request) {
  const { PLAID_CLIENT_ID, PLAID_SECRET } = bindings;
  if (!PLAID_CLIENT_ID || !PLAID_SECRET)
    return new Response("Plaid not configured", { status: 503 });

  let body: { public_token?: string; institution_name?: string; institution_id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { public_token, institution_name, institution_id } = body;
  if (!public_token) return new Response("Missing public_token", { status: 400 });

  const resp = await fetch(`${plaidBase(bindings)}/item/public_token/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, public_token }),
  });
  const data = (await resp.json()) as { access_token?: string; item_id?: string; error_message?: string };
  if (!resp.ok || !data.access_token)
    return Response.json({ error: data.error_message || "Exchange failed" }, { status: 400 });

  // Load existing connections
  let connections: Array<{
    access_token: string;
    item_id: string;
    institution_name: string;
    institution_id: string;
    connected_at: string;
  }> = [];
  try {
    const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
    if (raw) connections = JSON.parse(raw);
  } catch {}

  // Replace if same institution already connected
  connections = connections.filter((c) => c.item_id !== data.item_id);
  connections.push({
    access_token: data.access_token,
    item_id: data.item_id!,
    institution_name: institution_name || "Bank",
    institution_id: institution_id || "",
    connected_at: new Date().toISOString(),
  });

  await bindings.VAULT.put(CONNECTIONS_KEY, JSON.stringify(connections));
  return Response.json({ ok: true, institution_name: institution_name || "Bank" });
}
