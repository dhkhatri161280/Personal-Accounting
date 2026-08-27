import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getValidAccessToken } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Schwab's account IDs are pseudonymized: the real account number has to be exchanged for an
// opaque "hashValue" via /accountNumbers before it can be used in any other Accounts call.
async function getAccountHashes(accessToken: string): Promise<{ accountNumber: string; hashValue: string }[]> {
  const resp = await fetch("https://api.schwabapi.com/trader/v1/accounts/accountNumbers", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`accountNumbers failed (${resp.status})`);
  return (await resp.json()) as { accountNumber: string; hashValue: string }[];
}

// Returns Schwab's raw per-account response (including securitiesAccount.positions[]) rather
// than a normalized shape -- first pass is to see the REAL data before mapping it into this
// app's Trade/dividend model.
export async function GET() {
  const token = await getValidAccessToken(bindings);
  if (!token.ok) return Response.json({ error: `Schwab not usable: ${token.reason}` }, { status: 401 });

  let hashes: { accountNumber: string; hashValue: string }[];
  try {
    hashes = await getAccountHashes(token.accessToken);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
  if (hashes.length === 0) return Response.json({ accounts: [] });

  const accounts = await Promise.all(
    hashes.map(async (h) => {
      const resp = await fetch(
        `https://api.schwabapi.com/trader/v1/accounts/${h.hashValue}?fields=positions`,
        { headers: { Authorization: `Bearer ${token.accessToken}` } }
      );
      const text = await resp.text();
      if (!resp.ok) return { accountNumber: h.accountNumber, error: `Positions fetch failed (${resp.status})`, raw: text.slice(0, 500) };
      try {
        return { accountNumber: h.accountNumber, data: JSON.parse(text) };
      } catch {
        return { accountNumber: h.accountNumber, error: "Non-JSON response", raw: text.slice(0, 500) };
      }
    })
  );

  return Response.json({ accounts });
}
