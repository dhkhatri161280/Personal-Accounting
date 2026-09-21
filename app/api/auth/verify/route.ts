import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { requireAccessToken } from "@/lib/api-auth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Dedicated, side-effect-free endpoint for AccessGate.tsx to check a candidate access code
// against the real one, without piggybacking on some other route that has real side effects
// (a KV write, an external API call) just to borrow its auth check.
export async function GET(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;
  return Response.json({ ok: true });
}
