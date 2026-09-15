"use client";
import { useEffect, useState } from "react";

// Tracks whether the viewport is at or below a phone-ish width. Used to switch a table-shaped
// list to a stacked-card layout on small screens without touching anything above the breakpoint
// (laptop/tablet keep the table exactly as before).
export function useIsNarrowViewport(maxWidthPx = 640): boolean {
  // Starts false unconditionally (matching what the server renders, since it has no window) and
  // resolves the real value only after mount -- reading matchMedia during the initial client
  // render would diverge from the server-rendered HTML on a narrow viewport and trigger a
  // hydration mismatch.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${maxWidthPx}px)`);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [maxWidthPx]);
  return narrow;
}
