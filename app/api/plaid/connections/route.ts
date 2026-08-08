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

async function loadConnections(): Promise<Connection[]> {
  try {
    const raw = await bindings.VAULT.get(CONNECTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// List connections (strips access_token — never sent to client)
export async function GET() {
  const connections = await loadConnections();
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

  const connections = await loadConnections();
  const filtered = connections.filter((c) => c.item_id !== body.item_id);
  await bindings.VAULT.put(CONNECTIONS_KEY, JSON.stringify(filtered));
  return Response.json({ ok: true, removed: connections.length - filtered.length });
}
