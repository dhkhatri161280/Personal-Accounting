"use client";
import { useLayoutEffect, useRef, useState } from "react";

// Shrinks its own font-size until the text fits its parent's available width without
// truncating. A single static font size can't guarantee that for a summary-card row packing
// many cards onto one line (Tax's up to 9): a size tuned to fit "$0.00" leaves a 7-figure AGI
// truncated, and a size tuned to fit the 7-figure case makes every ordinary smaller amount
// needlessly tiny.
//
// Computed with a single canvas measureText call, not an iterative "shrink font, re-measure
// DOM, repeat" loop -- that approach was tried first and was genuinely racy in this app:
// mutating the element's own font-size on every step changes its rendered height too (line-
// height scales with font-size), and re-measuring scrollWidth/clientWidth between steps some-
// times read stale layout values depending on exactly when the browser's next reflow landed,
// occasionally settling on a size that still overflowed. Canvas text measurement has no DOM
// layout dependency, so there's nothing to race.
function measureTextWidth(text: string, font: string): number {
  const canvas = (measureTextWidth as any)._canvas ?? ((measureTextWidth as any)._canvas = document.createElement("canvas"));
  const ctx: CanvasRenderingContext2D = canvas.getContext("2d");
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function AutoFitAmount({
  text,
  maxFontSize = 11,
  minFontSize = 7,
  className,
  style,
}: {
  text: string;
  maxFontSize?: number;
  minFontSize?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLElement>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const available = el.clientWidth;
      if (!available) return; // not laid out yet (e.g. inside a still-collapsed <details>)
      const cs = getComputedStyle(el);
      // Measure at the CSS-specified max size directly -- avoids a separate reference-size
      // measurement and its own rounding error.
      const font = `${cs.fontWeight} ${maxFontSize}px ${cs.fontFamily}`;
      const widthAtMax = measureTextWidth(text, font);
      // 0.96 margin: canvas measureText can slightly underestimate the DOM's own rendered
      // width (subpixel/hinting differences), so this leaves a small buffer rather than
      // computing the exact theoretical fit and risking a 1px overflow in practice.
      const needed = widthAtMax > 0 ? ((available * 0.96) / widthAtMax) * maxFontSize : maxFontSize;
      const size = Math.max(minFontSize, Math.min(maxFontSize, Math.floor(needed * 2) / 2));
      // !important is required, not a plain assignment -- a shared .ui-refresh
      // .equity-summary-card strong rule elsewhere sets font-size with !important for OTHER
      // reports (Equity), and any !important stylesheet rule beats a plain inline style
      // regardless of specificity. An inline !important is the one thing that still wins.
      el.style.setProperty("font-size", `${size}px`, "important");
      setFontSize(size);
    };
    fit();
    // Re-fit once the real web font finishes loading -- measuring against the canvas's default
    // font (or a fallback, pre-swap font) would under/over-estimate the real rendered width.
    if (typeof document !== "undefined" && "fonts" in document) {
      document.fonts.ready.then(fit).catch(() => {});
    }
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, maxFontSize, minFontSize]);

  return (
    <strong ref={ref} className={className} style={{ ...style, fontSize, display: "block", whiteSpace: "nowrap", overflow: "hidden" }}>
      {text}
    </strong>
  );
}
