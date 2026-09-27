// Runs `fn` over `items` with at most `limit` in flight at once, preserving input order in the
// returned array regardless of which items finish first. Used by app/api/plaid/transactions/
// route.ts to cap how many bank connections sync in parallel -- each connection can itself fire
// several concurrent fetches to Plaid, and running every connection fully in parallel (5+ banks
// x up to 6 fetches each) was enough simultaneous in-flight requests to trip Cloudflare Workers'
// own concurrent-subrequest ceiling, which force-cancels the OLDEST still-open response to avoid
// deadlock (confirmed live, twice, via `wrangler tail`).
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
