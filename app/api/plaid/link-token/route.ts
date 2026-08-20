import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

function plaidBase(b: AppBindings) {
  return (b.PLAID_ENV || "sandbox") === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";
}

export async function POST() {
  const { PLAID_CLIENT_ID, PLAID_SECRET } = bindings;
  if (!PLAID_CLIENT_ID || !PLAID_SECRET)
    return new Response("Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET worker secrets", { status: 503 });

  const resp = await fetch(`${plaidBase(bindings)}/link/token/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      client_name: "Personal Ledger",
      user: { client_user_id: "personal-ledger-dk" },
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("Plaid link-token error:", (data as any)?.error_code, (data as any)?.error_type);
    return Response.json(data, { status: 400 });
  }
  return Response.json(data);
}
