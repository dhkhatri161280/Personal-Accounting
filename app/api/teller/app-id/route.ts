import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Returns the Teller application ID to the client (needed for Teller Connect widget)
export async function GET() {
  const appId = bindings.TELLER_APP_ID;
  if (!appId) return Response.json({ error: "Teller not configured" }, { status: 503 });
  return Response.json({ applicationId: appId });
}
