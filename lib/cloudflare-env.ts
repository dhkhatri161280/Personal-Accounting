export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  SYNC_SECRET?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: string; // "sandbox" | "production" — defaults to sandbox
}
