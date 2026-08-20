import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

async function etag(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `"${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}"`;
}

function vaultKey(request: Request) {
  const book = new URL(request.url).searchParams.get("book");
  return book === "india" ? "personal-ledger.india.vault" : "personal-ledger.vault";
}

export async function GET(request: Request) {
  let value: string | null;
  try {
    value = await bindings.VAULT.get(vaultKey(request));
  } catch {
    return new Response("Vault storage unavailable", { status: 503 });
  }
  if (!value) return new Response("Vault not initialized", { status: 404 });
  return new Response(value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ETag: await etag(value),
    },
  });
}

export async function HEAD(request: Request) {
  let value: string | null;
  try {
    value = await bindings.VAULT.get(vaultKey(request));
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!value) return new Response(null, { status: 404 });
  return new Response(null, { headers: { "Cache-Control": "no-store", ETag: await etag(value) } });
}

export async function PUT(request: Request) {
  const body = await request.text();
  if (body.length < 100 || body.length > 24_000_000)
    return new Response("Invalid vault", { status: 400 });
  let envelope: any;
  try {
    envelope = JSON.parse(body);
  } catch {
    return new Response("Invalid vault JSON", { status: 400 });
  }
  if (
    !envelope ||
    envelope.algorithm !== "AES-256-GCM" ||
    !Number.isSafeInteger(envelope.iterations) ||
    envelope.iterations < 100000 ||
    !["salt", "iv", "tag", "ciphertext"].every(
      (key) => typeof envelope[key] === "string" && envelope[key].length > 0
    )
  )
    return new Response("Invalid encrypted vault envelope", { status: 400 });

  const key = vaultKey(request);
  let current: string | null;
  try {
    current = await bindings.VAULT.get(key);
  } catch {
    return new Response("Vault storage unavailable", { status: 503 });
  }

  const expected = request.headers.get("If-Match");

  // If-Match is required when a vault already exists — prevents blind overwrites.
  if (current && !expected)
    return new Response("If-Match header required to update existing vault", { status: 428 });

  if (expected && current && (await etag(current)) !== expected)
    return new Response("Vault changed since download; sync again.", { status: 412 });

  await bindings.VAULT.put(key, body);
  return Response.json({ ok: true, bytes: body.length, etag: await etag(body) });
}
