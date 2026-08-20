"use client";
import { useEffect, useState } from "react";
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export function PWARegister() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null),
    [showIOS, setShowIOS] = useState(false),
    [showAndroid, setShowAndroid] = useState(false),
    [platform, setPlatform] = useState<"unknown" | "android" | "apple" | "desktop">("unknown");
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } },
      ua = nav.userAgent || "",
      reportedPlatform = `${nav.platform || ""} ${nav.userAgentData?.platform || ""}`,
      apple =
        /iPad|iPhone|iPod/i.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1),
      windows = /Windows|Win32|Win64/i.test(`${ua} ${reportedPlatform}`),
      android =
        /Android/i.test(`${ua} ${reportedPlatform}`) ||
        (!windows &&
          !apple &&
          /Linux/i.test(`${ua} ${reportedPlatform}`) &&
          nav.maxTouchPoints > 0);
    setPlatform(apple ? "apple" : android ? "android" : "desktop");
    const ready = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", ready);
    return () => window.removeEventListener("beforeinstallprompt", ready);
  }, []);
  const installAndroid = async () => {
    if (prompt) {
      await prompt.prompt();
      await prompt.userChoice;
      setPrompt(null);
    } else setShowAndroid(true);
  };
  return (
    <div className="install-options">
      {(platform === "android" || platform === "desktop") && (
        <button
          className="install-app"
          aria-label="Install Android App"
          title="Install Android App"
          onClick={installAndroid}
        >
          <img src="/tally-icon-192.png" alt="" />
          <span>Android</span>
        </button>
      )}
      {(platform === "apple" || platform === "desktop") && (
        <button
          className="install-app install-ios"
          aria-label="Install iPhone or iPad App"
          title="Install iPhone or iPad App"
          onClick={() => setShowIOS(true)}
        >
          <img src="/tally-icon-192.png" alt="" />
          <span>iOS</span>
        </button>
      )}
      {showAndroid && (
        <div className="ios-install-overlay" onClick={() => setShowAndroid(false)}>
          <section className="ios-install-panel" onClick={(e) => e.stopPropagation()}>
            <button className="ios-close" onClick={() => setShowAndroid(false)}>
              Close
            </button>
            <img src="/tally-icon-192.png" alt="FinTech by DK" />
            <h2>Install FinTech by DK</h2>
            <p>Install this secure app from Chrome on your Android phone or tablet.</p>
            <ol>
              <li>
                Open the browser menu <strong>⋮</strong>.
              </li>
              <li>
                Select <strong>Install app</strong> or <strong>Add to Home screen</strong>.
              </li>
              <li>
                Confirm <strong>Install</strong>. The FinTech by DK icon will appear with your apps.
              </li>
            </ol>
            <small>If the app is already installed, open it from your device app screen.</small>
          </section>
        </div>
      )}
      {showIOS && (
        <div className="ios-install-overlay" onClick={() => setShowIOS(false)}>
          <section className="ios-install-panel" onClick={(e) => e.stopPropagation()}>
            <button className="ios-close" onClick={() => setShowIOS(false)}>
              Close
            </button>
            <img src="/tally-icon-192.png" alt="FinTech by DK" />
            <h2>Install FinTech by DK</h2>
            <p>
              Apple installs this secure web app directly from Safari; no App Store download is
              required.
            </p>
            <ol>
              <li>
                Open <a href="/ledger">this app link</a> in Safari on your iPhone or iPad.
              </li>
              <li>
                Tap the Safari <strong>Share</strong> button.
              </li>
              <li>
                Select <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong>Add</strong>. The same app icon will appear on your Home Screen.
              </li>
            </ol>
            <small>
              Your encrypted US and India Books use the same cloud vault and synchronization
              service.
            </small>
          </section>
        </div>
      )}
    </div>
  );
}
