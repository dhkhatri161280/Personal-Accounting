import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { plaidBase, plaidCreds, type PlaidClientKey } from "@/lib/plaid-client";
import { requireAccessToken } from "@/lib/api-auth";
import { mapWithConcurrency } from "@/lib/concurrency";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

// Cap on connections syncing in parallel -- each connection can itself fire several concurrent
// fetches to Plaid, and running every connection fully in parallel was enough simultaneous
// in-flight requests to trip Cloudflare Workers' own concurrent-subrequest ceiling, which force-
// cancels the OLDEST still-open response to avoid deadlock (confirmed live via `wrangler tail`,
// fired twice on a real 5-connection sync). Combined with always consuming every fetch's response
// body below (the other real trigger for that same warning), this keeps peak in-flight requests
// well under the ceiling regardless of how many banks get connected later.
const CONNECTION_SYNC_CONCURRENCY = 2;
// Every Plaid call below goes through fetchWithTimeout with this bound -- previously no
// individual fetch had a timeout of its own, so one slow/hanging institution rode along until
// the whole route's own execution limit kicked in, and while stuck open it also counted against
// the concurrent-subrequest ceiling above, making it more likely to trigger the deadlock guard
// that cancels OTHER, healthy connections' requests too.
const PLAID_FETCH_TIMEOUT_MS = 10_000;

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const CONNECTIONS_KEY = "plaid.connections";

// GR Book (fintech-by-dk-generic) is a separate Cloudflare Worker deployment with no Plaid/KV
// bindings of its own -- it reads this US-book worker's live 401(k)/IRA balance via a direct
// cross-origin GET from the browser (see components/GrApp.tsx). This route otherwise has no auth
// of its own (relies on the worker's own obscurity/domain, same as every other Plaid route in
// this app), so scoping the CORS allowance to that one specific known origin rather than "*"
// keeps this from being readable by an arbitrary third-party site.
const CORS_HEADERS = { "Access-Control-Allow-Origin": "https://fintech-by-dk-generic.digneshkhatri.workers.dev" };

export async function GET(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  if (!bindings.PLAID_CLIENT_ID || !bindings.PLAID_SECRET)
    return new Response("Plaid not configured", { status: 503, headers: CORS_HEADERS });

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
      { status: 503, headers: CORS_HEADERS }
    );
  }

  if (connections.length === 0)
    return Response.json({ transactions: [], accounts: [], errors: [], itemErrors: [] }, { headers: CORS_HEADERS });

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
  const allInvestmentTransactions: unknown[] = [];
  const errors: string[] = [];
  // Structured alongside `errors` (kept as plain strings for the status banner) so the client
  // can offer a "Reconnect" button for the specific broken item_id, instead of just displaying
  // text -- see app/api/plaid/link-token/route.ts's update-mode support.
  const itemErrors: { item_id: string; institution_name: string; error_code?: string; error_message?: string }[] = [];
  const debug = url.searchParams.get("debug") === "1";
  const debugRefresh: unknown[] = [];
  const debugHoldings: unknown[] = [];

  // Whether a connection has an investment-type account almost never changes once known --
  // determine it ONCE per connection and cache on the stored record, instead of an extra
  // /accounts/balance/get round-trip on every single Fetch (that extra call was adding real
  // latency to every fetch, confirmed directly by the user noticing fetches got slower after
  // this check was introduced).
  const unknownFlagConns = activeConnections.filter((c) => c.hasInvestmentAccount === undefined);
  if (unknownFlagConns.length > 0) {
    const results = await mapWithConcurrency(unknownFlagConns, CONNECTION_SYNC_CONCURRENCY, async (conn) => {
      const { clientId, secret } = plaidCreds(bindings, conn.client);
      const has = await fetchWithTimeout(`${plaidBase(bindings)}/accounts/balance/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, secret, access_token: conn.access_token }),
      }, PLAID_FETCH_TIMEOUT_MS)
        // Always consume the body -- Plaid's own fetch response, read or not, is exactly the
        // kind of "in-flight, unread" request Cloudflare's deadlock guard force-cancels once
        // too many pile up (see CONNECTION_SYNC_CONCURRENCY comment above).
        .then(async (r) => {
          if (!r.ok) { await r.text().catch(() => {}); return null; }
          return r.json();
        })
        .then((d: any) => (d?.accounts || []).some((a: any) => a.type === "investment"))
        .catch(() => false);
      return { item_id: conn.item_id, has };
    });
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

  await mapWithConcurrency(activeConnections, CONNECTION_SYNC_CONCURRENCY, async (conn) => {
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
            // .then(r => r.text()) always drains the body -- previously this only had a .catch,
            // so a *successful* refresh left its response body completely unread, which is
            // exactly the "fetch() several times without reading the bodies" condition
            // Cloudflare's deadlock guard force-cancels the oldest of once too many pile up.
            fetchWithTimeout(`${plaidBase(bindings)}/transactions/refresh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                access_token: conn.access_token,
              }),
            }, PLAID_FETCH_TIMEOUT_MS).then((r) => r.text()).catch(() => {}),
            hasInvestmentAccount
              ? fetchWithTimeout(`${plaidBase(bindings)}/investments/refresh`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    client_id: PLAID_CLIENT_ID,
                    secret: PLAID_SECRET,
                    access_token: conn.access_token,
                  }),
                }, PLAID_FETCH_TIMEOUT_MS)
                  // The body must be read unconditionally -- it was only being read (via
                  // r.text()) inside the `if (debug)` branch before, so every non-debug request
                  // (i.e. every real request) left this response's body unread too.
                  .then(async (r) => {
                    const body = await r.text();
                    if (debug) debugRefresh.push({ institution: conn.institution_name, item_id: conn.item_id, status: r.status, body });
                  })
                  .catch((e) => {
                    if (debug) debugRefresh.push({ institution: conn.institution_name, item_id: conn.item_id, error: String(e) });
                  })
              : Promise.resolve(),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch {}

        // For investment-type accounts, the balance is only as current as the securities' own
        // pricing date (mutual funds/401k holdings price once per trading day, well after
        // market close) -- confirmed directly: a $194,328.82 401k balance matched holdings
        // priced "as of" the PREVIOUS trading day, not stale data, just normal once-daily NAV
        // pricing. Surface that date per-account so the UI can show "as of <date>" instead of
        // implying the number is live. Also prefer the balance nested in THIS SAME holdings
        // response over /accounts/balance/get's flat cache -- Plaid's balance cache for
        // investment accounts can lag behind what holdings/get already reflects, and since this
        // call happens anyway (for the pricing date), reading its balance too costs nothing
        // extra. holdings/get is a plain read (not the rate-limited investments_refresh action),
        // so this is safe to call on every fetch, not just debug.
        const pricingAsOfByAccount = new Map<string, string>();
        const holdingsBalanceByAccount = new Map<string, number | null>();
        if (conn.hasInvestmentAccount === true) {
          try {
            const holdingsRes = await fetchWithTimeout(`${plaidBase(bindings)}/investments/holdings/get`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: conn.access_token }),
            }, PLAID_FETCH_TIMEOUT_MS);
            // Always consume the body (goal: no unread response left in-flight), and surface a
            // failure here as a visible, user-facing warning instead of only logging it under
            // ?debug=1 -- previously this was silently swallowed, so a canceled/failed holdings
            // fetch (the exact failure mode the deadlock guard causes) looked like a totally
            // clean sync with no indication the pricing/balance data underneath was stale.
            const holdingsText = await holdingsRes.text();
            if (holdingsRes.ok) {
              const holdingsResp = JSON.parse(holdingsText) as {
                holdings?: { account_id: string; institution_price_as_of?: string | null }[];
                accounts?: { account_id: string; balances?: { current: number | null } }[];
              };
              for (const h of holdingsResp.holdings || []) {
                if (!h.institution_price_as_of) continue;
                const existing = pricingAsOfByAccount.get(h.account_id);
                if (!existing || h.institution_price_as_of > existing) pricingAsOfByAccount.set(h.account_id, h.institution_price_as_of);
              }
              for (const a of holdingsResp.accounts || []) {
                if (a.balances?.current != null) holdingsBalanceByAccount.set(a.account_id, a.balances.current);
              }
              if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, holdings: holdingsResp });
            } else {
              errors.push(`${conn.institution_name}: holdings/pricing data may be incomplete (holdings fetch failed)`);
              if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, holdingsError: holdingsText });
            }
          } catch (e) {
            errors.push(`${conn.institution_name}: holdings/pricing data may be incomplete (holdings fetch failed)`);
            if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, error: String(e) });
          }

          // Investment accounts (401k/HSA/IRA) have no "pending" concept in Plaid's data at all --
          // confirmed directly: a debit-card charge Fidelity itself shows as "Processing" simply
          // doesn't appear here yet, unlike /transactions/get's pending=true rows for bank/card
          // accounts. So the client can't show an "Uncleared" figure for these accounts the same
          // way it does for credit cards; instead it flags a vault entry as uncleared when it has
          // no match in this list at all (see the Balances tab in PlaidImport.tsx). A plain read,
          // same as holdings/get above -- safe on every fetch, not just debug.
          try {
            const txRes = await fetchWithTimeout(`${plaidBase(bindings)}/investments/transactions/get`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: PLAID_CLIENT_ID,
                secret: PLAID_SECRET,
                access_token: conn.access_token,
                start_date: startDate,
                end_date: endDate,
              }),
            }, PLAID_FETCH_TIMEOUT_MS);
            // Same pattern as holdings/get above: always consume the body, and surface a failure
            // as a visible warning instead of only under ?debug=1.
            const txText = await txRes.text();
            if (txRes.ok) {
              const txResp = JSON.parse(txText) as { investment_transactions?: unknown[] };
              for (const t of txResp.investment_transactions || [])
                allInvestmentTransactions.push({ ...(t as object), institution_name: conn.institution_name });
              if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, investmentsTransactionsGet: txResp });
            } else {
              errors.push(`${conn.institution_name}: investment transactions may be incomplete (investments/transactions fetch failed)`);
              if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, investmentsTransactionsGetError: txText });
            }
          } catch (e) {
            errors.push(`${conn.institution_name}: investment transactions may be incomplete (investments/transactions fetch failed)`);
            if (debug) debugHoldings.push({ institution: conn.institution_name, item_id: conn.item_id, investmentsTransactionsGetError: String(e) });
          }
        }

        // Fetch transactions and real-time balances in parallel.
        // transactions/get returns cached balances (can be 1-2 days stale).
        // accounts/balance/get makes a live call to the bank for current balances.
        const [txData, balData] = await Promise.all([
          fetchWithTimeout(`${plaidBase(bindings)}/transactions/get`, {
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
          }, PLAID_FETCH_TIMEOUT_MS).then((r) => r.json() as Promise<{ transactions?: unknown[]; accounts?: unknown[]; error_message?: string; error_code?: string }>),
          fetchWithTimeout(`${plaidBase(bindings)}/accounts/balance/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: PLAID_CLIENT_ID,
              secret: PLAID_SECRET,
              access_token: conn.access_token,
            }),
          }, PLAID_FETCH_TIMEOUT_MS)
            .then(async (r) => {
              if (r.ok) return r.json() as Promise<{ accounts?: unknown[] }>;
              await r.text().catch(() => {}); // drain the body -- already has an intentional fallback below
              return null;
            })
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
        (accountSource as any[]).forEach((a: any) => {
          const holdingsBal = holdingsBalanceByAccount.get(a.account_id);
          allAccounts.push({
            ...a,
            institution_name: conn.institution_name,
            ...(holdingsBal != null ? { balances: { ...a.balances, current: holdingsBal } } : {}),
            ...(pricingAsOfByAccount.has(a.account_id) ? { pricingAsOf: pricingAsOfByAccount.get(a.account_id) } : {}),
          });
        });
      } catch (e: any) {
        errors.push(`${conn.institution_name}: ${e.message}`);
      }
    });

  // Sort newest first
  (allTransactions as any[]).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return Response.json(
    {
      transactions: allTransactions,
      accounts: allAccounts,
      investmentTransactions: allInvestmentTransactions,
      errors,
      itemErrors,
      ...(debug ? { debugRefresh, debugHoldings } : {}),
    },
    { headers: CORS_HEADERS }
  );
}
