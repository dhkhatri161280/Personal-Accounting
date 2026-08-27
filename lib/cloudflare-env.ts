export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  SYNC_SECRET?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string;
  TELLER_APP_ID?: string;
  TELLER_CERT?: { fetch: typeof fetch };
  GROQ_API_KEY?: string;
  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
}
