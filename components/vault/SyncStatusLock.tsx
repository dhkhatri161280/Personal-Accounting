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
  // A large backlog is the one thing that's reliably preceded every real sync mess so far --
  // the local engine's per-item safety net (link-by-fingerprint instead of duplicating) only
  // behaves correctly with one or two stragglers at a time; letting many items pile up before
  // syncing is what turns an ordinary retry into a real duplicate-posting incident. Flag it
  // distinctly (not just "pending") so it reads as "go sync in small batches now", not
  // "nothing urgent yet".
  const LARGE_BACKLOG_THRESHOLD = 6;
  const hasLargeBacklog = pendingCount >= LARGE_BACKLOG_THRESHOLD;
  const tone = fetchError
    ? "error"
    : health === null
      ? "pending"
      : health.status === "error" || issueCount > 0
        ? "error"
        : health.status === "success" && pendingCount === 0
          ? "success"
          : hasLargeBacklog
            ? "backlog"
            : "pending";
  const label = fetchError
    ? "Sync status unavailable"
    : tone === "error"
      ? `${issueCount || 1} sync issue${(issueCount || 1) === 1 ? "" : "s"}`
      : tone === "backlog"
        ? `${pendingCount} items pending — sync in small batches to avoid a stuck backlog`
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
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
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
