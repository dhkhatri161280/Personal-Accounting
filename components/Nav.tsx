"use client";
import { PWARegister } from "@/components/PWARegister";

export function Nav({ book = "us" }: { book?: "us" | "india" | "gr" }) {
  const india = book === "india";
  const gr = book === "gr";
  const subtitle = gr ? "Consolidated GR Books" : india ? "Encrypted India Books" : "Encrypted US Books";
  return (
    <aside>
      <div className="brand" title="FinTech by DK">
        <b>DK</b>
        <span>
          FinTech by DK<small>{subtitle}</small>
        </span>
      </div>
      <nav aria-label="Books">
        <a aria-label="US Books" title="US Books" className={!india && !gr ? "on" : ""} href="/ledger" onClick={() => window.dispatchEvent(new CustomEvent("dk-nav-home"))}>
          <span className="nav-full">US Books</span>
          <span className="nav-short">US</span>
        </a>
        <a aria-label="India Books" title="India Books" className={india ? "on" : ""} href="/india" onClick={() => window.dispatchEvent(new CustomEvent("dk-nav-home"))}>
          <span className="nav-full">India Books</span>
          <span className="nav-short">IN</span>
        </a>
        <a aria-label="GR Consolidated" title="GR Consolidated" className={gr ? "on" : ""} href="/gr" onClick={() => window.dispatchEvent(new CustomEvent("dk-nav-home"))}>
          <span className="nav-full">GR Books</span>
          <span className="nav-short">GR</span>
        </a>
      </nav>
      <PWARegister />
      <div className="source">
        <em />
        <span>
          End-to-end encrypted<small>Only your browser can decrypt</small>
        </span>
      </div>
      <div className="user">
        <b>DK</b>
        <span>
          Private workspace<small>Cloud vault</small>
        </span>
      </div>
    </aside>
  );
}
