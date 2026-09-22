"use client";
import { useEffect, useState } from "react";

// Small "which build is live" marker next to the header tagline, sourced from Cloudflare's own
// version_metadata (see app/api/build-info) rather than a manually-typed string -- the previous
// "ACCOUNTING RELEASE 5" tagline never got bumped again after the first few deploys and had
// drifted badly stale. Renders nothing until the fetch resolves, and stays silent on failure --
// this is a minor footer detail, not worth a loading state or error message of its own.
export function BuildStamp() {
  const [info, setInfo] = useState<{ id: string; timestamp: string } | null>(null);

  useEffect(() => {
    fetch("/api/build-info", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        const j = json as { id?: string | null; timestamp?: string | null } | null;
        if (j?.id && j?.timestamp) setInfo({ id: j.id, timestamp: j.timestamp });
      })
      .catch(() => {});
  }, []);

  if (!info) return null;
  const date = new Date(info.timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return (
    <span className="build-stamp" title={`Build ${info.id}, deployed ${date}`}>
      Build {info.id} · {date}
    </span>
  );
}
