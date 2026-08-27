import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getValidAccessToken } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

async function getAccountHashes(accessToken: string): Promise<{ accountNumber: string; hashValue: string }[]> {
  const resp = await fetch("https://api.schwabapi.com/trader/v1/accounts/accountNumbers", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`accountNumbers failed (${resp.status})`);
  return (await resp.json()) as { accountNumber: string; hashValue: string }[];
}

// Diagnostic pass-through to Schwab's transaction history, so real BUY lot dates/prices can be
// inspected before building the actual sync logic on top of them. Defaults to the last 2 years
// (Schwab's own max lookback window) to capture every lot that could still be an open position.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const startDate = url.searchParams.get("startDate") ?? new Date(Date.now() - 2 * 365 * 86_400_000).toISOString();
  const endDate = url.searchParams.get("endDate") ?? new Date().toISOString();

  const token = await getValidAccessToken(bindings);
  if (!token.ok) return Response.json({ error: `Schwab not usable: ${token.reason}` }, { status: 401 });

  let hashes: { accountNumber: string; hashValue: string }[];
  try {
    hashes = await getAccountHashes(token.accessToken);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }

  const accounts = await Promise.all(
    hashes.map(async (h) => {
      const txUrl = new URL(`https://api.schwabapi.com/trader/v1/accounts/${h.hashValue}/transactions`);
      txUrl.searchParams.set("startDate", startDate);
      txUrl.searchParams.set("endDate", endDate);
      txUrl.searchParams.set("types", "TRADE");
      const resp = await fetch(txUrl.toString(), { headers: { Authorization: `Bearer ${token.accessToken}` } });
      const text = await resp.text();
      if (!resp.ok) return { accountNumber: h.accountNumber, error: `Transactions fetch failed (${resp.status})`, raw: text.slice(0, 500) };
      try {
        return { accountNumber: h.accountNumber, data: JSON.parse(text) };
      } catch {
        return { accountNumber: h.accountNumber, error: "Non-JSON response", raw: text.slice(0, 500) };
      }
    })
  );

  return Response.json({ accounts });
}
