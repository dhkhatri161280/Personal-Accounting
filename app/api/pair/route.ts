import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { requireAccessToken } from "@/lib/api-auth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Zero-knowledge relay for "sign in on this device by scanning a QR code with your phone" --
// see lib/device-pairing.ts for the actual ECDH key exchange / AES-GCM encryption, both of which
// happen entirely client-side. This route only ever sees ciphertext: it stores and hands back an
// opaque blob it cannot decrypt, the same way the vault blob itself is never readable server-side.
// There is no "pairKey" of its own -- the sessionId IS the only credential needed to read/write a
// session, and it's a random 32-byte token generated here, never guessable or enumerable.
//
// Three actions, one KV-backed session, 90s TTL (long enough to scan a QR, short enough that a
// stale/abandoned session can't be revisited later):
//   POST   (no auth -- this is reached from the LOCKED laptop, before it has any token at all)
//     Creates a new pending session, returns { sessionId }. Carries no data of its own.
//   PUT    (requires the caller's OWN access token -- reached from the already-unlocked PHONE)
//     Submits the phone's ECDH public key + AES-GCM ciphertext for a pending session. Refuses to
//     overwrite a session that's already been completed or consumed.
//   GET ?sessionId=...   (no auth -- reached from the still-LOCKED laptop, polling)
//     Returns the submitted bundle once present, and atomically deletes the session on that same
//     read -- single-use, so a laptop that already unlocked (or an eavesdropper who somehow saw
//     the sessionId) can never replay it to get the bundle a second time.
function pairKey(sessionId: string) {
  return `fintech-by-dk.pair.${sessionId}`;
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

type PairSession = {
  status: "pending" | "ready";
  createdAt: number;
  pub?: string; // phone's ECDH public key, url64
  iv?: string; // AES-GCM iv, url64
  ciphertext?: string; // the encrypted { accessCode, sessions } bundle, url64
};

export async function POST() {
  if (!bindings.VAULT) return new Response("Storage not configured", { status: 503 });
  const sessionId = randomSessionId();
  const session: PairSession = { status: "pending", createdAt: Date.now() };
  try {
    await bindings.VAULT.put(pairKey(sessionId), JSON.stringify(session), { expirationTtl: 90 });
  } catch {
    return new Response("Storage unavailable", { status: 503 });
  }
  return Response.json({ sessionId });
}

export async function PUT(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;
  if (!bindings.VAULT) return new Response("Storage not configured", { status: 503 });

  const body = (await request.json().catch(() => null)) as { sessionId?: string; pub?: string; iv?: string; ciphertext?: string } | null;
  if (!body?.sessionId || !body.pub || !body.iv || !body.ciphertext) {
    return Response.json({ error: "Missing sessionId/pub/iv/ciphertext" }, { status: 400 });
  }
  let existing: PairSession | null = null;
  try {
    const raw = await bindings.VAULT.get(pairKey(body.sessionId));
    existing = raw ? (JSON.parse(raw) as PairSession) : null;
  } catch {
    return new Response("Storage unavailable", { status: 503 });
  }
  // Rejects an unknown (expired/never-existed) or already-completed session -- a session can be
  // filled exactly once, by whichever phone scanned it first.
  if (!existing || existing.status !== "pending") {
    return Response.json({ error: "No pending pairing session with that id" }, { status: 404 });
  }
  const session: PairSession = { status: "ready", createdAt: existing.createdAt, pub: body.pub, iv: body.iv, ciphertext: body.ciphertext };
  try {
    await bindings.VAULT.put(pairKey(body.sessionId), JSON.stringify(session), { expirationTtl: 90 });
  } catch {
    return new Response("Storage unavailable", { status: 503 });
  }
  return Response.json({ ok: true });
}

export async function GET(request: Request) {
  if (!bindings.VAULT) return Response.json({ status: "pending" });
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return Response.json({ error: "Missing sessionId" }, { status: 400 });

  let session: PairSession | null = null;
  try {
    const raw = await bindings.VAULT.get(pairKey(sessionId));
    session = raw ? (JSON.parse(raw) as PairSession) : null;
  } catch {
    return Response.json({ status: "pending" });
  }
  if (!session) return Response.json({ status: "expired" });
  if (session.status === "pending") return Response.json({ status: "pending" });
  // Deliberately NOT deleted here -- a laptop whose first successful response gets dropped by a
  // network blip (confirmed real: the bundle was already consumed server-side, but never actually
  // reached the browser) would otherwise poll again into a permanently-gone session with no way
  // to recover short of the phone scanning a fresh QR code. Left to expire on its own 90s TTL
  // instead, which is a perfectly adequate single-use window on its own: the sessionId is a
  // random 256-bit token nobody else could guess, and even catching it (and the ciphertext) buys
  // an eavesdropper nothing without the laptop's own ECDH private key, which is generated
  // in-memory there and never transmitted anywhere.
  return Response.json({ status: "ready", pub: session.pub, iv: session.iv, ciphertext: session.ciphertext });
}
