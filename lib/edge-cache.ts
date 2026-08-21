/**
 * Explicitly caches a GET response at the Cloudflare edge using the Workers
 * Cache API. A `Cache-Control` header alone does NOT get honored by
 * Cloudflare's CDN for Worker-generated responses (that requires either
 * this API or Cache Rules on a zone, which workers.dev domains don't have) —
 * so bot/crawler traffic still invokes the Worker (and any KV reads inside
 * it) on every request unless the response is stored here.
 */
export async function withEdgeCache(
  request: Request,
  ttlSeconds: number,
  compute: () => Promise<Response>
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(request.url, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await compute();
  if (response.ok) {
    response.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, response.clone());
  }
  return response;
}
