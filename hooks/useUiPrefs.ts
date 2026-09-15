"use client";
import { useEffect, useState } from "react";

// Privacy Mode, Dark Mode, and nav-collapsed are global preferences shared across every book
// (US/India/GR) via the same localStorage keys -- was independently duplicated in VaultApp.tsx
// and GrApp.tsx, extracted here so a change only has to be made once.
export function useUiPrefs() {
  const [privacyMode, setPrivacyMode] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("dk-privacy") === "1"
  );
  const [darkMode, setDarkMode] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("dk-dark-mode") === "1"
  );
  const [navCollapsed, setNavCollapsed] = useState(
    () => typeof window === "undefined" || localStorage.getItem("dk-nav-collapsed") !== "0"
  );

  const togglePrivacy = () =>
    setPrivacyMode((p) => {
      const next = !p;
      localStorage.setItem("dk-privacy", next ? "1" : "0");
      return next;
    });

  const toggleDarkMode = () =>
    setDarkMode((d) => {
      const next = !d;
      localStorage.setItem("dk-dark-mode", next ? "1" : "0");
      return next;
    });

  const toggleNavCollapsed = () =>
    setNavCollapsed((c) => {
      const next = !c;
      localStorage.setItem("dk-nav-collapsed", next ? "1" : "0");
      return next;
    });

  // Toggled on <body>, not any component's own wrapper div, so the true page background (the
  // body CSS rule itself) can be overridden regardless of each app's wrapper structure. Runs on
  // mount too, so the localStorage-read initial state takes effect on first paint.
  useEffect(() => {
    document.body.classList.toggle("dark-mode", darkMode);
  }, [darkMode]);

  return {
    privacyMode,
    setPrivacyMode,
    togglePrivacy,
    darkMode,
    setDarkMode,
    toggleDarkMode,
    navCollapsed,
    setNavCollapsed,
    toggleNavCollapsed,
  };
}
