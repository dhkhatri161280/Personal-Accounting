import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const CONNECTIONS_KEY = "plaid.connections";

type Connection = {
  access_token: string;
  item_id: string;
  institution_name: string;
  institution_id: string;
  connected_at: string;
};

// Throws on a real storage failure instead of silently returning [] -- a caller treating a
// failed read as "no connections" and then writing that empty list back (e.g. DELETE below)
// would wipe out every other already-connected bank on a transient KV hiccup.
async function loadConnections(): Promise<Connection[]> {
  const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
  return raw ? JSON.parse(raw) : [];
}

// List connections (strips access_token — never sent to client)
export async function GET() {
  let connections: Connection[];
  try {
    connections = await loadConnections();
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }
  return Response.json(
    connections.map(({ access_token: _, ...c }) => c)
  );
}

// Disconnect a bank by item_id
export async function DELETE(request: Request) {
  let body: { item_id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.item_id) return new Response("Missing item_id", { status: 400 });

  let connections: Connection[];
  try {
    connections = await loadConnections();
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }
  const filtered = connections.filter((c) => c.item_id !== body.item_id);
  try {
    await bindings.VAULT.put(CONNECTIONS_KEY, JSON.stringify(filtered));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true, removed: connections.length - filtered.length });
}
