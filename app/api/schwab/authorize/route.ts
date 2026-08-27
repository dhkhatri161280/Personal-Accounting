import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { SCHWAB_REDIRECT_URI } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Step 1 of the OAuth authorization-code flow: send the user to Schwab's own login/consent
// page. They authenticate directly with Schwab (this app never sees their Schwab password),
// then Schwab redirects back to /api/schwab/callback with a one-time code.
export async function GET() {
  const clientId = bindings.SCHWAB_CLIENT_ID;
  if (!clientId) {
    return new Response(
      "Schwab not configured — set SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET worker secrets",
      { status: 503 }
    );
  }
  const url = new URL("https://api.schwabapi.com/v1/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", SCHWAB_REDIRECT_URI);
  return Response.redirect(url.toString(), 302);
}
