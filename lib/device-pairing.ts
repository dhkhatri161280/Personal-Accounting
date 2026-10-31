"use client";
import { url64, fromUrl64 } from "@/lib/vault-crypto";
import { apiFetch } from "@/lib/api-fetch";
import type { CombinedSecret } from "@/components/AccessGate";

// "Sign in on this unfamiliar laptop by scanning a QR code with your already-unlocked phone" --
// an ECDH (P-256) key exchange between the two devices, so the actual access code and vault
// password(s) are end-to-end encrypted in transit and never visible to (or decryptable by) the
// server relaying them. See app/api/pair/route.ts for the zero-knowledge relay this talks to,
// and components/DevicePairing.tsx for the two UI halves (laptop: show QR + poll; phone: scan +
// encrypt + submit). Deliberately reuses AccessGate's own CombinedSecret shape (accessCode +
// vault sessions) so a successful pairing is indistinguishable, to the rest of the app, from the
// existing combined-biometric unlock -- same payload, same sessionStorage keys applied after.

const QR_VERSION = 1;

export type PairedSecret = CombinedSecret;

type QrPayload = { v: number; sid: string; pub: string; origin: string };

async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]) as Promise<CryptoKeyPair>;
}

async function exportRawPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return url64(raw);
}

async function importRawPublicKey(encoded: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromUrl64(encoded).buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function deriveSharedKey(privateKey: CryptoKey, peerPublicKey: CryptoKey, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: "ECDH", public: peerPublicKey }, privateKey, { name: "AES-GCM", length: 256 }, false, [usage]);
}

// ── Laptop side (unauthenticated -- this runs before the laptop has any access code at all) ───

export type LaptopPairingSession = {
  sessionId: string;
  qrText: string;
};

export async function startLaptopPairing(): Promise<{ session: LaptopPairingSession; keyPair: CryptoKeyPair } | { error: string }> {
  if (!window.isSecureContext || !crypto.subtle) return { error: "This device/browser doesn't support the secure crypto this needs." };
  const res = await fetch("/api/pair", { method: "POST" });
  if (!res.ok) return { error: "Couldn't start a pairing session -- check your connection." };
  const { sessionId } = (await res.json()) as { sessionId: string };
  const keyPair = await generateEcdhKeyPair();
  const pub = await exportRawPublicKey(keyPair.publicKey);
  const payload: QrPayload = { v: QR_VERSION, sid: sessionId, pub, origin: location.origin };
  return { session: { sessionId, qrText: JSON.stringify(payload) }, keyPair };
}

export type PollResult = { status: "pending" } | { status: "expired" } | { status: "ready"; secret: PairedSecret } | { status: "error"; error: string };

export async function pollLaptopPairing(sessionId: string, keyPair: CryptoKeyPair): Promise<PollResult> {
  let res: Response;
  try {
    res = await fetch(`/api/pair?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
  } catch {
    return { status: "pending" }; // transient network hiccup -- caller just polls again
  }
  if (!res.ok) return { status: "pending" };
  const body = (await res.json()) as { status: "pending" | "ready" | "expired"; pub?: string; iv?: string; ciphertext?: string };
  if (body.status !== "ready") return { status: body.status === "expired" ? "expired" : "pending" };
  if (!body.pub || !body.iv || !body.ciphertext) return { status: "error", error: "Malformed pairing response." };
  try {
    const peerPub = await importRawPublicKey(body.pub);
    const sharedKey = await deriveSharedKey(keyPair.privateKey, peerPub, "decrypt");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromUrl64(body.iv) }, sharedKey, fromUrl64(body.ciphertext).buffer as ArrayBuffer);
    const secret = JSON.parse(new TextDecoder().decode(plain)) as PairedSecret;
    if (typeof secret.accessCode !== "string" || !secret.sessions) return { status: "error", error: "Decrypted pairing data was malformed." };
    return { status: "ready", secret };
  } catch {
    return { status: "error", error: "Couldn't decrypt the pairing data -- the phone and this device may be out of sync." };
  }
}

// ── Phone side (authenticated -- this runs from the already-unlocked app) ──────────────────────

export function parseQrPayload(text: string): QrPayload | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.v === QR_VERSION && typeof parsed.sid === "string" && typeof parsed.pub === "string" && typeof parsed.origin === "string") {
      return parsed as QrPayload;
    }
  } catch {}
  return null;
}

export async function submitPairing(qr: QrPayload, secret: PairedSecret): Promise<{ ok: true } | { ok: false; error: string }> {
  if (qr.origin !== location.origin) return { ok: false, error: "That QR code is for a different site -- refusing to send your credentials there." };
  const laptopPub = await importRawPublicKey(qr.pub);
  const keyPair = await generateEcdhKeyPair();
  const sharedKey = await deriveSharedKey(keyPair.privateKey, laptopPub, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, new TextEncoder().encode(JSON.stringify(secret)));
  const pub = await exportRawPublicKey(keyPair.publicKey);
  const res = await apiFetch("/api/pair", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: qr.sid, pub, iv: url64(iv), ciphertext: url64(ciphertext) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error || "Couldn't pair -- that QR code may have expired. Ask for a fresh one." };
  }
  return { ok: true };
}
