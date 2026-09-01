export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  SYNC_SECRET?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  // Second Plaid project -- used ONLY for brand-new bank connections once the first project's
  // free-tier connection limit is exhausted. Existing connections keep using PLAID_CLIENT_ID/
  // PLAID_SECRET above (each stored connection remembers which pair created it -- see
  // Connection.client in app/api/plaid/connections/route.ts).
  PLAID_CLIENT_ID_2?: string;
  PLAID_SECRET_2?: string;
  PLAID_ENV?: string;
  TELLER_APP_ID?: string;
  TELLER_CERT?: { fetch: typeof fetch };
  GROQ_API_KEY?: string;
  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
}
