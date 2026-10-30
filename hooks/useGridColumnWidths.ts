"use client";
import { useEffect, useState } from "react";
import type { GridApi } from "@mui/x-data-grid";

// Reads the DataGrid's own REAL, post-layout pixel width per column -- not a hand-reconstructed
// guess from each column's flex/minWidth. Confirmed live this matters: a plain CSS flexbox using
// the same flex-grow ratios as the columns array does NOT reproduce DataGrid's own internal
// column-width algorithm (off by ~175px on a "Debit Ledger" flex column in one case).
//
// Two layers, in increasing order of trust:
//  1. `col.computedWidth` via the grid's own API, read on mount and on `columnWidthChange`/
//     `resize` events -- cheap, synchronous, but can run before the grid's own initial flex-width
//     layout pass has settled (computedWidth not finalized on columns that just mounted), and
//     neither of those two events is guaranteed to fire again afterward to correct it. A prior fix
//     added one extra read on the next animation frame, which still wasn't reliably late enough --
//     confirmed live, the Ledgers tab's Totals row was STILL misaligned after that.
//  2. A ResizeObserver on the column headers' own real DOM elements
//     (`[role="columnheader"][data-field="..."]`, MUI's own rendered markup) -- this is driven by
//     the browser's actual layout engine finishing its work, not a guess at which MUI event fires
//     when, so it's immune to that timing race entirely. It overwrites layer 1's numbers the
//     moment the real elements exist and are measurable, and keeps correcting them on any later
//     resize (a user dragging a column, the window resizing, etc.).
export function useGridColumnWidths(
  apiRef: React.MutableRefObject<GridApi | null | undefined>,
  fields: string[]
): Record<string, number> {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const fieldsKey = fields.join(",");
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.subscribeEvent) return;
    const fieldList = fieldsKey.split(",").filter(Boolean);

    // Layer 1: the grid's own API, immediate but not always settled yet (see header comment).
    const readApiWidths = () => {
      const next: Record<string, number> = {};
      for (const f of fieldList) {
        const col = api.getColumn?.(f);
        if (col) next[f] = col.computedWidth;
      }
      setWidths((prev) => ({ ...prev, ...next }));
    };
    readApiWidths();
    const unsubWidth = api.subscribeEvent("columnWidthChange", readApiWidths);
    const unsubResize = api.subscribeEvent("resize", readApiWidths);

    // Layer 2: real DOM measurement -- the actual source of truth. Header cells may not exist in
    // the DOM yet on this very first effect run, so a MutationObserver watches for them to appear
    // (e.g. after the grid's first real commit) before attaching the ResizeObserver that then
    // keeps their measured width current for the lifetime of this effect.
    const ro = new ResizeObserver((entries) => {
      const next: Record<string, number> = {};
      for (const entry of entries) {
        const field = (entry.target as HTMLElement).dataset.field;
        if (field) next[field] = entry.contentRect.width;
      }
      if (Object.keys(next).length) setWidths((prev) => ({ ...prev, ...next }));
    });
    const observed = new Set<string>();
    const attachObservable = () => {
      const root = api.rootElementRef?.current;
      if (!root) return false;
      for (const f of fieldList) {
        if (observed.has(f)) continue;
        const el = root.querySelector<HTMLElement>(`[role="columnheader"][data-field="${f}"]`);
        if (el) {
          ro.observe(el);
          observed.add(f);
        }
      }
      return observed.size === fieldList.length;
    };
    let mo: MutationObserver | null = null;
    if (!attachObservable()) {
      const root = api.rootElementRef?.current;
      if (root) {
        mo = new MutationObserver(() => {
          if (attachObservable()) mo?.disconnect();
        });
        mo.observe(root, { childList: true, subtree: true });
      }
    }

    return () => {
      unsubWidth();
      unsubResize();
      ro.disconnect();
      mo?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRef, fieldsKey]);
  return widths;
}
