"use client";
import { useEffect, useState } from "react";
import type { SyncHealth } from "@/lib/vault-types";

export function SyncStatusLock({ book, onClick }: { book: "us" | "india"; onClick: () => void }) {
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [triggerState, setTriggerState] = useState<"idle" | "sending" | "sent">("idle");

  useEffect(() => {
    let dead = false;
    async function load() {
      try {
        const r = await fetch(`/api/sync-status?book=${book}`, { cache: "no-store" });
        if (!r.ok) {
          if (!dead) setFetchError(true);
          return;
        }
        const h = (await r.json()) as SyncHealth;
        if (!dead) {
          setHealth(h);
          setFetchError(false);
        }
      } catch {
        if (!dead) setFetchError(true);
      }
    }
    load();
    const id = setInterval(load, 120000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [book]);

  async function handleSyncNow() {
    if (triggerState !== "idle") return;
    setTriggerState("sending");
    try {
      await fetch(`/api/sync-trigger?book=${book}`, { method: "POST", cache: "no-store" });
    } catch {
      // best effort
    }
    setTriggerState("sent");
    setTimeout(() => setTriggerState("idle"), 10000);
  }

  const conflicts = Number(health?.conflicts || 0),
    errors = Number(health?.errors || 0),
    tallyToApp = Number(health?.tallyToApp || 0),
    appToTally = Number(health?.appToTally || 0);
  const issueCount = conflicts + errors;
  const pendingCount = tallyToApp + appToTally;
  const tone = fetchError
    ? "error"
    : health === null
      ? "pending"
      : health.status === "error" || issueCount > 0
        ? "error"
        : health.status === "success" && pendingCount === 0
          ? "success"
          : "pending";
  const label = fetchError
    ? "Sync status unavailable"
    : tone === "error"
      ? `${issueCount || 1} sync issue${(issueCount || 1) === 1 ? "" : "s"}`
      : tone === "pending"
        ? health === null
          ? "Checking sync status…"
          : `${pendingCount || 1} item${(pendingCount || 1) === 1 ? "" : "s"} pending sync`
        : "Sync successful";

  const syncNowLabel =
    triggerState === "sending"
      ? "Requesting…"
      : triggerState === "sent"
        ? "Sync requested — ready in ~2 min"
        : "Sync Now";

  return (
    <>
      <button
        type="button"
        className={`sync-now-button ${triggerState}`}
        title={syncNowLabel}
        aria-label={syncNowLabel}
        onClick={handleSyncNow}
        disabled={triggerState !== "idle"}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
        <span>{triggerState === "sent" ? "Requested" : "Sync"}</span>
      </button>
      <button
        type="button"
        className={`sync-lock-button ${tone}`}
        title={`${label}. Lock vault`}
        aria-label={`${label}. Lock vault`}
        onClick={onClick}
      >
        <svg
          className="sync-lock-icon"
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="10" width="14" height="10" rx="2"></rect>
          <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
        </svg>
      </button>
    </>
  );
}
