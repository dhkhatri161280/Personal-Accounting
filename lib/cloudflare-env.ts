export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  // Voucher receipt/statement attachments -- file bytes live here, only lightweight metadata
  // (key/filename/size/contentType) lives in the encrypted vault blob. See app/api/attachments.
  ATTACHMENTS: R2Bucket;
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
  // Gates every API route that returns or mutates real personal/financial data (Plaid/Teller/
  // Schwab endpoints, attachments, the vault PUT, watchlist, categorize) -- separate from the
  // vault password, which is never sent to the server at all (decryption happens entirely
  // client-side). Without this, those routes had no server-side auth whatsoever: anyone who
  // found the Worker's public URL could call them directly and get live, already-decrypted
  // financial data with no password. See lib/api-auth.ts.
  API_ACCESS_TOKEN?: string;
}
