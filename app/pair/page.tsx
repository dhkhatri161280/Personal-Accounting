"use client";

// Landing page for the device-pairing QR link (see lib/device-pairing.ts's startLaptopPairing,
// which now encodes the QR as a real https://.../pair?sid=...&pub=... URL instead of raw JSON).
// Scanning that QR with the phone's own native camera app opens this page directly -- AccessGate
// (wrapping every route, including this one, via app/layout.tsx) already gates it: an
// already-signed-in phone sails straight through to the pairing logic below with no extra taps;
// a locked phone sees its own normal unlock screen first, then lands here once unlocked.
import { useEffect, useState } from "react";
import { getAccessToken } from "@/lib/api-fetch";
import { readVaultSessions, type CombinedSecret } from "@/components/AccessGate";
import { parseQrPayload, submitPairing } from "@/lib/device-pairing";

export default function PairPage() {
  const [state, setState] = useState<"pairing" | "done" | "error" | "missing">("pairing");
  const [error, setError] = useState("");

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    const qr = parseQrPayload(window.location.href);
    if (!qr) {
      setState("missing");
      return;
    }
    const accessCode = getAccessToken();
    if (!accessCode) {
      // Shouldn't normally happen -- AccessGate only renders this page once unlocked -- but
      // guards against a stale/cleared token slipping through between render and this check.
      setState("error");
      setError("This device isn't signed in itself -- can't share a sign-in it doesn't have.");
      return;
    }
    const secret: CombinedSecret = { accessCode, sessions: readVaultSessions() };
    const result = await submitPairing(qr, secret);
    if (!result.ok) {
      setState("error");
      setError(result.error);
      return;
    }
    setState("done");
  }

  return (
    <div className="unlock">
      <div className="vault-mark">DK</div>
      <h1>Sign in the other device</h1>
      {state === "pairing" && <p>Pairing…</p>}
      {state === "done" && <p>✓ Paired — the other device is now signed in. You can close this tab.</p>}
      {state === "missing" && <p>This link is missing its pairing code — ask for a fresh QR code and scan it again.</p>}
      {state === "error" && (
        <>
          <small style={{ color: "#dc2626" }}>{error}</small>
          <p style={{ fontSize: 13 }}>
            The code may have expired (codes last about a minute) — ask the other device for a fresh QR code.
          </p>
        </>
      )}
    </div>
  );
}
