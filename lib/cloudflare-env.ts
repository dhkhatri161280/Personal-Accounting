export interface AppBindings {
  VAULT: KVNamespace;
  DB: D1Database;
  SYNC_SECRET?: string;
}
