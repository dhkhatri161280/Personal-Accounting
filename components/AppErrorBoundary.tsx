"use client";
import React from "react";

type State = { error: Error | null };

// A deploy renames every JS chunk (content-hashed filenames), and Cloudflare Workers Assets only
// serves the CURRENT deploy's files -- it doesn't keep old-hash files around. A tab that was
// already open before a deploy still has the OLD filenames in memory, so navigating to a
// not-yet-loaded chunk (e.g. opening a report for the first time this session) 404s. This isn't a
// bug in the app itself, just a stale session -- a single reload always fixes it by picking up the
// current build's filenames. Auto-reload once instead of showing a dead error screen the user has
// to notice and click through; a sessionStorage guard stops an infinite reload loop if the real
// problem is something else (e.g. truly offline).
const STALE_CHUNK_PATTERNS = [/Failed to fetch dynamically imported module/i, /error loading dynamically imported module/i, /importing a module script failed/i];
const RELOAD_GUARD_KEY = "dk-stale-chunk-reload-at";
const RELOAD_GUARD_WINDOW_MS = 15_000;

function isStaleChunkError(error: Error): boolean {
  return STALE_CHUNK_PATTERNS.some((p) => p.test(error.message));
}

function reloadOnceForStaleChunk(): boolean {
  const lastAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
  if (Date.now() - lastAt < RELOAD_GUARD_WINDOW_MS) return false; // already tried recently -- avoid a loop
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isStaleChunkError(error)) reloadOnceForStaleChunk();
  }

  render() {
    if (this.state.error)
      return (
        <div style={{ padding: "3rem 2rem", textAlign: "center", fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#b91c1c", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#555", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#1d4ed8",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "0.6rem 1.4rem",
              cursor: "pointer",
              fontSize: "0.9rem",
            }}
          >
            Reload app
          </button>
        </div>
      );
    return this.props.children;
  }
}
