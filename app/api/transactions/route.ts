import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import type { AppBindings } from "@/lib/cloudflare-env";
const bindings = env as unknown as AppBindings;
export async function POST(request: Request) {
  try {
    const b = (await request.json()) as any;
    const amount = Number(b.amount);
    if (
      !b.date ||
      !b.debitAccountId ||
      !b.creditAccountId ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return NextResponse.json({ error: "Complete all required fields." }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)))
      return NextResponse.json({ error: "Invalid date format — use YYYY-MM-DD." }, { status: 400 });
    if (String(b.debitAccountId) === String(b.creditAccountId))
      return NextResponse.json({ error: "Choose two different accounts." }, { status: 400 });
    const guid = crypto.randomUUID(),
      type = b.type || "Journal",
      now = new Date().toISOString();
    await bindings.DB.batch([
      bindings.DB.prepare(
        `INSERT INTO vouchers(tally_guid,voucher_number,voucher_type,transaction_date,narration,currency,is_historical,imported_at) VALUES(?,?,?,?,?,'USD',0,?)`
      ).bind(guid, b.reference || null, type, b.date, b.narration || null, now),
      bindings.DB.prepare(
        `INSERT INTO entries(voucher_id,account_id,amount,is_debit) SELECT id,?, ?,1 FROM vouchers WHERE tally_guid=?`
      ).bind(Number(b.debitAccountId), amount, guid),
      bindings.DB.prepare(
        `INSERT INTO entries(voucher_id,account_id,amount,is_debit) SELECT id,?, ?,0 FROM vouchers WHERE tally_guid=?`
      ).bind(Number(b.creditAccountId), amount, guid),
    ]);
    return NextResponse.json({ ok: true, guid });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unable to save transaction" },
      { status: 500 }
    );
  }
}
