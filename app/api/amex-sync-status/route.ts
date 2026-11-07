import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { withEdgeCache } from "@/lib/edge-cache";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Same PUT (local machine, Bearer SYNC_SECRET) / GET (app, polled) pattern as
// /api/sync-status, for the Amex Benefits scheduled refresh (tools/amex-benefits/run-scheduled.ps1)
// instead of Tally. Simpler shape -- no matched/tallyToApp/conflicts counts, just whether the
// last run succeeded and why if it didn't. Before this existed, the app could only infer a
// problem from staleness (lastCheckedAt on the benefit records themselves going stale) and had to
// GUESS at the reason in its own banner text ("either the machine was off, or Amex signed out") --
// this lets the local script report the ACTUAL reason (e.g. a real sign-out vs. a cold-start
// timeout) so the in-app message is accurate instead of a guess, and lets a "Retry sync" tap
// (via /api/sync-trigger?book=amex) actually mean something once paired with a local poller.
const KEY = "fintech-by-dk.amex-benefits.sync-status";

function clean(input: any) {
  const status = ["success", "pending", "error"].includes(String(input?.status))
    ? String(input.status)
    : "pending";
  return {
    status,
    lastCheckedAt: input?.lastCheckedAt || null,
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
    let raw: string | null;
    try {
      raw = await bindings.VAULT.get(KEY);
    } catch {
      return Response.json(
        { status: "error", message: "Sync status storage unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!raw)
      return Response.json({ status: "pending", lastCheckedAt: null, message: "No Amex Benefits sync status published yet" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json(
        { status: "error", message: "Sync status record corrupted" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(clean(parsed));
  });
}

export async function PUT(request: Request) {
  if (!bindings.VAULT) return new Response("Status storage not configured", { status: 503 });
  if (!bindings.SYNC_SECRET) return new Response("Sync secret not configured on Worker", { status: 503 });
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader) return new Response("Missing sync authorization", { status: 401 });
  if (authHeader !== `Bearer ${bindings.SYNC_SECRET}`) return new Response("Invalid sync authorization", { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const cleaned = clean(body);
  cleaned.lastCheckedAt = new Date().toISOString();

  try {
    await bindings.VAULT.put(KEY, JSON.stringify(cleaned));
  } catch {
    return new Response("Sync status storage unavailable", { status: 503 });
  }
  return Response.json({ ok: true, ...cleaned });
}
