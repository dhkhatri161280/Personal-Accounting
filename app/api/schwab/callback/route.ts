import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { exchangeCodeForTokens } from "@/lib/schwab-oauth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Step 2 of the OAuth flow: Schwab redirects here after the user logs in and approves access,
// with a one-time authorization code in the query string. Exchange it for an access/refresh
// token pair and send the user back into the app.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`Schwab authorization was denied or failed: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response("Missing authorization code from Schwab", { status: 400 });
  }

  const result = await exchangeCodeForTokens(bindings, code);
  if (!result.ok) {
    return new Response(`Schwab connection failed: ${result.error}`, { status: 502 });
  }

  return Response.redirect(new URL("/vault?schwab=connected", request.url).toString(), 302);
}
