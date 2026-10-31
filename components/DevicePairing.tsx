"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { getAccessToken } from "@/lib/api-fetch";
import { readVaultSessions, type CombinedSecret } from "@/components/AccessGate";
import { startLaptopPairing, pollLaptopPairing, parseQrPayload, submitPairing, type PairedSecret } from "@/lib/device-pairing";

// Two halves of "sign in on someone else's laptop by scanning a QR code with your phone" --
// see lib/device-pairing.ts for the actual ECDH/AES-GCM crypto, this file is UI only.
//   QrSignInPanel   -- shown on the LOCKED screen (AccessGate.tsx), on the untrusted laptop.
//   PairDeviceModal -- opened from the Settings menu (VaultApp.tsx), on your own unlocked phone.
// Both QR generation and QR scanning happen entirely on-device (the `qrcode`/`jsqr` libraries do
// no network calls of their own) -- nothing about this ever reaches a third party, only your own
// Cloudflare Worker, and even it only ever sees ciphertext it can't decrypt.

// ── Laptop side: show the QR, poll for the phone's encrypted reply ─────────────────────────────

export function QrSignInPanel({ onPaired }: { onPaired: (secret: PairedSecret) => void }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [state, setState] = useState<"starting" | "waiting" | "expired" | "error">("starting");
  const [error, setError] = useState("");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    void begin();
    return () => {
      cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function begin() {
    setState("starting");
    setError("");
    const started = await startLaptopPairing();
    if (cancelled.current) return;
    if ("error" in started) {
      setState("error");
      setError(started.error);
      return;
    }
    const dataUrl = await QRCode.toDataURL(started.session.qrText, { width: 240, margin: 1 });
    if (cancelled.current) return;
    setQrDataUrl(dataUrl);
    setState("waiting");
    const deadline = Date.now() + 85000; // a little under the server's 90s session TTL
    const poll = async () => {
      if (cancelled.current) return;
      if (Date.now() > deadline) {
        setState("expired");
        return;
      }
      const result = await pollLaptopPairing(started.session.sessionId, started.keyPair);
      if (cancelled.current) return;
      if (result.status === "ready") {
        onPaired(result.secret);
        return;
      }
      if (result.status === "expired") {
        setState("expired");
        return;
      }
      if (result.status === "error") {
        setState("error");
        setError(result.error);
        return;
      }
      pollTimer.current = setTimeout(poll, 1500);
    };
    pollTimer.current = setTimeout(poll, 1500);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      {state === "starting" && <p>Starting…</p>}
      {state === "waiting" && qrDataUrl && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="Scan with your phone to sign in" width={200} height={200} />
          <p style={{ fontSize: 13, textAlign: "center", maxWidth: 260 }}>
            On your phone, open this app → Settings → "Pair a device" and scan this code.
            Expires in about a minute.
          </p>
        </>
      )}
      {state === "expired" && (
        <>
          <p>This code expired without being scanned.</p>
          <button type="button" className="primary" onClick={begin}>
            Get a new code
          </button>
        </>
      )}
      {state === "error" && (
        <>
          <small style={{ color: "#dc2626" }}>{error}</small>
          <button type="button" className="primary" onClick={begin}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

// ── Phone side: scan the laptop's QR, encrypt this device's own access code + vault session(s)
// to it, submit ──────────────────────────────────────────────────────────────────────────────

export function PairDeviceModal({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const submitting = useRef(false);
  const [state, setState] = useState<"starting" | "scanning" | "submitting" | "done" | "error">("starting");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setState("scanning");
        tick();
      } catch {
        setState("error");
        setError("Couldn't access the camera -- check camera permission for this site.");
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tick() {
    const video = videoRef.current, canvas = canvasRef.current;
    if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA && !submitting.current) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height);
        if (code?.data) {
          const qr = parseQrPayload(code.data);
          if (qr) {
            submitting.current = true;
            void handleScanned(qr.sid, code.data);
            return;
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  async function handleScanned(_sid: string, rawText: string) {
    setState("submitting");
    const qr = parseQrPayload(rawText);
    if (!qr) {
      setState("error");
      setError("That wasn't a valid pairing code.");
      return;
    }
    const accessCode = getAccessToken();
    if (!accessCode) {
      setState("error");
      setError("This device isn't signed in itself -- can't share a sign-in it doesn't have.");
      return;
    }
    const secret: CombinedSecret = { accessCode, sessions: readVaultSessions() };
    const result = await submitPairing(qr, secret);
    if (!result.ok) {
      setState("error");
      setError(result.error);
      submitting.current = false;
      return;
    }
    setState("done");
    setTimeout(onClose, 1800);
  }

  return (
    <div className="new-voucher-fab-backdrop" onClick={onClose}>
      <div
        style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: 360, width: "90vw", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>Pair a device</strong>
        <p style={{ fontSize: 13, textAlign: "center", margin: 0 }}>
          Point this at the QR code shown on the other device's sign-in screen.
        </p>
        <div style={{ position: "relative", width: 260, height: 260, background: "#000", borderRadius: 8, overflow: "hidden" }}>
          <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: state === "scanning" ? "block" : "none" }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          {state === "starting" && <p style={{ color: "#fff", textAlign: "center", paddingTop: 110 }}>Starting camera…</p>}
          {state === "submitting" && <p style={{ color: "#fff", textAlign: "center", paddingTop: 110 }}>Pairing…</p>}
          {state === "done" && <p style={{ color: "#fff", textAlign: "center", paddingTop: 110 }}>✓ Paired</p>}
        </div>
        {error && <small style={{ color: "#dc2626" }}>{error}</small>}
        <button type="button" className="password-fallback" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
