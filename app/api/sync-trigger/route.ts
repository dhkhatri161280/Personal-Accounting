import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

function bookOf(request: Request) {
  const b = (new URL(request.url).searchParams.get("book") || "us").toLowerCase();
  return b === "india" ? "india" : "us";
}
function triggerKey(book: string) {
  return `fintech-by-dk.sync-trigger.${book}`;
}

// Called by trigger-check.mjs on digne — reads and consumes the flag
export async function GET(request: Request) {
  if (!bindings.VAULT) return Response.json({ triggered: false });
  const book = bookOf(request);
  const key = triggerKey(book);
  let val: string | null;
  try {
    val = await bindings.VAULT.get(key);
  } catch {
    return Response.json({ triggered: false, book });
  }
  if (!val) return Response.json({ triggered: false, book });
  try {
    await bindings.VAULT.delete(key);
  } catch {
    // best effort
  }
  return Response.json({ triggered: true, book });
}

// Called by the app UI "Sync Now" button
export async function POST(request: Request) {
  if (!bindings.VAULT) return new Response("Storage not configured", { status: 503 });
  const book = bookOf(request);
  try {
    await bindings.VAULT.put(triggerKey(book), "1", { expirationTtl: 300 });
  } catch {
    return new Response("Storage unavailable", { status: 503 });
  }
  return Response.json({ ok: true, book });
}
