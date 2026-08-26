"use client";
import { useEffect, useRef, useState } from "react";

type Corner = "nw" | "ne" | "sw" | "se";
const MIN_W = 360;
const MIN_H = 200;
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Centered, resizable popup -- replaces the three near-identical fixed-size `Modal` components
 * that used to be copy-pasted across TaxReport/EquityReport/IndiaTaxReport, and the right-edge
 * slide-in drawer (.drill-panel) used for ledger/voucher detail. Opens centered on the viewport
 * sized to its content (or `wide` for a larger default), and can be resized from any of the four
 * corners by dragging -- the opposite corner stays anchored, matching how resizable windows
 * behave on desktop, rather than growing symmetrically around a fixed center. */
export function FloatingWindow({
  title,
  onClose,
  children,
  wide,
  initialWidth,
  initialHeight,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  initialWidth?: number;
  initialHeight?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const dragRef = useRef<{ corner: Corner; startX: number; startY: number; rect: Rect } | null>(null);

  useEffect(() => {
    const vw = window.innerWidth,
      vh = window.innerHeight;
    const naturalWidth = panelRef.current?.offsetWidth ?? (wide ? 760 : 480);
    const naturalHeight = panelRef.current?.offsetHeight ?? 300;
    const width = Math.min(initialWidth ?? naturalWidth, vw - 24);
    const height = Math.min(initialHeight ?? naturalHeight, vh * 0.9);
    setRect({ top: Math.max(12, (vh - height) / 2), left: Math.max(12, (vw - width) / 2), width, height });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX,
        dy = e.clientY - d.startY;
      let { top, left, width, height } = d.rect;
      if (d.corner.includes("e")) width = Math.max(MIN_W, Math.min(d.rect.width + dx, window.innerWidth - left - 12));
      if (d.corner.includes("s")) height = Math.max(MIN_H, Math.min(d.rect.height + dy, window.innerHeight - top - 12));
      if (d.corner.includes("w")) {
        width = Math.max(MIN_W, d.rect.width - dx);
        left = d.rect.left + (d.rect.width - width);
      }
      if (d.corner.includes("n")) {
        height = Math.max(MIN_H, d.rect.height - dy);
        top = d.rect.top + (d.rect.height - height);
      }
      setRect({ top, left, width, height });
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startDrag(corner: Corner) {
    return (e: React.PointerEvent) => {
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { corner, startX: e.clientX, startY: e.clientY, rect };
    };
  }

  return (
    <div className="fw-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className={`fw-panel ${wide ? "fw-panel--wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
        style={rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : { visibility: "hidden" }}
      >
        <div className="fw-head">
          <strong>{title}</strong>
          <button className="fw-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="fw-body">{children}</div>
        {CORNERS.map((c) => (
          <div key={c} className={`fw-handle fw-handle-${c}`} onPointerDown={startDrag(c)} />
        ))}
      </div>
    </div>
  );
}
