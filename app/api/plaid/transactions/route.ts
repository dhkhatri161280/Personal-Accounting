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
  } catch (e: any) {
    // A storage read failure must not look like "zero transactions, zero errors" -- that's
    // indistinguishable from a genuinely clean, complete sync of a user with no banks
    // connected, which is the single worst failure mode for a transaction sync endpoint.
    return Response.json(
      { transactions: [], accounts: [], errors: ["Storage unavailable: " + (e?.message || "read failed")] },
      { status: 503 }
    );
  }

  if (connections.length === 0)
    return Response.json({ transactions: [], accounts: [], errors: [] });

  const url = new URL(request.url);
  const endDate = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  // Default: last 90 days
  const startDate =
    url.searchParams.get("start") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const institutionFilter = url.searchParams.get("institution");
  const filterList = institutionFilter ? institutionFilter.split(",").map(decodeURIComponent) : null;
  const activeConnections = filterList
    ? connections.filter((c) => filterList.includes(c.institution_name))
    : connections;

  const allTransactions: unknown[] = [];
  const allAccounts: unknown[] = [];
  const errors: string[] = [];

  await Promise.all(
    activeConnections.map(async (conn) => {
      try {
        // Ask Plaid to go re-pull fresh transactions from the institution right now —
        // without this, transactions/get only returns Plaid's last cached sync, which can
        // lag hours behind what's actually posted at the bank. Best-effort: ignore failures
        // and give Plaid a moment to complete the refresh before reading.
        try {
          await fetch(`${plaidBase(bindings)}/transactions/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: PLAID_CLIENT_ID,
              secret: PLAID_SECRET,
              access_token: conn.access_token,
            }),
          });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch {}

        // Fetch transactions and real-time balances in parallel.
        // transactions/get returns cached balances (can be 1-2 days stale).
        // accounts/balance/get makes a live call to the bank for current balances.
        const [txData, balData] = await Promise.all([
          fetch(`${plaidBase(bindings)}/transactions/get`, {
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
          }).then((r) => r.json() as Promise<{ transactions?: unknown[]; accounts?: unknown[]; error_message?: string; error_code?: string }>),
          fetch(`${plaidBase(bindings)}/accounts/balance/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: PLAID_CLIENT_ID,
              secret: PLAID_SECRET,
              access_token: conn.access_token,
            }),
          })
            .then((r) => (r.ok ? (r.json() as Promise<{ accounts?: unknown[] }>) : null))
            .catch(() => null),
        ]);

        if (txData.error_message || txData.error_code) {
          errors.push(`${conn.institution_name}: ${txData.error_message || txData.error_code}`);
          return;
        }

        (txData.transactions || []).forEach((t: any) =>
          allTransactions.push({ ...t, institution_name: conn.institution_name })
        );

        // Prefer real-time balances; fall back to cached balances from transactions/get
        const accountSource = balData?.accounts ?? txData.accounts ?? [];
        (accountSource as any[]).forEach((a: any) =>
          allAccounts.push({ ...a, institution_name: conn.institution_name })
        );
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
