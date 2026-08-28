"use client";

/** Cycled by index for consumers with a dynamic/unbounded set of category labels (expense
 * categories, asset categories, deduction types) where a bespoke color-per-category mapping
 * isn't practical. Reuses the same hue family as the .ui-refresh design tokens. */
export const DONUT_PALETTE = [
  "#1e40af", "#16a34a", "#d97706", "#dc2626", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
];

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/** Dependency-free donut chart -- plain SVG circles with strokeDasharray, same "hand-rolled
 * inline SVG" approach as the Net Worth trend line, no new chart library. Segments with a
 * value <= 0 are dropped (a 0% slice would just be an invisible sliver). Renders a legend with
 * per-segment amount + percentage alongside the ring, and an optional total in the donut hole. */
export function DonutChart({
  segments,
  size = 150,
  thickness = 22,
  centerLabel,
  centerValue,
  fmt,
  legend = true,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  fmt?: (n: number) => string;
  legend?: boolean;
}) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((s, seg) => s + seg.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  // A fixed font size overflows the donut hole for longer currency strings -- Indian Rupee
  // formatting (lakh/crore grouping + paise decimals, e.g. "₹56,37,12,591.47") runs noticeably
  // longer than a comparable USD figure, so this scales down for longer center values instead
  // of spilling text over the ring. Unchanged for short strings (still caps at 16px).
  const innerDiameter = size - thickness * 2;
  const centerFontSize = centerValue
    ? Math.min(16, Math.max(8, Math.floor((innerDiameter * 0.85) / (centerValue.length * 0.58))))
    : 16;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={thickness} />
          {total > 0 &&
            visible.map((seg) => {
              const frac = seg.value / total;
              const len = frac * circumference;
              const dashoffset = -cumulative;
              cumulative += len;
              return (
                <circle
                  key={seg.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${len} ${circumference - len}`}
                  strokeDashoffset={dashoffset}
                />
              );
            })}
        </g>
        {centerValue && (
          <text x={size / 2} y={size / 2 - (centerLabel ? 4 : -5)} textAnchor="middle" fontSize={centerFontSize} fontWeight={800} fill="#0f172a">
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontSize={9} fill="#64748b" style={{ textTransform: "uppercase", letterSpacing: "0.03em" }}>
            {centerLabel}
          </text>
        )}
      </svg>
      {legend && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 150 }}>
          {visible.length === 0 && <span style={{ fontSize: 12, color: "#94a3b8" }}>No data</span>}
          {visible.map((seg) => (
            <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
              <span style={{ flex: 1, color: "#334155" }}>{seg.label}</span>
              <strong>{fmt ? fmt(seg.value) : `${Math.round((seg.value / total) * 100)}%`}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
