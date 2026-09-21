"use client";
import { useEffect, useRef, useState } from "react";
import { getAccessToken, setAccessToken, clearAccessToken, apiFetch } from "@/lib/api-fetch";
import { hasBiometricSeal, enableBiometricSeal, biometricUnseal, removeBiometricSeal } from "@/lib/webauthn-seal";

const BIO_STORAGE_KEY = "dk-access-biometric-v1";

// Outermost gate for the whole app (wired into app/layout.tsx) -- separate from the vault
// password, which is never sent to the server at all (decryption happens entirely client-side,
// see VaultApp.tsx's decryptVault). Before this existed, every API route that touches real
// financial data (Plaid/Teller/Schwab, attachments, vault PUT, watchlist, categorize) had no
// server-side auth whatsoever: anyone who found the Worker's public URL could call them directly
// and get live, already-decrypted financial data with no password at all. This is a single,
// separate access code the server can actually check (see lib/api-auth.ts) -- entered once per
// browser session, held in sessionStorage like the vault password itself.
//
// Biometric unlock for this code reuses lib/webauthn-seal.ts (extracted from VaultApp.tsx's
// already-proven vault-password biometric flow) but, unlike that one, does NOT auto-fire on
// mount without a tap -- this gate blocks the entire app, so a WebAuthn ceremony that silently
// hangs here (a real failure mode VaultApp's own code documents seeing live on some devices)
// would be worse than in the vault-unlock flow, where a stuck auto-attempt still leaves other UI
// reachable. Requiring one tap keeps the convenience while keeping that failure mode harmless.
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "locked" | "unlocked">("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);
  const [biometricPending, setBiometricPending] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const biometricInFlight = useRef(false);

  useEffect(() => {
    setHasBiometric(hasBiometricSeal(BIO_STORAGE_KEY));
    const existing = getAccessToken();
    if (!existing) {
      setStatus("locked");
      return;
    }
    apiFetch("/api/auth/verify")
      .then((r) => setStatus(r.ok ? "unlocked" : "locked"))
      .catch(() => setStatus("locked"));
  }, []);

  async function verifyAndUnlock(code: string): Promise<boolean> {
    setAccessToken(code);
    const r = await apiFetch("/api/auth/verify");
    if (r.ok) {
      setStatus("unlocked");
      return true;
    }
    clearAccessToken();
    return false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setVerifying(true);
    setError("");
    try {
      const ok = await verifyAndUnlock(input.trim());
      if (!ok) setError("Incorrect access code.");
    } catch {
      setError("Couldn't verify — check your connection and try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function biometricUnlock() {
    if (biometricInFlight.current) return;
    biometricInFlight.current = true;
    setBiometricPending(true);
    setError("");
    try {
      const result = await biometricUnseal(BIO_STORAGE_KEY);
      if (!result.ok) {
        setError(`Biometric unlock failed (${result.error}). Use the access code instead.`);
        setShowPasswordFallback(true);
        return;
      }
      const ok = await verifyAndUnlock(result.secret);
      if (!ok) {
        setError("Saved biometric code is no longer valid. Use the access code instead.");
        setShowPasswordFallback(true);
      }
    } finally {
      biometricInFlight.current = false;
      setBiometricPending(false);
    }
  }

  async function enableBiometric() {
    const token = getAccessToken();
    if (!token) return;
    setBiometricPending(true);
    setError("");
    try {
      const result = await enableBiometricSeal(BIO_STORAGE_KEY, "FinTech by DK", token);
      if (result.ok) {
        setHasBiometric(true);
      } else {
        setError(`Couldn't enable biometric unlock (${result.error}).`);
      }
    } finally {
      setBiometricPending(false);
    }
  }

  if (status === "checking") return null;
  if (status === "unlocked") return <>{children}</>;

  return (
    <div className="unlock">
      <div className="vault-mark">DK</div>
      <h1>FinTech by DK</h1>
      {hasBiometric && !showPasswordFallback ? (
        <>
          <p>Use your device biometric to continue.</p>
          <button className="biometric-primary" onClick={biometricUnlock} disabled={biometricPending}>
            {biometricPending ? "Confirming..." : "Unlock with fingerprint, face, or Windows Hello"}
          </button>
          <button className="password-fallback" onClick={() => setShowPasswordFallback(true)}>
            Use access code instead
          </button>
        </>
      ) : (
        <>
          <p>Enter the access code to continue.</p>
          <form onSubmit={submit}>
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Access code"
              autoFocus
            />
            <button className="primary" disabled={verifying}>
              {verifying ? "Checking…" : "Continue"}
            </button>
          </form>
          {status === "locked" && input === "" && hasBiometric && (
            <button className="password-fallback" onClick={() => setShowPasswordFallback(false)}>
              Use biometric instead
            </button>
          )}
        </>
      )}
      {error && <small style={{ color: "#dc2626" }}>{error}</small>}
    </div>
  );
}

// Small opt-in control, rendered once the app is unlocked, so a user can enable biometric for the
// access code the same way VaultApp already lets them enable it for the vault password -- shown
// by the app itself (e.g. a settings/account area) rather than forced into this file's own gate
// UI, since it only makes sense to offer AFTER a real code has just been verified.
export function AccessGateBiometricToggle() {
  const [hasBiometric, setHasBiometric] = useState(() => hasBiometricSeal(BIO_STORAGE_KEY));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function enable() {
    const token = getAccessToken();
    if (!token) {
      setMessage("No active access-code session to enroll.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const result = await enableBiometricSeal(BIO_STORAGE_KEY, "FinTech by DK", token);
      if (result.ok) {
        setHasBiometric(true);
        setMessage("Biometric unlock enabled for the access code on this device.");
      } else {
        setMessage(`Couldn't enable biometric unlock (${result.error}).`);
      }
    } finally {
      setPending(false);
    }
  }

  function remove() {
    removeBiometricSeal(BIO_STORAGE_KEY);
    setHasBiometric(false);
    setMessage("Biometric unlock removed for the access code on this device.");
  }

  return (
    <>
      {hasBiometric ? (
        <button
          className="secure-action biometric-action biometric-action--on"
          aria-label="Remove access-code biometric"
          title="Remove access-code biometric unlock"
          onClick={remove}
        >
          <span className="secure-icon" aria-hidden="true" />
        </button>
      ) : (
        <button
          className="secure-action biometric-action biometric-action--off"
          aria-label="Enable access-code biometric"
          title="Enable biometric unlock for the access code"
          disabled={pending}
          onClick={enable}
        >
          <span className="secure-icon" aria-hidden="true" />
        </button>
      )}
      {message && <span className="vault-status vault-status-text">{message}</span>}
    </>
  );
}
