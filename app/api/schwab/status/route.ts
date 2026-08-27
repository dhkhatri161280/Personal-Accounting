import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { getConnection, disconnectSchwab } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

export async function GET() {
  const conn = await getConnection(bindings);
  if (!conn) return Response.json({ connected: false });

  const refreshExpiresAt = conn.refresh_token_expires_at;
  const daysUntilReauth = Math.max(0, Math.ceil((new Date(refreshExpiresAt).getTime() - Date.now()) / 86_400_000));
  return Response.json({
    connected: true,
    connectedAt: conn.connected_at,
    refreshTokenExpiresAt: refreshExpiresAt,
    daysUntilReauth,
  });
}

export async function DELETE() {
  await disconnectSchwab(bindings);
  return Response.json({ ok: true });
}
