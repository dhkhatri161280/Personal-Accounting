"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ClientErrorBoundary } from "@/components/ClientErrorBoundary";

function clearGenericBrowserState() {
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.toLowerCase().includes("fintech-by-dk-generic")) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.clear();
  } catch {}
}

export function GenericAppShell({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);

    if (url.searchParams.has("resetgeneric") || url.searchParams.has("clean")) {
      clearGenericBrowserState();
      url.search = "";
      url.searchParams.set("fresh", Date.now().toString());
      window.location.replace(url.toString());
      return;
    }

    setReady(true);
  }, []);

  if (!ready) {
    return null;
  }

  return <ClientErrorBoundary>{children}</ClientErrorBoundary>;
}
