import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { requireAccessToken } from "@/lib/api-auth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const KEY = "plaid.confirmed-matches";

export type ConfirmedMatch = {
  id: string;
  merchant_key: string;   // normalized keyword for future pattern matching
  amount: number;         // abs amount for future pattern matching
  vault_voucher_id: number;
  vault_narration: string;
  debit_account_id: number;
  credit_account_id: number;
  confirmed_tx_ids: string[]; // specific Plaid tx IDs manually confirmed
  confirmed_at: string;
};

async function load(): Promise<ConfirmedMatch[]> {
  try {
    const raw = await bindings.VAULT.get(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function GET(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;
  return Response.json(await load());
}

type ConfirmBody = {
  tx_id: string;
  merchant_key: string;
  amount: number;
  vault_voucher_id: number;
  vault_narration: string;
  debit_account_id: number;
  credit_account_id: number;
};

// Merge one confirmation into an in-memory list (mutates `matches`) -- shared by the single and
// bulk POST paths.
//
// Only merges into an existing record for the SAME voucher (Plaid can reissue a new
// transaction_id for an already-confirmed pending item on a later fetch -- see PlaidImport.tsx's
// alreadyImported() comment on this). Previously also merged across DIFFERENT vouchers whenever
// merchant_key+amount happened to be close (e.g. two separate "Costco" charges a few dollars
// apart) -- since a ConfirmedMatch only carries ONE vault_voucher_id, that merge silently
// DISCARDED every voucher's id after the first one to match a given pattern. Confirmed live: bulk
// "Reconcile all" on 75 candidates kept reporting success but the badge count never actually
// dropped, because most of the 75 distinct vault_voucher_ids never got their own record at all --
// they'd each collided into whichever earlier voucher first claimed that merchant/amount pattern.
function applyConfirm(matches: ConfirmedMatch[], body: ConfirmBody) {
  const existing = matches.find((m) => m.vault_voucher_id === body.vault_voucher_id);
  if (existing) {
    if (!existing.confirmed_tx_ids.includes(body.tx_id))
      existing.confirmed_tx_ids.push(body.tx_id);
  } else {
    matches.push({
      id: crypto.randomUUID(),
      merchant_key: body.merchant_key,
      amount: body.amount,
      vault_voucher_id: body.vault_voucher_id,
      vault_narration: body.vault_narration,
      debit_account_id: body.debit_account_id,
      credit_account_id: body.credit_account_id,
      confirmed_tx_ids: [body.tx_id],
      confirmed_at: new Date().toISOString(),
    });
  }
}

export async function POST(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  let parsed: unknown;
  try { parsed = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const matches = await load();

  // Bulk path: { matches: ConfirmBody[] } -- applies every confirmation against ONE in-memory
  // list and writes ONCE. Cloudflare KV is only eventually consistent, so N separate
  // POST-per-confirmation requests (each doing its own read-then-write of this same key) can
  // race: a later request's read may not yet reflect an earlier request's very recent write,
  // silently dropping it when that later request overwrites the key. Confirmed live: bulk
  // "Reconcile all" runs kept reporting success but the candidate count never actually dropped
  // on refresh. A single read + single write for the whole batch removes the race entirely.
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { matches?: unknown }).matches)) {
    const body = parsed as { matches: ConfirmBody[] };
    for (const item of body.matches) applyConfirm(matches, item);
    try {
      await bindings.VAULT.put(KEY, JSON.stringify(matches));
    } catch (e: any) {
      return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
    }
    return Response.json({ ok: true, count: body.matches.length });
  }

  applyConfirm(matches, parsed as ConfirmBody);

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(matches));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  let body: { tx_id: string };
  try { body = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const matches = await load();
  const next = matches
    .map((m) => ({ ...m, confirmed_tx_ids: m.confirmed_tx_ids.filter((id) => id !== body.tx_id) }))
    .filter((m) => m.confirmed_tx_ids.length > 0);

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(next));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}
