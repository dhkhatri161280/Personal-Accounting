"use client";

// Privacy Mode + Dark Mode header buttons -- identical JSX/SVGs, previously duplicated between
// VaultApp.tsx and GrApp.tsx. State/handlers live in hooks/useUiPrefs.ts.
export function HeaderToggles({
  privacyMode,
  onTogglePrivacy,
  darkMode,
  onToggleDarkMode,
}: {
  privacyMode: boolean;
  onTogglePrivacy: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`privacy-toggle-button ${privacyMode ? "on" : "off"}`}
        onClick={onTogglePrivacy}
        title={privacyMode ? "Show amounts" : "Hide amounts"}
        aria-label={privacyMode ? "Show amounts" : "Hide amounts"}
      >
        {privacyMode ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        )}
      </button>
      <button
        type="button"
        className={`dark-mode-toggle-button ${darkMode ? "on" : "off"}`}
        onClick={onToggleDarkMode}
        title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      >
        {darkMode ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        )}
      </button>
    </>
  );
}
