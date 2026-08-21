import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { withEdgeCache } from "@/lib/edge-cache";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

function bookOf(request: Request) {
  const b = (new URL(request.url).searchParams.get("book") || "us").toLowerCase();
  return b === "india" ? "india" : "us";
}
function key(book: string) {
  return "fintech-by-dk.book." + book + ".sync-status";
}
function clean(input: any, book: string) {
  const status = ["success", "pending", "error"].includes(String(input?.status))
    ? String(input.status)
    : "pending";
  return {
    book,
    status,
    lastCheckedAt: input?.lastCheckedAt || null,
    matched: Number(input?.matched || 0),
    tallyToApp: Number(input?.tallyToApp || 0),
    appToTally: Number(input?.appToTally || 0),
    conflicts: Number(input?.conflicts || 0),
    errors: Number(input?.errors || 0),
    message: String(input?.message || ""),
  };
}

export async function GET(request: Request) {
  if (!bindings.VAULT)
    return Response.json(
      { status: "pending", message: "Status storage not configured" },
      { headers: { "Cache-Control": "no-store" } }
    );

  return withEdgeCache(request, 60, async () => {
    const book = bookOf(request);
    let raw: string | null;
    try {
      raw = await bindings.VAULT.get(key(book));
    } catch {
      return Response.json(
        { book, status: "error", message: "Sync status storage unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!raw)
      return Response.json({
        book,
        status: "pending",
        lastCheckedAt: null,
        matched: 0,
        tallyToApp: 0,
        appToTally: 0,
        conflicts: 0,
        errors: 0,
        message: "No Tally sync status published yet",
      });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json(
        { book, status: "error", message: "Sync status record corrupted" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(clean(parsed, book));
  });
}

export async function PUT(request: Request) {
  if (!bindings.VAULT) return new Response("Status storage not configured", { status: 503 });

  if (!bindings.SYNC_SECRET)
    return new Response("Sync secret not configured on Worker", { status: 503 });
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader) return new Response("Missing sync authorization", { status: 401 });
  if (authHeader !== `Bearer ${bindings.SYNC_SECRET}`)
    return new Response("Invalid sync authorization", { status: 403 });

  const book = bookOf(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const cleaned = clean(body, book);
  cleaned.lastCheckedAt = new Date().toISOString();

  // Skip the KV write entirely when nothing but the timestamp changed — the
  // sync script may call this far more often than the underlying status
  // actually changes, and every write counts against the daily KV put quota.
  try {
    const existingRaw = await bindings.VAULT.get(key(book));
    if (existingRaw) {
      const existing = clean(JSON.parse(existingRaw), book);
      const { lastCheckedAt: _a, ...existingRest } = existing;
      const { lastCheckedAt: _b, ...newRest } = cleaned;
      if (JSON.stringify(existingRest) === JSON.stringify(newRest)) {
        return Response.json({ ok: true, ...existing, lastCheckedAt: existing.lastCheckedAt });
      }
    }
  } catch {
    // fall through and write — better to over-write than lose a real update
  }

  try {
    await bindings.VAULT.put(key(book), JSON.stringify(cleaned));
  } catch {
    return new Response("Sync status storage unavailable", { status: 503 });
  }
  return Response.json({ ok: true, ...cleaned });
}
