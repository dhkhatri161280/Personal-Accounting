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
    return new Response("Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET worker secrets", { status: 503 });

  // Optional item_id -> "update mode": re-authenticates the SAME existing Item (same access
  // token, same transaction history) instead of creating a brand new connection. Required
  // whenever a bank reports ITEM_LOGIN_REQUIRED (credentials/MFA changed) -- just going through
  // the normal "Connect a bank" flow again would add a duplicate connection for that institution,
  // since Plaid has no way to know "fix this one" without being told which access_token to repair.
  let itemId: string | undefined;
  try {
    const body = (await request.json()) as { item_id?: string };
    itemId = body.item_id;
  } catch {
    // No body / not JSON -- fine, this is the normal new-connection path.
  }

  let accessToken: string | undefined;
  if (itemId) {
    let connections: Array<{ access_token: string; item_id: string }> = [];
    try {
      const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
      if (raw) connections = JSON.parse(raw);
    } catch (e: any) {
      return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
    }
    accessToken = connections.find((c) => c.item_id === itemId)?.access_token;
    if (!accessToken) return new Response("Unknown item_id -- it may have been disconnected already", { status: 404 });
  }

  const resp = await fetch(`${plaidBase(bindings)}/link/token/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      client_name: "Personal Ledger",
      user: { client_user_id: "personal-ledger-dk" },
      country_codes: ["US"],
      language: "en",
      // Update mode: pass the existing item's access_token and omit `products` entirely --
      // Plaid infers them from the Item itself and rejects the call if products is included
      // alongside access_token.
      ...(accessToken ? { access_token: accessToken } : { products: ["transactions"] }),
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Plaid link-token error:", (data as any)?.error_code, (data as any)?.error_type);
    return Response.json(data, { status: 400 });
  }
  return Response.json(data);
}
