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

interface SchwabRawPosition {
  longQuantity?: number;
  shortQuantity?: number;
  averagePrice?: number;
  marketValue?: number;
  instrument?: { symbol?: string; assetType?: string };
}

export interface NormalizedPosition {
  symbol: string;
  quantity: number;
  avgPrice: number;
  marketValue: number;
}

// Normalized to just what a sync/reconciliation feature needs: current quantity, blended average
// cost, and market value per symbol. No lot-level detail is available (see /schwab/transactions --
// that data isn't accessible under this product), so this is a snapshot, not a history.
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
        const parsed = JSON.parse(text) as {
          securitiesAccount?: { positions?: SchwabRawPosition[]; currentBalances?: { cashBalance?: number } };
        };
        const raw = parsed.securitiesAccount?.positions ?? [];
        const positions: NormalizedPosition[] = raw
          .filter((p) => p.instrument?.assetType === "EQUITY" && p.instrument?.symbol)
          .map((p) => ({
            symbol: p.instrument!.symbol!,
            quantity: (p.longQuantity ?? 0) - (p.shortQuantity ?? 0),
            avgPrice: p.averagePrice ?? 0,
            marketValue: p.marketValue ?? 0,
          }));
        // Real uninvested cash sitting in the account -- distinct from the "Charles Schwab" GL
        // ledger, which tracks cumulative dividends/interest received, not current cash (see
        // Trading report's Cash Balance line).
        const cashBalance = parsed.securitiesAccount?.currentBalances?.cashBalance;
        return { accountNumber: h.accountNumber, positions, cashBalance };
      } catch {
        return { accountNumber: h.accountNumber, error: "Non-JSON or unexpected response", raw: text.slice(0, 500) };
      }
    })
  );

  return Response.json({ accounts });
}
