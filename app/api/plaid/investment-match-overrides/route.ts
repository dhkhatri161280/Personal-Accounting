import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Investment-account (401k/HSA) reconciliation has no Plaid "pending" concept to confirm against
// (see app/api/plaid/transactions/route.ts's investmentTransactions comment) -- instead it
// auto-matches a vault entry to a settled Plaid investment_transaction by amount+date. That
// heuristic can false-positive on a same-amount coincidence (e.g. two separate pharmacy charges
// a few days apart for the identical dollar amount). This is the escape hatch: a vault voucher
// guid the user has explicitly said "no, don't treat this as matched" for -- once listed here, the
// Balances tab always shows it as still uncleared, regardless of what the amount/date heuristic
// would otherwise conclude. Mirrors app/api/plaid/confirmed-matches/route.ts's KV pattern.
const KEY = "plaid.investment-match-overrides";

async function load(): Promise<string[]> {
  try {
    const raw = await bindings.VAULT.get(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function GET() {
  return Response.json(await load());
}

export async function POST(request: Request) {
  let body: { voucher_guid: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.voucher_guid) return new Response("Missing voucher_guid", { status: 400 });

  const guids = await load();
  if (!guids.includes(body.voucher_guid)) guids.push(body.voucher_guid);

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(guids));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  let body: { voucher_guid: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const guids = await load();
  const next = guids.filter((g) => g !== body.voucher_guid);

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(next));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}
