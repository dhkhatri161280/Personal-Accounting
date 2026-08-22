"use client";

export type IconKind =
  | "cash" | "bank" | "trending-up" | "receipt" | "stock"
  | "shield" | "tag" | "wallet" | "scale" | "calendar";

const PATHS: Record<IconKind, React.ReactNode> = {
  cash: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="3" />
      <path d="M6 10v.01M18 14v.01" />
    </>
  ),
  bank: (
    <>
      <path d="M3 10l9-6 9 6" />
      <path d="M4 10v9M9 10v9M15 10v9M20 10v9" />
      <path d="M2 21h20" />
    </>
  ),
  "trending-up": (
    <>
      <polyline points="3 17 9 11 13 15 21 6" />
      <polyline points="14 6 21 6 21 13" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 2h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  stock: (
    <>
      <rect x="4" y="12" width="4" height="8" />
      <rect x="10" y="7" width="4" height="13" />
      <rect x="16" y="3" width="4" height="17" />
    </>
  ),
  shield: (
    <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
  ),
  tag: (
    <>
      <path d="M20 12l-8 8-9-9V4h7z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  wallet: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3" />
      <path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-4a2 2 0 0 0 0 4h4" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v18M7 21h10" />
      <path d="M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z" />
      <path d="M5 8h14M12 3l-3 5h6z" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </>
  ),
};

// Tinted rounded icon swatch, only meaningful under the .ui-refresh theme — harmless
// (just an extra small element) when the classic theme is active.
export function StatIcon({ kind, color = "#1e40af" }: { kind: IconKind; color?: string }) {
  return (
    <span className="stat-icon" style={{ background: `${color}1a`, color }}>
      <Icon kind={kind} />
    </span>
  );
}

export function Icon({ kind, size = 18 }: { kind: IconKind; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  );
}
