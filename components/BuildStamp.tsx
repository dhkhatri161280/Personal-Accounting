"use client";
import { useEffect, useRef, useState } from "react";
import { CHANGELOG } from "@/lib/changelog";

// Small "which build is live" marker next to the header tagline, sourced from Cloudflare's own
// version_metadata (see app/api/build-info) rather than a manually-typed string -- the previous
// "ACCOUNTING RELEASE 5" tagline never got bumped again after the first few deploys and had
// drifted badly stale. Renders nothing until the fetch resolves, and stays silent on failure --
// this is a minor footer detail, not worth a loading state or error message of its own.
//
// Clicking it opens a short "what changed recently" popover (see lib/changelog.ts) -- answerable
// in-app instead of only via git log.
export function BuildStamp() {
  const [info, setInfo] = useState<{ id: string; timestamp: string } | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    fetch("/api/build-info", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        const j = json as { id?: string | null; timestamp?: string | null } | null;
        if (j?.id && j?.timestamp) setInfo({ id: j.id, timestamp: j.timestamp });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  if (!info) return null;
  const date = new Date(info.timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return (
    <span className="build-stamp-wrap" ref={ref}>
      <button
        type="button"
        className="build-stamp"
        title={`Build ${info.id}, deployed ${date} — click for recent changes`}
        onClick={() => setOpen((o) => !o)}
      >
        Build {info.id} · {date}
      </button>
      {open && (
        <div className="build-stamp-popover">
          <strong>Recent changes</strong>
          <ul>
            {CHANGELOG.slice(0, 8).map((c, i) => (
              <li key={i}>
                <span className="build-stamp-date">{c.date}</span> {c.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
