// Wraps fetch with a bounded timeout via AbortController. Without this, a single slow or hanging
// upstream call has nothing bounding it individually -- it just rides along until the whole
// Worker invocation's own execution limit kicks in, and while it's stuck open it also counts
// against Cloudflare's concurrent-subrequest ceiling, making a slow institution more likely to
// trigger the deadlock guard that force-cancels OTHER, perfectly healthy in-flight requests too
// (see app/api/plaid/transactions/route.ts's CONNECTION_SYNC_CONCURRENCY).
export async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
