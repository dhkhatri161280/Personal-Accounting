"use client";
import { url64, fromUrl64, aesKey } from "@/lib/vault-crypto";

// Generic WebAuthn-PRF "seal a secret behind this device's biometric" helper -- generalizes the
// pattern VaultApp.tsx already built and proved out for the vault password (enableBiometric/
// biometricUnlock there), parameterized by an arbitrary localStorage key and secret string so it
// can seal ANY short secret, not just the vault password. Deliberately a separate module rather
// than importing VaultApp's own implementation: that one is already live and well-tested wired
// into the vault-unlock flow specifically, and refactoring it to be generic risked regressing a
// working feature for no benefit -- this module exists so a SECOND, independent secret (the
// AccessGate access code) can get the same biometric convenience without touching it.
//
// Same on-device-only security property as the original: the PRF-derived AES key never leaves
// the platform authenticator, and only the AES-GCM sealed ciphertext (not the secret itself) is
// ever written to localStorage.

export type BiometricEntry = { credentialId: string; salt: string; iv: string; sealed: string };

function parseEntries(raw: string | null): BiometricEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (e): e is BiometricEntry =>
        !!e && typeof e.credentialId === "string" && typeof e.salt === "string" &&
        typeof e.iv === "string" && typeof e.sealed === "string"
    );
  } catch {
    return [];
  }
}

export function hasBiometricSeal(storageKey: string): boolean {
  try {
    return parseEntries(localStorage.getItem(storageKey)).length > 0;
  } catch {
    return false;
  }
}

export function removeBiometricSeal(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {}
}

export async function enableBiometricSeal(
  storageKey: string,
  rpName: string,
  secretPlain: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!window.PublicKeyCredential) return { ok: false, error: "WebAuthn is unavailable on this device" };
    const salt = crypto.getRandomValues(new Uint8Array(32)),
      challenge = crypto.getRandomValues(new Uint8Array(32)),
      userId = crypto.getRandomValues(new Uint8Array(32)),
      credential = (await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: rpName, id: location.hostname },
          user: { id: userId, name: storageKey, displayName: rpName },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },
            { alg: -257, type: "public-key" },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            userVerification: "required",
          },
          timeout: 60000,
          attestation: "none",
          extensions: { prf: { eval: { first: salt } } } as object,
        },
      })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, error: "Biometric setup was cancelled" };
    let secret = (
      credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
    )?.prf?.results?.first;
    if (!secret) {
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: credential.rawId, type: "public-key" }],
          userVerification: "required",
          timeout: 60000,
          extensions: { prf: { eval: { first: salt } } } as object,
        },
      })) as PublicKeyCredential | null;
      secret = (
        assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
      )?.prf?.results?.first;
    }
    if (!secret) return { ok: false, error: "This biometric provider does not support secure PRF unlock" };
    const key = await aesKey(secret),
      iv = crypto.getRandomValues(new Uint8Array(12)),
      sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secretPlain));
    const newEntry: BiometricEntry = {
      credentialId: url64(credential.rawId),
      salt: url64(salt),
      iv: url64(iv),
      sealed: url64(sealed),
    };
    const existing = parseEntries(localStorage.getItem(storageKey)).filter(
      (e) => e.credentialId !== newEntry.credentialId
    );
    localStorage.setItem(storageKey, JSON.stringify([...existing, newEntry]));
    return { ok: true };
  } catch (e) {
    const detail = e instanceof DOMException ? `${e.name}: ${e.message}` : e instanceof Error ? e.message : undefined;
    return { ok: false, error: detail || "Biometric setup failed" };
  }
}

export async function biometricUnseal(
  storageKey: string
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const entries = parseEntries(localStorage.getItem(storageKey));
  if (!entries.length) return { ok: false, error: "Biometric unlock is not configured on this device" };
  const abortController = new AbortController(),
    hangTimer = setTimeout(() => abortController.abort(), 45000);
  try {
    const assertion = (await navigator.credentials.get({
      signal: abortController.signal,
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: entries.map((e) => ({ id: fromUrl64(e.credentialId), type: "public-key" as const })),
        userVerification: "required",
        timeout: 60000,
        extensions: {
          prf:
            entries.length === 1
              ? { eval: { first: fromUrl64(entries[0].salt) } }
              : {
                  evalByCredential: Object.fromEntries(
                    entries.map((e) => [e.credentialId, { first: fromUrl64(e.salt) }])
                  ),
                },
        } as object,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return { ok: false, error: "Biometric unlock was cancelled" };
    const matched = entries.find((e) => e.credentialId === assertion.id);
    if (!matched) return { ok: false, error: "Biometric unlock is not configured on this device" };
    const secret = (
      assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
    )?.prf?.results?.first;
    if (!secret) return { ok: false, error: "Secure biometric key was not returned" };
    const key = await aesKey(secret),
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromUrl64(matched.iv) }, key, fromUrl64(matched.sealed));
    return { ok: true, secret: new TextDecoder().decode(plain) };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, error: "Biometric unlock timed out" };
    const detail = e instanceof DOMException ? `${e.name}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { ok: false, error: detail };
  } finally {
    clearTimeout(hangTimer);
  }
}
