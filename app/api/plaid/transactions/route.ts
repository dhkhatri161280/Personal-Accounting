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

export async function GET(request: Request) {
  const { PLAID_CLIENT_ID, PLAID_SECRET } = bindings;
  if (!PLAID_CLIENT_ID || !PLAID_SECRET)
    return new Response("Plaid not configured", { status: 503 });

  let connections: Array<{ access_token: string; institution_name: string; item_id: string }> = [];
  try {
    const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
    if (raw) connections = JSON.parse(raw);
  } catch {}

  if (connections.length === 0)
    return Response.json({ transactions: [], accounts: [], errors: [] });

  const url = new URL(request.url);
  const endDate = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  // Default: last 90 days
  const startDate =
    url.searchParams.get("start") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const allTransactions: unknown[] = [];
  const allAccounts: unknown[] = [];
  const errors: string[] = [];

  await Promise.all(
    connections.map(async (conn) => {
      try {
        const resp = await fetch(`${plaidBase(bindings)}/transactions/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: PLAID_CLIENT_ID,
            secret: PLAID_SECRET,
            access_token: conn.access_token,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, include_personal_finance_category: true },
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { transactions?: unknown[]; accounts?: unknown[] };
          (data.transactions || []).forEach((t: any) =>
            allTransactions.push({ ...t, institution_name: conn.institution_name })
          );
          (data.accounts || []).forEach((a: any) =>
            allAccounts.push({ ...a, institution_name: conn.institution_name })
          );
        } else {
          const err = (await resp.json()) as { error_message?: string };
          errors.push(`${conn.institution_name}: ${err.error_message || "fetch failed"}`);
        }
      } catch (e: any) {
        errors.push(`${conn.institution_name}: ${e.message}`);
      }
    })
  );

  // Sort newest first
  (allTransactions as any[]).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return Response.json({ transactions: allTransactions, accounts: allAccounts, errors });
}
