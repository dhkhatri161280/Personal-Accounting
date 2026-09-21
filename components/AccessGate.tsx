"use client";
import { useEffect, useRef, useState } from "react";
import { getAccessToken, setAccessToken, clearAccessToken, apiFetch } from "@/lib/api-fetch";
import { hasBiometricSeal, enableBiometricSeal, biometricUnseal, removeBiometricSeal } from "@/lib/webauthn-seal";

// Single combined WebAuthn credential sealing BOTH the access code and whatever vault
// password(s) are already unlocked this session -- one tap restores everything, instead of the
// access code and the vault password each needing their own separate biometric ceremony. Replaces
// an earlier access-code-only biometric (never actually enrolled in production, so no migration
// needed) that caused exactly that double-prompt problem.
const COMBINED_BIO_KEY = "dk-combined-biometric-v1";
// Persists a decline so the enrollment offer asks at most once per device.
const DECLINED_KEY = "dk-combined-biometric-declined";

// Same sessionStorage keys VaultApp.tsx's own unlock flow already reads/writes -- pre-populating
// these here means VaultApp's EXISTING "cached session -> auto-open" logic on mount does the rest
// with no changes needed there at all (see VaultApp.tsx's `const cached = sessionStorage.getItem
// (sessionKey) || sessionStorage.getItem(sharedSessionKey)` effect). Same for GrApp.tsx, which
// just reads these same keys directly with no unlock UI of its own.
const VAULT_SESSION_KEYS = {
  us: "personal-ledger-session-us",
  india: "personal-ledger-session-india",
  shared: "personal-ledger-shared-session",
  biometricFlag: "personal-ledger-biometric-session",
};

type CombinedSecret = {
  accessCode: string;
  sessions: { us?: string; india?: string; shared?: string };
};

function readVaultSessions(): { us?: string; india?: string; shared?: string } {
  return {
    us: sessionStorage.getItem(VAULT_SESSION_KEYS.us) || undefined,
    india: sessionStorage.getItem(VAULT_SESSION_KEYS.india) || undefined,
    shared: sessionStorage.getItem(VAULT_SESSION_KEYS.shared) || undefined,
  };
}
function hasAnyVaultSession(s: { us?: string; india?: string; shared?: string }): boolean {
  return !!(s.us || s.india || s.shared);
}
function applyVaultSessions(s: { us?: string; india?: string; shared?: string }) {
  if (s.us) sessionStorage.setItem(VAULT_SESSION_KEYS.us, s.us);
  if (s.india) sessionStorage.setItem(VAULT_SESSION_KEYS.india, s.india);
  if (s.shared) sessionStorage.setItem(VAULT_SESSION_KEYS.shared, s.shared);
  sessionStorage.setItem(VAULT_SESSION_KEYS.biometricFlag, "1");
}

// Outermost gate for the whole app (wired into app/layout.tsx) -- separate from the vault
// password, which is never sent to the server at all (decryption happens entirely client-side,
// see VaultApp.tsx's decryptVault). Before this existed, every API route that touches real
// financial data had no server-side auth whatsoever: anyone who found the Worker's public URL
// could call them directly with no password at all. This is a single, separate access code the
// server can actually check (see lib/api-auth.ts) -- entered once per browser session, held in
// sessionStorage like the vault password itself.
//
// Auto-fires the combined biometric ceremony on mount when one is enrolled (single-credential
// case), same precedent VaultApp.tsx's own vault-password biometric already established: an
// unattended WebAuthn ceremony CAN hang with no visible prompt on some devices, but biometricUnseal
// carries the same 45s abort-timer safety net that flow relies on, and the "Use access code
// instead" escape hatch stays reachable the whole time -- worth the risk for the one-tap
// convenience now that it's a single ceremony instead of two.
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "locked" | "unlocked">("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [hasBiometric, setHasBiometric] = useState(false);
  const [biometricPending, setBiometricPending] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const biometricInFlight = useRef(false);
  const autoFireAttempted = useRef(false);

  useEffect(() => {
    const configured = hasBiometricSeal(COMBINED_BIO_KEY);
    setHasBiometric(configured);
    const existing = getAccessToken();
    if (existing) {
      apiFetch("/api/auth/verify")
        .then((r) => setStatus(r.ok ? "unlocked" : "locked"))
        .catch(() => setStatus("locked"));
      return;
    }
    setStatus("locked");
    if (configured && !autoFireAttempted.current) {
      autoFireAttempted.current = true;
      void biometricUnlock();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function biometricUnlock() {
    if (biometricInFlight.current) return;
    biometricInFlight.current = true;
    setBiometricPending(true);
    setError("");
    try {
      const result = await biometricUnseal(COMBINED_BIO_KEY);
      if (!result.ok) {
        setError(`Biometric unlock failed (${result.error}). Use the access code instead.`);
        setShowPasswordFallback(true);
        return;
      }
      let parsed: CombinedSecret;
      try {
        parsed = JSON.parse(result.secret);
      } catch {
        setError("Saved biometric data is corrupted. Use the access code instead.");
        setShowPasswordFallback(true);
        return;
      }
      setAccessToken(parsed.accessCode);
      const r = await apiFetch("/api/auth/verify");
      if (!r.ok) {
        clearAccessToken();
        setError("Saved biometric code is no longer valid. Use the access code instead.");
        setShowPasswordFallback(true);
        return;
      }
      applyVaultSessions(parsed.sessions);
      setStatus("unlocked");
    } finally {
      biometricInFlight.current = false;
      setBiometricPending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setVerifying(true);
    setError("");
    try {
      setAccessToken(input.trim());
      const r = await apiFetch("/api/auth/verify");
      if (r.ok) {
        setStatus("unlocked");
      } else {
        clearAccessToken();
        setError("Incorrect access code.");
      }
    } catch {
      setError("Couldn't verify — check your connection and try again.");
    } finally {
      setVerifying(false);
    }
  }

  function removeThisDevice() {
    removeBiometricSeal(COMBINED_BIO_KEY);
    setHasBiometric(false);
    setShowPasswordFallback(true);
  }

  if (status === "checking") return null;
  if (status === "unlocked")
    return (
      <>
        {children}
        <CombinedBiometricPrompt />
      </>
    );

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

// Rendered as a sibling alongside the already-unlocked app (not blocking it) -- watches for a
// vault password to show up in sessionStorage (set by VaultApp's own unlock flow, entirely
// independently of this component) and offers to bundle it together with the access code into
// one combined biometric credential. Never shown again once enrolled or declined.
function CombinedBiometricPrompt() {
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (hasBiometricSeal(COMBINED_BIO_KEY)) return;
    let declined = false;
    try {
      declined = localStorage.getItem(DECLINED_KEY) === "1";
    } catch {}
    if (declined) return;
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;

    const check = () => {
      if (hasAnyVaultSession(readVaultSessions())) {
        setVisible(true);
        clearInterval(id);
      }
    };
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  async function enable() {
    const accessCode = getAccessToken();
    if (!accessCode) return;
    setPending(true);
    setMessage("");
    try {
      const payload: CombinedSecret = { accessCode, sessions: readVaultSessions() };
      const result = await enableBiometricSeal(COMBINED_BIO_KEY, "FinTech by DK", JSON.stringify(payload));
      if (result.ok) {
        setMessage("Enabled — one tap unlocks everything next time.");
        setTimeout(() => setVisible(false), 2500);
      } else {
        setMessage(`Couldn't enable (${result.error}).`);
      }
    } finally {
      setPending(false);
    }
  }

  function decline() {
    try {
      localStorage.setItem(DECLINED_KEY, "1");
    } catch {}
    setVisible(false);
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        background: "#fff",
        border: "1px solid #dce2eb",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: "calc(100vw - 24px)",
        fontSize: 13,
      }}
    >
      <span>{message || "Set up one-tap unlock (access code + vault password) for next time?"}</span>
      {!message && (
        <>
          <button type="button" className="tr-refresh-btn" disabled={pending} onClick={enable}>
            {pending ? "Confirming…" : "Enable"}
          </button>
          <button type="button" className="tr-refresh-btn" onClick={decline}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}
