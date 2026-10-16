export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  // Free in-app chat assistant (components/ChatAssistant.tsx, app/api/assistant) -- Cloudflare's
  // own hosted open-weight models, billed in "Neurons" with a real recurring daily free
  // allocation (10,000/day) and, critically, no way to accidentally get billed past it on the
  // Free Workers plan (requests just fail until the next day's reset, never silently charges).
  AI: Ai;
  // Optional quota-stacking fallback for the SAME free Workers AI model, once AI's own daily
  // Neurons pool runs dry -- explicitly requested instead of a third-party provider (Gemini,
  // Groq, ...) because the user doesn't want real financial data (narrations, account names,
  // amounts, all present in tool-result messages by the time a reply is generated) leaving
  // Cloudflare's own infrastructure at all. A second (or third, ...) Cloudflare account has its
  // OWN separate 10,000 Neurons/day pool; the AI binding above can only ever reach the account
  // this Worker itself lives in, so reaching another account's pool means calling Cloudflare's
  // own REST API (api.cloudflare.com) with that account's id + an API token instead -- still
  // 100% Cloudflare's own AI product on both ends, just not the zero-network-surface native
  // binding app/api/assistant's own history comment describes for the primary account.
  // JSON array (not fixed numbered vars like PLAID_CLIENT_ID_2/PLAID_SECRET_2 above) because the
  // user wants to add accounts later without further code changes:
  // '[{"accountId":"...","apiToken":"..."},...]'. Tried in array order only after the primary
  // account's own quota is exhausted. See app/api/assistant/route.ts's runModel.
  AI_FALLBACK_ACCOUNTS?: string;
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
  // Cloudflare's own record of the currently-running deployment -- see wrangler.biometric.json's
  // version_metadata binding. Powers the header's real build stamp (see app/api/build-info)
  // instead of the old manually-typed "Release N" string that never got updated after the first
  // few deploys and drifted from reality.
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: number | string };
}
