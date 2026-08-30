import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Dedup ledger for Schwab transaction-sync (Import tab): tracks which Schwab activityIds have
// already been turned into a vault Trade/Tx, so re-running "check for new activity" never
// re-stages (and risks re-confirming) something already imported. Schwab's activityId is a
// stable per-event ID, so this is a plain exact-match list -- no fuzzy matching needed, unlike
// Plaid's confirmed-matches (see app/api/plaid/confirmed-matches/route.ts), which this mirrors.
const KEY = "schwab.imported-activities";

export type ImportedSchwabActivity = {
  activityId: number;
  kind: "trade" | "transferIn" | "dividendInterest";
  vaultTradeId?: string;
  vaultVoucherGuid?: string;
  importedAt: string;
};

async function load(): Promise<ImportedSchwabActivity[]> {
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
  let body: Omit<ImportedSchwabActivity, "importedAt"> & { importedAt?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const list = await load();
  if (!list.some((x) => x.activityId === body.activityId)) {
    list.push({ ...body, importedAt: body.importedAt || new Date().toISOString() });
  }
  try {
    await bindings.VAULT.put(KEY, JSON.stringify(list));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  let body: { activityId: number };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const list = await load();
  const next = list.filter((x) => x.activityId !== body.activityId);
  try {
    await bindings.VAULT.put(KEY, JSON.stringify(next));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}
