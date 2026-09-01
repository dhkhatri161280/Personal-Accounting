import type { AppBindings } from "@/lib/cloudflare-env";

export type PlaidClientKey = "primary" | "secondary";

// Resolves which Plaid project's client_id/secret to use. "secondary" is the second (newer)
// Plaid trial project -- new bank connections default to it once configured, so they consume
// its own free-tier connection limit instead of the primary project's, which is already maxed
// out. Falls back to primary if the secondary pair isn't configured yet, so nothing breaks
// before the user finishes setting the new secrets.
export function plaidCreds(bindings: AppBindings, client: PlaidClientKey | undefined) {
  if (client === "secondary" && bindings.PLAID_CLIENT_ID_2 && bindings.PLAID_SECRET_2) {
    return { clientId: bindings.PLAID_CLIENT_ID_2, secret: bindings.PLAID_SECRET_2 };
  }
  return { clientId: bindings.PLAID_CLIENT_ID, secret: bindings.PLAID_SECRET };
}

export function plaidBase(b: AppBindings) {
  return (b.PLAID_ENV || "sandbox") === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";
}
