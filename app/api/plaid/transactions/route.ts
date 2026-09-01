import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { plaidBase, plaidCreds, type PlaidClientKey } from "@/lib/plaid-client";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const CONNECTIONS_KEY = "plaid.connections";

export async function GET(request: Request) {
  if (!bindings.PLAID_CLIENT_ID || !bindings.PLAID_SECRET)
    return new Response("Plaid not configured", { status: 503 });

  type Conn = {
    access_token: string;
    institution_name: string;
    item_id: string;
    client?: PlaidClientKey;
    hasInvestmentAccount?: boolean;
  };
  let connections: Conn[] = [];
  try {
    const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
    if (raw) connections = JSON.parse(raw);
  } catch (e: any) {
    // A storage read failure must not look like "zero transactions, zero errors" -- that's
    // indistinguishable from a genuinely clean, complete sync of a user with no banks
    // connected, which is the single worst failure mode for a transaction sync endpoint.
    return Response.json(
      { transactions: [], accounts: [], errors: ["Storage unavailable: " + (e?.message || "read failed")], itemErrors: [] },
      { status: 503 }
    );
  }

  if (connections.length === 0)
    return Response.json({ transactions: [], accounts: [], errors: [], itemErrors: [] });

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
  // Structured alongside `errors` (kept as plain strings for the status banner) so the client
  // can offer a "Reconnect" button for the specific broken item_id, instead of just displaying
  // text -- see app/api/plaid/link-token/route.ts's update-mode support.
  const itemErrors: { item_id: string; institution_name: string; error_code?: string; error_message?: string }[] = [];
  const debug = url.searchParams.get("debug") === "1";
  const debugRefresh: unknown[] = [];

  // Whether a connection has an investment-type account almost never changes once known --
  // determine it ONCE per connection and cache on the stored record, instead of an extra
  // /accounts/balance/get round-trip on every single Fetch (that extra call was adding real
  // latency to every fetch, confirmed directly by the user noticing fetches got slower after
  // this check was introduced).
  const unknownFlagConns = activeConnections.filter((c) => c.hasInvestmentAccount === undefined);
  if (unknownFlagConns.length > 0) {
    const results = await Promise.all(
      unknownFlagConns.map(async (conn) => {
        const { clientId, secret } = plaidCreds(bindings, conn.client);
        const has = await fetch(`${plaidBase(bindings)}/accounts/balance/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId, secret, access_token: conn.access_token }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: any) => (d?.accounts || []).some((a: any) => a.type === "investment"))
          .catch(() => false);
        return { item_id: conn.item_id, has };
      })
    );
    const byId = new Map(results.map((r) => [r.item_id, r.has]));
    connections = connections.map((c) => (byId.has(c.item_id) ? { ...c, hasInvestmentAccount: byId.get(c.item_id) } : c));
    activeConnections.forEach((c) => {
      if (byId.has(c.item_id)) c.hasInvestmentAccount = byId.get(c.item_id);
    });
    try {
      await bindings.VAULT.put(CONNECTIONS_KEY, JSON.stringify(connections));
    } catch {
      // Best-effort cache write -- a failure here just means next fetch re-checks these same
      // connections, not a correctness problem.
    }
  }

  await Promise.all(
    activeConnections.map(async (conn) => {
      // Each connection remembers which Plaid project (client_id/secret) created it -- see
      // app/api/plaid/link-token/route.ts. Using the wrong pair for an access_token fails
      // outright, so this must be resolved per-connection, not globally.
      const { clientId: PLAID_CLIENT_ID, secret: PLAID_SECRET } = plaidCreds(bindings, conn.client);
      try {
        // Ask Plaid to go re-pull fresh data from the institution right now -- without this,
        // Plaid only returns its last routine sync, which for investment-type accounts
        // (401k, HSA, IRA) can be a full day or more stale (confirmed directly: Fidelity's own
        // app showed a 401k balance that only matched Plaid's cached figure once you subtracted
        // that day's market move). /transactions/refresh only applies to depository/credit
        // items -- Plaid treats "Investments" as a separate product with its own refresh call.
        // investments/refresh shares a tight rate-limit quota per item across the WHOLE app
        // (confirmed directly: INVESTMENTS_REFRESH_LIMIT), so it's only fired for connections
        // that actually have an investment-type account -- otherwise every plain bank/card
        // connection burns quota that the accounts which actually need it could have used.
        // Best-effort: ignore failures and give Plaid a moment to complete before reading.
        try {
          const hasInvestmentAccount = conn.hasInvestmentAccount === true;

          await Promise.all([
            fetch(`${plaidBase(bindings)}/transactions/refresh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                access_token: conn.access_token,
              }),
            }).catch(() => {}),
            hasInvestmentAccount
              ? fetch(`${plaidBase(bindings)}/investments/refresh`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    client_id: PLAID_CLIENT_ID,
                    secret: PLAID_SECRET,
                    access_token: conn.access_token,
                  }),
                })
                  .then(async (r) => {
                    if (debug) debugRefresh.push({ institution: conn.institution_name, item_id: conn.item_id, status: r.status, body: await r.text() });
                  })
                  .catch((e) => {
                    if (debug) debugRefresh.push({ institution: conn.institution_name, item_id: conn.item_id, error: String(e) });
                  })
              : Promise.resolve(),
          ]);
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
          itemErrors.push({
            item_id: conn.item_id,
            institution_name: conn.institution_name,
            error_code: txData.error_code,
            error_message: txData.error_message,
          });
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

  return Response.json({
    transactions: allTransactions,
    accounts: allAccounts,
    errors,
    itemErrors,
    ...(debug ? { debugRefresh } : {}),
  });
}
