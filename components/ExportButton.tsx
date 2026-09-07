"use client";
import { useState } from "react";

// Self-contains its own loading state, so each report using it doesn't need its own
// `exporting`/`setExporting` pair -- just pass an async (or sync) `onExport`.
export function ExportButton({ onExport, label = "⬇ Export to Excel" }: { onExport: () => void | Promise<void>; label?: string }) {
  const [exporting, setExporting] = useState(false);
  return (
    <button
      type="button"
      className="tr-refresh-btn"
      disabled={exporting}
      onClick={async () => {
        setExporting(true);
        try {
          await onExport();
        } finally {
          setExporting(false);
        }
      }}
    >
      {exporting ? "Exporting…" : label}
    </button>
  );
}
