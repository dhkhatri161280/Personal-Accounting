"use client";
import { useEffect, useRef, useState } from "react";
import { getAccessToken, setAccessToken, clearAccessToken, apiFetch } from "@/lib/api-fetch";
import { hasBiometricSeal, enableBiometricSeal, biometricUnseal, removeBiometricSeal } from "@/lib/webauthn-seal";

const BIO_STORAGE_KEY = "dk-access-biometric-v1";
// Persists a decline so the enable-prompt asks at most once per device, not every session --
// enrollment is opt-in, not something to keep re-surfacing.
const DECLINED_KEY = "dk-access-biometric-declined";

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
//
// Deliberately NO persistent header icon for this (an earlier version added one next to the
// vault's own biometric toggle -- two near-identical, unlabeled fingerprint icons side by side
// was confusing clutter, not a real settings surface). Enrollment is instead offered exactly
// once, right after a successful manual code entry, and never again if declined; removing it
// later lives on the biometric unlock screen itself, only shown when it's actually relevant.
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "locked" | "prompt-biometric" | "unlocked">("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);
  const [biometricPending, setBiometricPending] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [promptMessage, setPromptMessage] = useState("");
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

  function declinedBiometricPrompt(): boolean {
    try {
      return localStorage.getItem(DECLINED_KEY) === "1";
    } catch {
      return false;
    }
  }

  async function verifyAndUnlock(code: string, fromManualEntry: boolean): Promise<boolean> {
    setAccessToken(code);
    const r = await apiFetch("/api/auth/verify");
    if (!r.ok) {
      clearAccessToken();
      return false;
    }
    // Offer the one-time biometric enrollment prompt only right after a real manual entry (not
    // after a cached-session check or a biometric unlock itself), and only if this device hasn't
    // already enrolled or explicitly declined before.
    if (fromManualEntry && !hasBiometricSeal(BIO_STORAGE_KEY) && !declinedBiometricPrompt() && window.PublicKeyCredential) {
      setStatus("prompt-biometric");
    } else {
      setStatus("unlocked");
    }
    return true;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setVerifying(true);
    setError("");
    try {
      const ok = await verifyAndUnlock(input.trim(), true);
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
      const ok = await verifyAndUnlock(result.secret, false);
      if (!ok) {
        setError("Saved biometric code is no longer valid. Use the access code instead.");
        setShowPasswordFallback(true);
      }
    } finally {
      biometricInFlight.current = false;
      setBiometricPending(false);
    }
  }

  function removeThisDevice() {
    removeBiometricSeal(BIO_STORAGE_KEY);
    setHasBiometric(false);
    setShowPasswordFallback(true);
  }

  async function acceptBiometricPrompt() {
    const token = getAccessToken();
    if (!token) {
      setStatus("unlocked");
      return;
    }
    setBiometricPending(true);
    setPromptMessage("");
    try {
      const result = await enableBiometricSeal(BIO_STORAGE_KEY, "FinTech by DK", token);
      if (result.ok) {
        setHasBiometric(true);
        setPromptMessage("Enabled — you can unlock with biometric next time.");
      } else {
        setPromptMessage(`Couldn't enable (${result.error}). You can still continue.`);
      }
    } finally {
      setBiometricPending(false);
    }
  }

  function declineBiometricPrompt() {
    try {
      localStorage.setItem(DECLINED_KEY, "1");
    } catch {}
    setStatus("unlocked");
  }

  if (status === "checking") return null;
  if (status === "unlocked") return <>{children}</>;

  if (status === "prompt-biometric") {
    return (
      <div className="unlock">
        <div className="vault-mark">DK</div>
        <h1>Skip typing this next time?</h1>
        <p>Enable fingerprint, face, or Windows Hello unlock for the access code on this device.</p>
        {promptMessage ? (
          <>
            <small style={{ display: "block", marginBottom: 12 }}>{promptMessage}</small>
            <button className="primary" onClick={() => setStatus("unlocked")}>
              Continue
            </button>
          </>
        ) : (
          <>
            <button className="biometric-primary" onClick={acceptBiometricPrompt} disabled={biometricPending}>
              {biometricPending ? "Confirming..." : "Enable biometric unlock"}
            </button>
            <button className="password-fallback" onClick={declineBiometricPrompt}>
              Not now
            </button>
          </>
        )}
      </div>
    );
  }

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
          <button className="password-fallback" onClick={removeThisDevice}>
            Remove biometric from this device
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
