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

  // Responses returned by the Cache API always have immutable headers — rebuilding into a
  // fresh Response is required here too, not just on the miss path below, or the caller's
  // own header-merging (e.g. vinext's Vary-header step) throws "Can't modify immutable
  // headers" the moment it tries to touch them.
  const cached = await cache.match(cacheKey);
  if (cached) return await rebuildMutable(cached);

  const response = await compute();
  if (!response.ok) return response;

  const cacheable = await rebuildMutable(response);
  cacheable.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  await cache.put(cacheKey, cacheable.clone());
  return cacheable;
}

async function rebuildMutable(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
