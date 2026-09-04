import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Investment-account (401k/HSA) reconciliation has no Plaid "pending" concept to confirm against
// (see app/api/plaid/transactions/route.ts's investmentTransactions comment) -- instead it
// auto-matches a vault entry to a settled Plaid investment_transaction by amount+date. That
// heuristic can false-positive on a same-amount coincidence (e.g. two separate pharmacy charges
// a few days apart for the identical dollar amount). This is the escape hatch: the user rejects one
// specific (voucher, Plaid transaction) pairing -- NOT the voucher outright -- because a recurring
// merchant means a later, genuinely-matching Plaid transaction can still show up for the same
// voucher and must still be allowed to match then. Mirrors
// app/api/plaid/confirmed-matches/route.ts's KV pattern.
const KEY = "plaid.investment-match-overrides";

type OverridePair = { voucher_guid: string; plaid_transaction_id: string };

async function load(): Promise<OverridePair[]> {
  try {
    const raw = await bindings.VAULT.get(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Back-compat: earlier format stored bare voucher guid strings (blocked the voucher forever).
    // Drop those on read -- they're the exact bug being fixed, and re-blocking the voucher is worse
    // than losing the old rejection (the user can reject again if the wrong match recurs).
    return Array.isArray(parsed) ? parsed.filter((p): p is OverridePair => typeof p === "object" && p?.voucher_guid && p?.plaid_transaction_id) : [];
  } catch {
    return [];
  }
}

export async function GET() {
  return Response.json(await load());
}

export async function POST(request: Request) {
  let body: OverridePair;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.voucher_guid || !body.plaid_transaction_id) {
    return new Response("Missing voucher_guid or plaid_transaction_id", { status: 400 });
  }

  const pairs = await load();
  if (!pairs.some((p) => p.voucher_guid === body.voucher_guid && p.plaid_transaction_id === body.plaid_transaction_id)) {
    pairs.push({ voucher_guid: body.voucher_guid, plaid_transaction_id: body.plaid_transaction_id });
  }

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(pairs));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  let body: OverridePair;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const pairs = await load();
  const next = pairs.filter((p) => !(p.voucher_guid === body.voucher_guid && p.plaid_transaction_id === body.plaid_transaction_id));

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(next));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}
