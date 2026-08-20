import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

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

export async function GET() {
  return Response.json(await load());
}

export async function POST(request: Request) {
  let body: {
    tx_id: string;
    merchant_key: string;
    amount: number;
    vault_voucher_id: number;
    vault_narration: string;
    debit_account_id: number;
    credit_account_id: number;
  };
  try { body = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const matches = await load();

  // Merge into existing pattern if merchant_key + amount already confirmed (±2%)
  const existing = matches.find(
    (m) =>
      m.merchant_key === body.merchant_key &&
      Math.abs(m.amount - body.amount) < Math.max(0.05, body.amount * 0.02)
  );
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

  await bindings.VAULT.put(KEY, JSON.stringify(matches));
  return Response.json({ ok: true });
}
