"use client";
import { useEffect, useState } from "react";
import type { GridApi } from "@mui/x-data-grid";

// Reads the DataGrid's own REAL, post-layout pixel width per column (GridColDef.computedWidth) --
// not a hand-reconstructed guess from each column's flex/minWidth. Confirmed live this matters:
// a plain CSS flexbox using the same flex-grow ratios as the columns array does NOT reproduce
// DataGrid's own internal column-width algorithm (off by ~175px on a "Debit Ledger" flex column
// in one case) -- MUI computes flexible-column widths with its own logic (iterative minWidth
// floor resolution, scrollbar/border accounting), not a one-shot CSS flexbox distribution. This
// is the one source of truth that's guaranteed to match, and it updates live if the user drags a
// column to resize, which a static guess never could.
export function useGridColumnWidths(
  apiRef: React.MutableRefObject<GridApi | null | undefined>,
  fields: string[]
): Record<string, number> {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const fieldsKey = fields.join(",");
  useEffect(() => {
    const api = apiRef.current;
    if (!api?.subscribeEvent) return;
    const readWidths = () => {
      const next: Record<string, number> = {};
      for (const f of fieldsKey.split(",")) {
        if (!f) continue;
        const col = api.getColumn?.(f);
        if (col) next[f] = col.computedWidth;
      }
      setWidths(next);
    };
    readWidths();
    const unsubWidth = api.subscribeEvent("columnWidthChange", readWidths);
    const unsubResize = api.subscribeEvent("resize", readWidths);
    return () => {
      unsubWidth();
      unsubResize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRef, fieldsKey]);
  return widths;
}
