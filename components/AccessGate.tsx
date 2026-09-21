"use client";
import { useEffect, useState } from "react";
import { getAccessToken, setAccessToken, clearAccessToken, apiFetch } from "@/lib/api-fetch";

// Outermost gate for the whole app (wired into app/layout.tsx) -- separate from the vault
// password, which is never sent to the server at all (decryption happens entirely client-side,
// see VaultApp.tsx's decryptVault). Before this existed, every API route that touches real
// financial data (Plaid/Teller/Schwab, attachments, vault PUT, watchlist, categorize) had no
// server-side auth whatsoever: anyone who found the Worker's public URL could call them directly
// and get live, already-decrypted financial data with no password at all. This is a single,
// separate access code the server can actually check (see lib/api-auth.ts) -- entered once per
// browser session, held in sessionStorage like the vault password itself.
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "locked" | "unlocked">("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const existing = getAccessToken();
    if (!existing) {
      setStatus("locked");
      return;
    }
    apiFetch("/api/auth/verify")
      .then((r) => setStatus(r.ok ? "unlocked" : "locked"))
      .catch(() => setStatus("locked"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setVerifying(true);
    setError("");
    setAccessToken(input.trim());
    try {
      const r = await apiFetch("/api/auth/verify");
      if (r.ok) {
        setStatus("unlocked");
      } else {
        clearAccessToken();
        setError("Incorrect access code.");
      }
    } catch {
      clearAccessToken();
      setError("Couldn't verify — check your connection and try again.");
    } finally {
      setVerifying(false);
    }
  }

  if (status === "checking") return null;
  if (status === "unlocked") return <>{children}</>;

  return (
    <div className="unlock">
      <div className="vault-mark">DK</div>
      <h1>FinTech by DK</h1>
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
      {error && <small style={{ color: "#dc2626" }}>{error}</small>}
    </div>
  );
}
