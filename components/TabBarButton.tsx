"use client";

// Shared markup for one button inside `.header-tab-bar` -- previously hand-copied ~6 times each
// in VaultApp.tsx and GrApp.tsx (icon span + label span + "selected" class toggling), the exact
// class of drift the GrApp/VaultApp de-dup plan flagged as a real cost: a tab-bar styling tweak
// had to be found and applied twice, once per file. Deliberately just the button's own markup,
// not a full data-driven TabBar wrapping the whole `<nav>` -- each app's tab list, click
// side-effects (e.g. VaultApp's Masters tab also resets mastersSection), and conditional
// book-based tabs differ enough that forcing them into one shared array would be a bigger, riskier
// rewrite for no real benefit; only the repeated per-button shape is worth sharing.
export function TabBarButton({
  icon,
  label,
  selected,
  onClick,
  title,
  className,
}: {
  icon: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      className={[selected ? "selected" : "", className].filter(Boolean).join(" ") || undefined}
      onClick={onClick}
      title={title ?? label}
    >
      <span className="header-tab-bar-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}
