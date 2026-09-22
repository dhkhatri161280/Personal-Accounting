import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Public, no auth needed -- this is just "which build is currently live," not user data. Backed
// by Cloudflare's own version_metadata binding (see wrangler.biometric.json) instead of a
// manually-typed string, so it can never go stale the way "ACCOUNTING RELEASE 5" did.
export async function GET() {
  const meta = bindings.CF_VERSION_METADATA;
  if (!meta) return Response.json({ id: null, timestamp: null }, { headers: { "Cache-Control": "no-store" } });
  return Response.json(
    { id: meta.id.slice(0, 8), timestamp: new Date(Number(meta.timestamp)).toISOString() },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
