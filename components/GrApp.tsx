"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { decryptVault } from "@/lib/vault-crypto";
import type { Ledger, Vault, EquityData } from "@/lib/vault-types";
import {
  consolidateLedger,
  neededRateMonths,
  prevMonthKey,
  type FxRates,
  type GrLedger,
  type GrTx,
  type GrAccount,
} from "@/lib/gr-consolidation";
import { BalanceSheetReport } from "@/components/reports/BalanceSheetReport";
import { GroupedReport } from "@/components/reports/GroupedReport";
import { CashFlowReport } from "@/components/reports/CashFlowReport";
import { EquityReport } from "@/components/reports/EquityReport";

type Phase = "init" | "loading" | "ready" | "error";
type Tab = "dashboard" | "daybook" | "ledgers" | "reports" | "fxrates";
type Report = "trial" | "income" | "balance" | "cashflow" | "cash" | "equity";
type DashKind = "cash" | "investments" | "fixedassets" | "capital" | "income" | "vouchers";

const fmtInr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n: number, currency: "INR" | "USD" = "INR") =>
  (currency === "INR" ? fmtInr : fmtUsd).format(Math.abs(n) < 0.005 ? 0 : n);
const tol = 0.005;
const fmtL = (n: number) => `₹${(Math.abs(n) / 1e5).toFixed(2)}L`;

// Curated short labels for GR dashboard chips — mirrors US/India compact() approach
const CHIP_LABELS: Record<string, string> = {
  // US cash & bank
  "amex credit card": "AMEX",
  "bank of america": "BofA",
  "citi credit card": "Citi",
  "charles schwab": "Schwab",
  "savings account": "Savings",
  // India cash & bank
  "axis bank": "Axis",
  "hdfc bank - hiral": "HDFC",
  "sbi - ppf account": "PPF",
  // US investments
  "401k investments": "401K",
  "espp deduction": "ESPP",
  "view at canyon investment": "Canyon",
  // India investments
  "lic": "LIC",
  "max": "Max",
  // Fixed assets
  "tesla model y": "Tesla",
  "nissan rogue": "Nissan",
  "maruti wagon": "Maruti",
  "home": "Home",
  "home mortgage": "Mortgage",
  // Capital
  "dignesh khatri": "DK US",
  "dignesh haria": "DK IN",
  "dignesh harial khatri": "DK IN",
  "dignesh harilal khatri": "DK IN",
  "reserves & surplus": "RE",
  // Income
  "salary income": "Salary",
  "nvidia": "Nvidia",
  "tax refund": "Tax Refund",
  "credit card reward": "CC Reward",
};
function chipLabel(name: string): string {
  const lower = name.toLowerCase().trim();
  const mapped = CHIP_LABELS[lower];
  if (mapped) return mapped;
  // Any "Dignesh…" that isn't the US account is the India capital account
  if (lower.startsWith("dignesh") && lower !== "dignesh khatri") return "DK IN";
  // Fallback: first word (or first 10 chars if one long word)
  const first = name.trim().split(/\s+/)[0];
  return first.length > 10 ? first.slice(0, 10) : first;
}

// FX rate localStorage cache — refreshed at most once per calendar month
const FX_LS_KEY = "dk-gr-fx-cache";
interface FxCache { rates: FxRates; cachedMonth: string }
function fxCacheLoad(): FxCache | null {
  try { return JSON.parse(localStorage.getItem(FX_LS_KEY) ?? "null") as FxCache | null; }
  catch { return null; }
}
function fxCacheSave(rates: FxRates) {
  const now = new Date();
  const cachedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  try { localStorage.setItem(FX_LS_KEY, JSON.stringify({ rates, cachedMonth })); } catch {}
}
function fxCacheIsValid(cache: FxCache): boolean {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return cache.cachedMonth === thisMonth;
}
function fxCacheClear() { try { localStorage.removeItem(FX_LS_KEY); } catch {} }

function debitNames(t: GrTx) {
  return t.entries.filter((e) => e.amountInr < 0).map((e) => e.accountName).join(" / ") || "-";
}
function creditNames(t: GrTx) {
  return t.entries.filter((e) => e.amountInr > 0).map((e) => e.accountName).join(" / ") || "-";
}
function formatDate(d: string) {
  return d.split("-").reverse().join("-");
}
function normKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function grNature(
  parent: string
): "Income" | "Expense" | "Bank" | "Cash" | "Capital" | "Liability" | "Asset" {
  const p = parent.toLowerCase();
  if (/bank accounts?$/i.test(p)) return "Bank";
  if (/cash.in.hand|petty cash/i.test(p)) return "Cash";
  if (/^(direct incomes?|indirect incomes?|sales accounts?)$/i.test(p)) return "Income";
  if (/^(direct expenses?|indirect expenses?|purchase accounts?)$/i.test(p)) return "Expense";
  if (/^(capital account|reserves? & surplus)$/i.test(p)) return "Capital";
  if (
    /liabilit|creditor|loan.*liab|duties.*tax|provision|bank od|secured loan|unsecured loan/i.test(
      p
    )
  )
    return "Liability";
  return "Asset";
}

export function GrApp() {
  const [phase, setPhase] = useState<Phase>("init");
  const [statusMsg, setStatusMsg] = useState("");
  const [gr, setGr] = useState<GrLedger | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [report, setReport] = useState<Report>("trial");
  const [year, setYear] = useState(() => {
    const now = new Date();
    return String(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  });
  const [customStart, setCustomStart] = useState(() => {
    const now = new Date();
    const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${fy}-04`;
  });
  const [customEnd, setCustomEnd] = useState(() => {
    const now = new Date();
    const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${fy}-06`;
  });
  const [query, setQuery] = useState("");
  const [editRates, setEditRates] = useState<Record<string, string>>({});
  const [savingRates, setSavingRates] = useState(false);
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [minAmount, setMinAmount] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState("");
  const [expandedGuid, setExpandedGuid] = useState<string | null>(null);
  const [dashboardDetail, setDashboardDetail] = useState<DashKind | null>(null);
  const [selectedLedgerName, setSelectedLedgerName] = useState<string | null>(null);
  const [overlayYear, setOverlayYear] = useState<string>(() => {
    const now = new Date();
    return String(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
  });
  const [privacyMode, setPrivacyMode] = useState(() => typeof window !== "undefined" && localStorage.getItem("dk-privacy") === "1");
  const [uiTheme, setUiTheme] = useState<"classic" | "refresh">(() =>
    typeof window !== "undefined" && localStorage.getItem("dk-ui-theme") === "refresh" ? "refresh" : "classic"
  );
  const loadedRef = useRef(false);
  const [nvdaPrice, setNvdaPrice] = useState<number | null>(null);
  const [nvdaPrevClose, setNvdaPrevClose] = useState<number | null>(null);
  const [equityData, setEquityData] = useState<EquityData | null>(null);

  const togglePrivacy = () =>
    setPrivacyMode((p) => {
      const next = !p;
      localStorage.setItem("dk-privacy", next ? "1" : "0");
      return next;
    });

  const toggleUiTheme = () =>
    setUiTheme((t) => {
      const next = t === "refresh" ? "classic" : "refresh";
      localStorage.setItem("dk-ui-theme", next);
      return next;
    });

  useEffect(() => {
    if (!equityData) return;
    fetch("/api/equity-price?ticker=NVDA")
      .then((r) => r.json())
      .then((d: unknown) => {
        const { price: p, previousClose: pc } = d as { price?: number | null; previousClose?: number | null };
        if (typeof p === "number") setNvdaPrice(p);
        if (typeof pc === "number") setNvdaPrevClose(pc);
      })
      .catch(() => {});
  }, [equityData]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const usPw =
      sessionStorage.getItem("personal-ledger-session-us") ||
      sessionStorage.getItem("personal-ledger-shared-session");
    const inPw =
      sessionStorage.getItem("personal-ledger-session-india") ||
      sessionStorage.getItem("personal-ledger-shared-session");
    if (!usPw || !inPw) {
      setPhase("error");
      setStatusMsg(
        "Both US and India books must be unlocked first. Open each book and return here."
      );
      return;
    }
    setPhase("loading");
    setStatusMsg("Decrypting both books...");
    void loadAll(usPw, inPw);
  }, []);

  async function loadAll(usPw: string, inPw: string) {
    try {
      const [usResp, inResp] = await Promise.all([
        fetch("/api/vault", { cache: "no-store" }),
        fetch("/api/vault?book=india", { cache: "no-store" }),
      ]);
      if (!usResp.ok || !inResp.ok) throw new Error("Vault fetch failed");
      const [usRaw, inRaw] = await Promise.all([usResp.text(), inResp.text()]);
      const [usVault, inVault] = [JSON.parse(usRaw) as Vault, JSON.parse(inRaw) as Vault];
      const [usData, inData] = await Promise.all([
        decryptVault(usVault, usPw),
        decryptVault(inVault, inPw),
      ]);

      // Use localStorage cache if it was populated this calendar month
      const lsCache = fxCacheLoad();
      let rates: FxRates = lsCache && fxCacheIsValid(lsCache) ? lsCache.rates : {};
      const usingCache = lsCache && fxCacheIsValid(lsCache);

      const needed = neededRateMonths(usData.transactions);
      const missing = needed.filter((m) => rates[m] == null);

      if (!usingCache || missing.length) {
        // Fetch full rate map from KV (once per month or when months are missing)
        if (!usingCache) {
          try {
            const fxResp = await fetch("/api/fx-rates");
            if (fxResp.ok) {
              const fx = (await fxResp.json()) as { rates?: FxRates };
              rates = fx.rates ?? {};
            }
          } catch {}
        }
        // Fetch any still-missing months from frankfurter.app via the worker
        const stillMissing = needed.filter((m) => rates[m] == null);
        if (stillMissing.length) {
          setStatusMsg(
            `Fetching ${stillMissing.length} month(s) of FX rates from frankfurter.app...`
          );
          try {
            const r = await fetch("/api/fx-rates", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ months: stillMissing }),
            });
            if (r.ok) {
              const data = (await r.json()) as { rates?: FxRates };
              rates = data.rates ?? rates;
            }
          } catch {}
        }
        fxCacheSave(rates);
      }

      const stillMissingFinal = needed.filter((m) => rates[m] == null);
      if (stillMissingFinal.length > 0) {
        setStatusMsg(
          `Warning: FX rates unavailable for ${stillMissingFinal.length} month(s) — consolidated USD amounts may be incorrect. Check your internet connection and reload.`
        );
      }

      const consolidated = consolidateLedger(usData, inData, rates);
      setGr(consolidated);
      if (usData.equity) setEquityData(usData.equity);
      setEditRates(
        Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, String(v)]))
      );
      setPhase("ready");
      setStatusMsg(
        consolidated.missingRateMonths.length
          ? `Note: ${consolidated.missingRateMonths.length} month(s) used fallback rate — open FX Rates tab to review.`
          : ""
      );
    } catch (err) {
      setPhase("error");
      setStatusMsg(
        "Failed to load: " +
          (err instanceof Error ? err.message : "Vault password may be incorrect.")
      );
    }
  }

  async function saveEditedRates() {
    if (!gr) return;
    const customRates: FxRates = {};
    for (const [k, v] of Object.entries(editRates)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) customRates[k] = n;
    }
    setSavingRates(true);
    setStatusMsg("Saving custom FX rates...");
    try {
      await fetch("/api/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: [], customRates }),
      });
      // Clear cache so loadAll re-fetches the updated rates from KV
      fxCacheClear();
    } catch {}
    const usPw =
      sessionStorage.getItem("personal-ledger-session-us") ||
      sessionStorage.getItem("personal-ledger-shared-session");
    const inPw =
      sessionStorage.getItem("personal-ledger-session-india") ||
      sessionStorage.getItem("personal-ledger-shared-session");
    if (usPw && inPw) await loadAll(usPw, inPw);
    setSavingRates(false);
  }

  async function refreshRates() {
    if (!gr) return;
    setSavingRates(true);
    fxCacheClear();
    setStatusMsg("Re-fetching all FX rates from frankfurter.app...");
    try {
      const needed = Object.keys(gr.fxRates).length
        ? Object.keys(gr.fxRates)
        : Array.from(
            new Set(
              gr.transactions
                .filter((t) => t.source === "US")
                .map((t) => prevMonthKey(t.date))
            )
          );
      const r = await fetch("/api/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: needed }),
      });
      if (r.ok) {
        const data = (await r.json()) as { rates?: FxRates };
        const rates = data.rates ?? gr.fxRates;
        fxCacheSave(rates);
        setEditRates(Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, String(v)])));
        setStatusMsg("FX rates refreshed from frankfurter.app.");
      }
    } catch {
      setStatusMsg("Failed to refresh FX rates.");
    }
    setSavingRates(false);
  }

  const periods = useMemo(() => {
    if (!gr) return { years: [] as string[], months: [] as string[] };
    const ys = new Set<string>();
    const ms = new Set<string>();
    for (const t of gr.transactions) {
      const y = Number(t.date.slice(0, 4)), m = Number(t.date.slice(5, 7));
      ys.add(String(m >= 4 ? y : y - 1));
      ms.add(t.date.slice(0, 7));
    }
    return { years: [...ys].sort().reverse(), months: [...ms].sort().reverse() };
  }, [gr]);

  const periodRange = useMemo(() => {
    const start =
      year === "all" ? "0000-00-00" :
      year === "custom" ? `${customStart}-01` :
      year.length === 7 ? `${year}-01` : `${year}-04-01`;
    const end =
      year === "all" ? "9999-99-99" :
      year === "custom" ? `${customEnd}-31` :
      year.length === 7 ? `${year}-31` : `${Number(year) + 1}-03-31`;
    return { start, end };
  }, [year, customStart, customEnd]);

  const periodLabel = useMemo(() => {
    if (year === "all") return "All periods";
    if (year === "custom") return `${customStart} to ${customEnd}`;
    if (year.length === 7)
      return new Date(`${year}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return `FY ${year} (Apr ${year} – Mar ${Number(year) + 1})`;
  }, [year, customStart, customEnd]);

  const filteredTxns = useMemo(() => {
    if (!gr) return [];
    const { start, end } = periodRange;
    return gr.transactions
      .filter((t) => t.date >= start && t.date <= end)
      .filter(
        (t) =>
          !query ||
          `${t.date} ${t.type} ${t.number} ${t.narration} ${t.entries.map((e) => e.accountName).join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase())
      )
      .slice(0, 1500);
  }, [gr, periodRange, query]);

  // Period-specific Dr/Cr per account (for reports)
  const periodCalc = useMemo(() => {
    const dr = new Map<string, number>();
    const cr = new Map<string, number>();
    if (!gr) return { dr, cr };
    const { start, end } = periodRange;
    for (const t of gr.transactions) {
      if (t.cancelled || t.date < start || t.date > end) continue;
      for (const e of t.entries) {
        const k = normKey(e.accountName);
        if (e.amountInr < 0) dr.set(k, (dr.get(k) || 0) + -e.amountInr);
        else cr.set(k, (cr.get(k) || 0) + e.amountInr);
      }
    }
    return { dr, cr };
  }, [gr, periodRange]);

  // Cumulative Dr/Cr from beginning of data UP TO period end (for TB closing balance)
  const cumulativeAtPeriodEnd = useMemo(() => {
    const dr = new Map<string, number>();
    const cr = new Map<string, number>();
    if (!gr) return { dr, cr };
    const { end } = periodRange;
    for (const t of gr.transactions) {
      if (t.cancelled || t.date > end) continue;
      for (const e of t.entries) {
        const k = normKey(e.accountName);
        if (e.amountInr < 0) dr.set(k, (dr.get(k) || 0) + -e.amountInr);
        else cr.set(k, (cr.get(k) || 0) + e.amountInr);
      }
    }
    return { dr, cr };
  }, [gr, periodRange]);

  const sortedAccounts = useMemo(() => {
    if (!gr) return [];
    return gr.accounts
      .filter(
        (a) =>
          Math.abs(a.closingInr) > tol ||
          a.debitInr > tol ||
          a.creditInr > tol ||
          Math.abs(a.openingInr) > tol
      )
      .filter(
        (a) =>
          !ledgerFilter ||
          `${a.name} ${a.parent}`.toLowerCase().includes(ledgerFilter.toLowerCase())
      )
      .filter(
        (a) =>
          !minAmount ||
          Math.max(Math.abs(a.openingInr), a.debitInr, a.creditInr, Math.abs(a.closingInr)) >=
            Number(minAmount)
      )
      .sort((a, b) => {
        const av =
          sortKey === "name" ? a.name.toLowerCase() :
          sortKey === "group" ? a.parent.toLowerCase() :
          Number(a[sortKey as keyof GrAccount] ?? 0);
        const bv =
          sortKey === "name" ? b.name.toLowerCase() :
          sortKey === "group" ? b.parent.toLowerCase() :
          Number(b[sortKey as keyof GrAccount] ?? 0);
        const r = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
        return sortDir === "asc" ? r : -r;
      });
  }, [gr, ledgerFilter, minAmount, sortKey, sortDir]);

  // Overlay-local period — syncs to global year whenever a new ledger is opened
  useEffect(() => { if (selectedLedgerName) setOverlayYear(year); }, [selectedLedgerName]); // eslint-disable-line react-hooks/exhaustive-deps

  const overlayRange = useMemo(() => {
    const y = overlayYear;
    const start = y === "all" ? "0000-00-00" : y.length === 7 ? `${y}-01` : `${y}-04-01`;
    const end   = y === "all" ? "9999-99-99" : y.length === 7 ? `${y}-31` : `${Number(y) + 1}-03-31`;
    return { start, end };
  }, [overlayYear]);

  const overlayLabel = useMemo(() => {
    if (overlayYear === "all") return "All periods";
    if (overlayYear.length === 7)
      return new Date(`${overlayYear}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return `FY ${overlayYear} (Apr ${overlayYear} – Mar ${Number(overlayYear) + 1})`;
  }, [overlayYear]);

  const overlayLedgerTxns = useMemo(() => {
    if (!gr || !selectedLedgerName) return [];
    return gr.transactions
      .filter((t) => t.date >= overlayRange.start && t.date <= overlayRange.end)
      .filter((t) => t.entries.some((e) => normKey(e.accountName) === normKey(selectedLedgerName)));
  }, [gr, selectedLedgerName, overlayRange]);

  const sortBy = (key: string) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };
  const SortTh = ({ field, children, right = false }: { field: string; children: React.ReactNode; right?: boolean }) => (
    <th className={`${right ? "right " : ""}sortable`}>
      <button onClick={() => sortBy(field)}>
        {children}
        <span className="sort-mark" data-direction={sortKey === field ? sortDir : "none"} aria-hidden="true" />
      </button>
    </th>
  );

  const PeriodBar = () => (
    <div className="period-bar">
      <strong>Financial period</strong>
      <select value={year} onChange={(e) => setYear(e.target.value)}>
        <option value="all">All periods</option>
        <option value="custom">Custom month range</option>
        <optgroup label="Fiscal years (April to March)">
          {periods.years.map((y) => (
            <option key={y} value={y}>FY {y} (Apr {y} – Mar {Number(y) + 1})</option>
          ))}
        </optgroup>
        <optgroup label="Month and year">
          {periods.months.map((m) => (
            <option key={m} value={m}>
              {new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </option>
          ))}
        </optgroup>
      </select>
      {year === "custom" && (
        <div className="custom-range">
          <label>From <input type="month" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} /></label>
          <span>to</span>
          <label>To <input type="month" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} /></label>
        </div>
      )}
      <span>Latest FX: {gr ? fmt(gr.latestRate) : "—"}/USD</span>
    </div>
  );

  // ── NOT READY SCREENS ──────────────────────────────────────────────────────

  if (phase === "init" || phase === "loading") {
    return (
      <div className="gr-loading">
        <div className="gr-spinner" />
        <p>{statusMsg || "Loading..."}</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="gr-error">
        <h2>GR Consolidated Books</h2>
        <p className="gr-error-msg">{statusMsg}</p>
        <div className="gr-error-links">
          <a href="/ledger">Open US Books</a>
          <a href="/india">Open India Books</a>
        </div>
        <p className="gr-error-note">
          After unlocking both books in the same session, return here to view the consolidated view.
        </p>
      </div>
    );
  }

  if (!gr) return null;

  // ── REPORT DATA ───────────────────────────────────────────────────────────

  const activeAccounts = gr.accounts.filter(
    (a) =>
      Math.abs(a.closingInr) > tol ||
      a.debitInr > tol ||
      a.creditInr > tol ||
      Math.abs(a.openingInr) > tol
  );

  const incomeAccounts = activeAccounts.filter((a) => grNature(a.parent) === "Income");
  const expenseAccounts = activeAccounts.filter((a) => grNature(a.parent) === "Expense");
  const bankCashAccounts = activeAccounts.filter((a) =>
    ["Bank", "Cash"].includes(grNature(a.parent))
  );

  // Convert GrAccount → BSRow shape for report components
  const toRow = (a: GrAccount, idx: number) => ({
    id: idx,
    name: a.name,
    parent: a.parent || "",
    closing: a.closingInr,
  });

  // Balance Sheet: classify all active non-P&L accounts — exclude zero closing (same as US/India)
  const bsAssets = activeAccounts
    .filter((a) => ["Asset", "Bank", "Cash"].includes(grNature(a.parent)) && Math.abs(a.closingInr) > tol)
    .map(toRow);
  const bsLiabs = activeAccounts
    .filter((a) => ["Liability", "Capital"].includes(grNature(a.parent)) && Math.abs(a.closingInr) > tol)
    .map(toRow);
  // capitalTransfer = all-time net of income/expense accounts (credit-positive convention)
  // positive = surplus (income > expense) → shows on Liability side of BS
  const capitalTransfer = activeAccounts
    .filter((a) => ["Income", "Expense"].includes(grNature(a.parent)))
    .reduce((s, a) => s + a.closingInr, 0);

  // I&E rows for GroupedReport — use period-specific activity
  const ieExpenseRows = expenseAccounts
    .map((a, i) => ({
      id: i,
      name: a.name,
      parent: a.parent || "Expenses",
      closing: -((periodCalc.dr.get(normKey(a.name)) || 0) - (periodCalc.cr.get(normKey(a.name)) || 0)),
    }))
    .filter((r) => Math.abs(r.closing) > tol);

  const ieIncomeRows = incomeAccounts
    .map((a, i) => ({
      id: i,
      name: a.name,
      parent: a.parent || "Income",
      closing: -((periodCalc.cr.get(normKey(a.name)) || 0) - (periodCalc.dr.get(normKey(a.name)) || 0)),
    }))
    .filter((r) => Math.abs(r.closing) > tol);

  // Period-specific I&E totals (for summary card)
  const periodIncome = incomeAccounts.reduce((s, a) => {
    const k = normKey(a.name);
    return s + ((periodCalc.cr.get(k) || 0) - (periodCalc.dr.get(k) || 0));
  }, 0);
  const periodExpense = expenseAccounts.reduce((s, a) => {
    const k = normKey(a.name);
    return s + ((periodCalc.dr.get(k) || 0) - (periodCalc.cr.get(k) || 0));
  }, 0);
  const periodSurplus = periodIncome - periodExpense;

  // Cash Flow computation from period-filtered transactions
  const bankCashNameSet = new Set(bankCashAccounts.map((a) => normKey(a.name)));
  const accountParentMap = new Map(gr.accounts.map((a) => [normKey(a.name), a.parent || "Other"]));

  const cfGroupMap = new Map<string, { inflow: number; outflow: number; inflowLedgers: Map<string, number>; outflowLedgers: Map<string, number> }>();

  for (const t of filteredTxns) {
    if (t.cancelled) continue;
    const cashEntries = t.entries.filter((e) => bankCashNameSet.has(normKey(e.accountName)));
    if (cashEntries.length === 0) continue;
    // Positive netCash = money received into bank (bank debit = amountInr < 0 in our sign convention)
    const netCash = cashEntries.reduce((s, e) => s - e.amountInr, 0);
    if (Math.abs(netCash) < tol) continue;
    const isInflow = netCash > 0;

    for (const e of t.entries) {
      if (bankCashNameSet.has(normKey(e.accountName))) continue;
      const parent = accountParentMap.get(normKey(e.accountName)) || "Other";
      if (!cfGroupMap.has(parent)) {
        cfGroupMap.set(parent, { inflow: 0, outflow: 0, inflowLedgers: new Map(), outflowLedgers: new Map() });
      }
      const g = cfGroupMap.get(parent)!;
      const amt = Math.abs(e.amountInr);
      if (isInflow) {
        g.inflow += amt;
        g.inflowLedgers.set(e.accountName, (g.inflowLedgers.get(e.accountName) || 0) + amt);
      } else {
        g.outflow += amt;
        g.outflowLedgers.set(e.accountName, (g.outflowLedgers.get(e.accountName) || 0) + amt);
      }
    }
  }

  const cashFlowGroups = [...cfGroupMap.entries()].map(([group, g]) => ({
    group,
    inflow: g.inflow,
    outflow: g.outflow,
    inflowLedgers: [...g.inflowLedgers.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    outflowLedgers: [...g.outflowLedgers.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => (b.inflow + b.outflow) - (a.inflow + a.outflow));

  const cashInflows = cashFlowGroups.reduce((s, g) => s + g.inflow, 0);
  const cashOutflows = cashFlowGroups.reduce((s, g) => s + g.outflow, 0);
  const cashNet = cashInflows - cashOutflows;
  // Opening: sum of bank/cash closing from period start (approximated as all-time minus period activity)
  const cashBank = bankCashAccounts.reduce((s, a) => s - a.closingInr, 0);
  const cashOpening = cashBank - cashNet;
  const cashFlowClosing = cashOpening + cashNet;

  const totalClosingInr = activeAccounts.reduce(
    (s, a) => s + (a.closingInr > 0 ? a.closingInr : 0), 0
  );
  const usClosingInrTotal = gr.accounts.reduce(
    (s, a) => s + (a.usClosingInr > 0 ? a.usClosingInr : 0), 0
  );
  const inClosingInrTotal = gr.accounts.reduce(
    (s, a) => s + (a.inClosingInr > 0 ? a.inClosingInr : 0), 0
  );

  // Dashboard card account groups
  const investmentAccounts = activeAccounts.filter((a) => /investment/i.test(a.parent));
  const fixedAssetAccounts = activeAccounts.filter((a) => /fixed assets?/i.test(a.parent));
  const capitalAccounts = activeAccounts.filter((a) => grNature(a.parent) === "Capital");
  // Assets are stored credit-positive so negate for display (same as BS Assets side)
  const dashInvestmentsTotal = investmentAccounts.reduce((s, a) => s - a.closingInr, 0);
  const dashFixedAssetsTotal = fixedAssetAccounts.reduce((s, a) => s - a.closingInr, 0);
  const dashCapitalTotal = capitalAccounts.reduce((s, a) => s + a.closingInr, 0);

  // Equity (NVDA) — USD then converted to INR via most recent available FX rate
  const cur = nvdaPrice ?? 0;
  const equityRsuMktValueUsd = (equityData?.grants ?? []).reduce((s, g) => {
    const actualVested = g.vests.filter(v => !v.pending);
    const pendingVests = g.vests.filter(v => v.pending);
    const vestedTotal = actualVested.reduce((vs, v) => vs + v.shares, 0);
    const pendingShares = pendingVests.reduce((vs, v) => vs + v.shares, 0);
    const unvested = Math.max(0, g.totalShares - vestedTotal - pendingShares);
    return s + actualVested.reduce((vs, v) => vs + v.sharesHeld * cur, 0) + (pendingShares + unvested) * cur;
  }, 0);
  const equityRsuVestedValueUsd = (equityData?.grants ?? []).reduce(
    (s, g) => s + g.vests.filter(v => !v.pending).reduce((vs, v) => vs + v.sharesHeld * cur, 0), 0
  );
  const equityScheduledSharesGr = (equityData?.grants ?? []).reduce(
    (s, g) => s + g.vests.filter(v => v.pending).reduce((vs, v) => vs + v.shares, 0), 0
  );
  const equityEsppMktValueUsd = (equityData?.esppPurchases ?? []).reduce(
    (s, e) => s + (e.sharesHeld || e.shares) * cur, 0
  );
  const equityTotalUsd = equityRsuMktValueUsd + equityEsppMktValueUsd;
  // Get the most recently available FX rate for INR conversion
  const latestFxRate = Object.entries(gr.fxRates ?? {})
    .sort(([a], [b]) => b.localeCompare(a))[0]?.[1] ?? 0;
  const equityTotalInr = equityTotalUsd * latestFxRate;
  const equityRsuInr = equityRsuVestedValueUsd * latestFxRate;
  const equityEsppInr = equityEsppMktValueUsd * latestFxRate;
  const equityScheduledInr = equityScheduledSharesGr * cur * latestFxRate;
  const equityDailyHeldGr = (equityData?.grants ?? []).reduce(
    (s, g) => s + g.vests.filter(v => !v.pending).reduce((vs, v) => vs + v.sharesHeld, 0), 0
  ) + (equityData?.esppPurchases ?? []).reduce((s, e) => s + (e.sharesHeld || e.shares), 0);
  const equityDailyGLInr = (cur > 0 && nvdaPrevClose !== null && latestFxRate > 0)
    ? equityDailyHeldGr * (cur - nvdaPrevClose) * latestFxRate
    : null;

  function pillClass(a: GrAccount) {
    if (a.sources.includes("US") && a.sources.includes("IN")) return "gr-dash-pill gr-dash-pill-both";
    if (a.sources.includes("US")) return "gr-dash-pill gr-dash-pill-us";
    return "gr-dash-pill gr-dash-pill-in";
  }

  // Modal voucher (drill-down)
  const modalTx = expandedGuid ? gr.transactions.find((t) => t.guid === expandedGuid) ?? null : null;

  // Ledger detail panel
  const selectedAccount = selectedLedgerName
    ? gr.accounts.find((a) => normKey(a.name) === normKey(selectedLedgerName)) ?? null
    : null;
  const ledgerTxns = selectedLedgerName
    ? filteredTxns.filter((t) =>
        t.entries.some((e) => normKey(e.accountName) === normKey(selectedLedgerName))
      )
    : [];


  const LedgerLink = ({ name }: { name: string }) => (
    <button className="ledger-link" onClick={() => setSelectedLedgerName(name)}>
      {name}
    </button>
  );

  // ── MAIN RENDER ───────────────────────────────────────────────────────────

  return (
    <div className={[privacyMode ? "privacy-mode" : "", uiTheme === "refresh" ? "ui-refresh" : ""].filter(Boolean).join(" ") || undefined}>
      <header>
        <div>
          <small>FINTECH BY DK - ACCOUNTING RELEASE 5</small>
          <div className="book-heading">
            <h1>Dignesh Khatri</h1>
            <span className="book-badge gr">US + IN CONSOLIDATED - INR</span>
          </div>
          <p>
            {gr.accounts.length} ledgers | {gr.transactions.length} vouchers (US + IN Consolidated)
            {gr.missingRateMonths.length > 0 && (
              <span className="gr-missing-rates-warn">
                {" "}· {gr.missingRateMonths.length} month(s) missing FX rate
              </span>
            )}
          </p>
        </div>
        <div className="header-actions">
          {statusMsg && <span className="vault-status">{statusMsg}</span>}
          <button
            type="button"
            className={`ui-theme-toggle-button ${uiTheme === "refresh" ? "on" : "off"}`}
            onClick={toggleUiTheme}
            title={uiTheme === "refresh" ? "Switch to classic look" : "Try the new look"}
            aria-label={uiTheme === "refresh" ? "Switch to classic look" : "Try the new look"}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          </button>
          <button
            type="button"
            className={`privacy-toggle-button ${privacyMode ? "on" : "off"}`}
            onClick={togglePrivacy}
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
        </div>
      </header>

      <div className="app-nav">
        <button className={tab === "dashboard" ? "selected" : ""} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button className={tab === "daybook" ? "selected" : ""} onClick={() => setTab("daybook")}>
          Day Book
        </button>
        <button className={tab === "ledgers" ? "selected" : ""} onClick={() => setTab("ledgers")}>
          Ledgers
        </button>
        <button className={tab === "reports" ? "selected" : ""} onClick={() => setTab("reports")}>
          Reports
        </button>
        <button className={tab === "fxrates" ? "selected" : ""} onClick={() => setTab("fxrates")}>
          FX Rates
        </button>
        <button
          className={`gr-edit-mode-btn ${editMode ? "selected" : ""}`}
          onClick={() => setEditMode((v) => !v)}
          title={editMode ? "Exit edit mode" : "Enter edit mode to override FX rates"}
        >
          {editMode ? "Edit: ON" : "Edit Mode"}
        </button>
      </div>

      <PeriodBar />

      {/* ── DASHBOARD ─────────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <section className="stats dashboard-stats">
          {/* Card 1: Cash and Bank */}
          <div className="dashboard-card-slot cash-slot">
            <button
              className="dashboard-balance-card cash-card"
              onClick={() => setDashboardDetail(dashboardDetail === "cash" ? null : "cash")}
            >
              <div className="dashboard-card-main">
                <span>Cash and Bank (INR)</span>
                <strong>{fmt(cashBank)}</strong>
                <small>All bank &amp; cash accounts</small>
              </div>
              <div className="dashboard-card-highlights">
                {bankCashAccounts
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .filter((a) => !["savings account", "charles schwab"].includes(a.name.toLowerCase().trim()))
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.name} className={pillClass(a)}>
                      <b title={privacyMode ? undefined : a.name}>{chipLabel(a.name)}</b>
                      <em>{fmtL(Math.abs(a.closingInr))}</em>
                    </span>
                  ))}
              </div>
            </button>
            {dashboardDetail === "cash" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div><strong>Cash &amp; Bank Accounts</strong><small>Tap card to close</small></div>
                </div>
                {bankCashAccounts
                  .filter((a) => Math.abs(a.closingInr) > tol)
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .map((a) => (
                    <button
                      key={a.name}
                      className={`dashboard-inline-row dashboard-inline-button ${a.sources.includes("US") && !a.sources.includes("IN") ? "gr-row-us" : "gr-row-in"}`}
                      onClick={() => setSelectedLedgerName(a.name)}
                    >
                      <span>{a.name}<small>{a.parent}</small></span>
                      <b>{fmt(Math.abs(a.closingInr))}</b>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Card 2: Investments */}
          <div className="dashboard-card-slot investment-slot">
            <button
              className="dashboard-balance-card investment-card"
              onClick={() => setDashboardDetail(dashboardDetail === "investments" ? null : "investments")}
            >
              <div className="dashboard-card-main">
                <span>Investments (INR)</span>
                <strong>{fmt(dashInvestmentsTotal)}</strong>
                <small>Investment ledgers</small>
              </div>
              <div className="dashboard-card-highlights">
                {investmentAccounts
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.name} className={pillClass(a)}>
                      <b title={privacyMode ? undefined : a.name}>{chipLabel(a.name)}</b>
                      <em>{fmtL(-a.closingInr)}</em>
                    </span>
                  ))}
                {investmentAccounts.length === 0 && <span className="gr-dash-pill gr-dash-pill-in"><b>—</b><em>None</em></span>}
              </div>
            </button>
            {dashboardDetail === "investments" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div><strong>Investment Accounts</strong><small>Tap card to close</small></div>
                </div>
                {investmentAccounts.length === 0 && <div className="gr-drill-nodata">No investment accounts found</div>}
                {investmentAccounts
                  .filter((a) => -a.closingInr > tol)
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .map((a) => (
                    <button
                      key={a.name}
                      className={`dashboard-inline-row dashboard-inline-button ${a.sources.includes("US") && !a.sources.includes("IN") ? "gr-row-us" : "gr-row-in"}`}
                      onClick={() => setSelectedLedgerName(a.name)}
                    >
                      <span>{a.name}<small>{a.parent}</small></span>
                      <b>{fmt(-a.closingInr)}</b>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Card 3: Fixed Assets */}
          <div className="dashboard-card-slot active-slot">
            <button
              className="dashboard-balance-card fixed-assets-card"
              onClick={() => setDashboardDetail(dashboardDetail === "fixedassets" ? null : "fixedassets")}
            >
              <div className="dashboard-card-main">
                <span>Fixed Assets (INR)</span>
                <strong>{fmt(dashFixedAssetsTotal)}</strong>
                <small>Fixed asset ledgers</small>
              </div>
              <div className="dashboard-card-highlights">
                {fixedAssetAccounts
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .filter((a) => a.name.toLowerCase().trim() !== "home mortgage")
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.name} className={pillClass(a)}>
                      <b title={privacyMode ? undefined : a.name}>{chipLabel(a.name)}</b>
                      <em>{fmtL(-a.closingInr)}</em>
                    </span>
                  ))}
                {fixedAssetAccounts.length === 0 && <span className="gr-dash-pill gr-dash-pill-in"><b>—</b><em>None</em></span>}
              </div>
            </button>
            {dashboardDetail === "fixedassets" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div><strong>Fixed Asset Accounts</strong><small>Tap card to close</small></div>
                </div>
                {fixedAssetAccounts.length === 0 && <div className="gr-drill-nodata">No fixed asset accounts found</div>}
                {fixedAssetAccounts
                  .filter((a) => -a.closingInr > tol)
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .map((a) => (
                    <button
                      key={a.name}
                      className={`dashboard-inline-row dashboard-inline-button ${a.sources.includes("US") && !a.sources.includes("IN") ? "gr-row-us" : "gr-row-in"}`}
                      onClick={() => setSelectedLedgerName(a.name)}
                    >
                      <span>{a.name}<small>{a.parent}</small></span>
                      <b>{fmt(-a.closingInr)}</b>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Card 4: Capital */}
          <div className="dashboard-card-slot capital-slot">
            <button
              className="dashboard-balance-card capital-card"
              onClick={() => setDashboardDetail(dashboardDetail === "capital" ? null : "capital")}
            >
              <div className="dashboard-card-main">
                <span>Capital (INR)</span>
                <strong>{fmt(dashCapitalTotal)}</strong>
                <small>Capital &amp; reserves</small>
              </div>
              <div className="dashboard-card-highlights capital-highlights">
                {capitalAccounts
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.name} className={pillClass(a)}>
                      <b title={privacyMode ? undefined : a.name}>{chipLabel(a.name)}</b>
                      <em>{fmtL(Math.abs(a.closingInr))}</em>
                    </span>
                  ))}
                {capitalAccounts.length === 0 && <span className="gr-dash-pill gr-dash-pill-in"><b>—</b><em>None</em></span>}
              </div>
            </button>
            {dashboardDetail === "capital" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div><strong>Capital Accounts</strong><small>Tap card to close</small></div>
                </div>
                {capitalAccounts.length === 0 && <div className="gr-drill-nodata">No capital accounts found</div>}
                {capitalAccounts
                  .filter((a) => Math.abs(a.closingInr) > tol)
                  .slice()
                  .sort((a, b) => Math.abs(b.closingInr) - Math.abs(a.closingInr))
                  .map((a) => (
                    <button
                      key={a.name}
                      className={`dashboard-inline-row dashboard-inline-button ${a.sources.includes("US") && !a.sources.includes("IN") ? "gr-row-us" : "gr-row-in"}`}
                      onClick={() => setSelectedLedgerName(a.name)}
                    >
                      <span>{a.name}<small>{a.parent}</small></span>
                      <b>{fmt(Math.abs(a.closingInr))}</b>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Card 5: Period Income */}
          <div className="dashboard-card-slot salary-slot">
            <button
              className="dashboard-balance-card salary-card"
              onClick={() => setDashboardDetail(dashboardDetail === "income" ? null : "income")}
            >
              <div className="dashboard-card-main">
                <span>Period Income (INR)</span>
                <strong>{fmt(periodIncome)}</strong>
                <small>{periodLabel}</small>
              </div>
              <div className="dashboard-card-highlights salary-highlights">
                {incomeAccounts
                  .filter((a) => (periodCalc.cr.get(normKey(a.name)) || 0) > tol)
                  .slice()
                  .sort((a, b) => {
                    const av = (periodCalc.cr.get(normKey(a.name)) || 0) - (periodCalc.dr.get(normKey(a.name)) || 0);
                    const bv = (periodCalc.cr.get(normKey(b.name)) || 0) - (periodCalc.dr.get(normKey(b.name)) || 0);
                    return bv - av;
                  })
                  .slice(0, 3)
                  .map((a) => {
                    const v = (periodCalc.cr.get(normKey(a.name)) || 0) - (periodCalc.dr.get(normKey(a.name)) || 0);
                    return (
                      <span key={a.name} className={pillClass(a)}>
                        <b title={privacyMode ? undefined : a.name}>{chipLabel(a.name)}</b>
                        <em>{fmtL(v)}</em>
                      </span>
                    );
                  })}
                {incomeAccounts.filter((a) => (periodCalc.cr.get(normKey(a.name)) || 0) > tol).length === 0 && (
                  <span className="gr-dash-pill gr-dash-pill-in"><b>—</b><em>No activity</em></span>
                )}
              </div>
            </button>
            {dashboardDetail === "income" && (
              <div className="dashboard-inline-detail">
                <div className="dashboard-inline-heading">
                  <div><strong>Period Income</strong><small>{periodLabel} · Tap card to close</small></div>
                </div>
                {ieIncomeRows.length === 0 && <div className="gr-drill-nodata">No income activity this period</div>}
                {ieIncomeRows
                  .slice()
                  .sort((a, b) => b.closing - a.closing)
                  .map((a) => (
                    <button
                      key={a.name}
                      className="dashboard-inline-row dashboard-inline-button"
                      onClick={() => setSelectedLedgerName(a.name)}
                    >
                      <span>{a.name}<small>{a.parent}</small></span>
                      <b>{fmt(a.closing)}</b>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Card 6: Equity (NVDA) in INR */}
          <div className="dashboard-card-slot period-slot">
            <button
              className="dashboard-balance-card"
              onClick={() => { setTab("reports"); setReport("equity"); }}
            >
              <div className="dashboard-card-main">
                <span>Equity (NVDA)</span>
                <strong>{equityData ? fmt(equityTotalInr) : "—"}</strong>
                <small className="equity-price-note">
                  {nvdaPrice && latestFxRate
                    ? `$${nvdaPrice.toFixed(2)} × ₹${latestFxRate.toFixed(2)} = ₹${(nvdaPrice * latestFxRate).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : equityData ? "loading price…" : "No equity data"}
                </small>
              </div>
              <div className="dashboard-card-highlights">
                <span className="gr-dash-pill gr-dash-pill-us">
                  <b>RSU</b>
                  <em>{equityData ? fmtL(equityRsuInr) : "—"}</em>
                </span>
                <span className="gr-dash-pill gr-dash-pill-us">
                  <b>ESPP</b>
                  <em>{equityData ? fmtL(equityEsppInr) : "—"}</em>
                </span>
                {equityDailyGLInr !== null && (
                  <span className={`gr-dash-pill ${equityDailyGLInr >= 0 ? "equity-daily-chip--pos" : "equity-daily-chip--neg"}`}>
                    <b>Today</b>
                    <em>{equityDailyGLInr >= 0 ? "+" : "-"}{fmtL(equityDailyGLInr)}</em>
                  </span>
                )}
                {equityScheduledSharesGr > 0 && (
                  <span className="gr-dash-pill equity-sch-chip">
                    <b>Scheduled</b>
                    <em>{fmtL(equityScheduledInr)}</em>
                  </span>
                )}
              </div>
            </button>
          </div>
        </section>
      )}

      {/* ── DAY BOOK ──────────────────────────────────────────────────────── */}
      {tab === "daybook" && (
        <div className="data-panel">
          <div className="excel-toolbar">
            <input
              className="search-box"
              placeholder="Search vouchers..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <strong>{filteredTxns.length} vouchers</strong>
            <button onClick={() => setQuery("")}>Clear</button>
            {expandedGuid && (
              <button onClick={() => setExpandedGuid(null)}>Collapse all</button>
            )}
          </div>
          <p className="gr-drill-hint">Click any row to view full voucher details.</p>
          <div className="table-scroll">
            <table className="transaction-table gr-daybook-table">
              <colgroup>
                <col className="col-date" />
                <col className="col-src" />
                <col className="col-type" />
                <col className="col-num" />
                <col className="col-dr" />
                <col className="col-cr" />
                <col className="col-narr" />
                <col className="col-amt" />
              </colgroup>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Src</th>
                  <th>Type</th>
                  <th>#</th>
                  <th>Dr Ledger</th>
                  <th>Cr Ledger</th>
                  <th>Narration</th>
                  <th className="right">Amount (INR)</th>
                </tr>
              </thead>
              <tbody>
                {filteredTxns.map((t) => {
                  const srcCls = t.source === "US" ? "gr-row-us" : "gr-row-in";
                  return (
                    <tr
                      key={t.guid}
                      className={`gr-daybook-row ${srcCls}${t.cancelled ? " cancelled-row" : ""}`}
                      onClick={() => setExpandedGuid(t.guid)}
                      title="Click to view voucher entries"
                    >
                      <td className="date-cell">{formatDate(t.date)}</td>
                      <td>
                        <span className={`source-badge source-${t.source.toLowerCase()}`}>
                          {t.source}
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${t.cancelled ? "cancelled" : ""}`}>
                          {t.type}
                        </span>
                      </td>
                      <td className="gr-num-cell">{t.number || "-"}</td>
                      <td className="gr-ledger-cell">{debitNames(t)}</td>
                      <td className="gr-ledger-cell">{creditNames(t)}</td>
                      <td className="gr-narr-cell">{t.narration || "-"}</td>
                      <td className="right gr-amt-cell">
                        <strong>{fmt(t.amountInr)}</strong>
                        {t.source === "US" && t.amountUsd > 0 && (
                          <small className="gr-usd-hint">
                            {fmt(t.amountUsd, "USD")} @ {t.appliedRate.toFixed(2)}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={7}>
                    Total — {filteredTxns.filter((t) => !t.cancelled).length} vouchers
                  </th>
                  <th className="right">
                    {fmt(
                      filteredTxns
                        .filter((t) => !t.cancelled)
                        .reduce((s, t) => s + t.amountInr, 0)
                    )}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── LEDGERS ───────────────────────────────────────────────────────── */}
      {tab === "ledgers" && (
        <div className="data-panel">
          <div className="table-filters">
            <label>
              Filter ledger / group
              <input
                value={ledgerFilter}
                onChange={(e) => setLedgerFilter(e.target.value)}
                placeholder="Type to filter..."
              />
            </label>
            <label>
              Min absolute value (INR)
              <input
                type="number"
                min="0"
                step="1"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Any"
              />
            </label>
            <button
              onClick={() => {
                setLedgerFilter("");
                setMinAmount("");
                setSortKey("name");
                setSortDir("asc");
              }}
            >
              Clear
            </button>
            <span>
              {sortedAccounts.length} of {gr.accounts.length} ledgers
            </span>
          </div>
          <div className="table-scroll">
            <table className="transaction-table gr-ledger-table">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "60px" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "16%" }} />
              </colgroup>
              <thead>
                <tr>
                  <SortTh field="name">Ledger</SortTh>
                  <SortTh field="group">Group</SortTh>
                  <th>Src</th>
                  <SortTh field="inClosingInr" right>IN Closing (INR)</SortTh>
                  <SortTh field="usClosingUsd" right>US Closing (USD)</SortTh>
                  <SortTh field="usClosingInr" right>US in INR</SortTh>
                  <SortTh field="closingInr" right>Total (INR)</SortTh>
                </tr>
              </thead>
              <tbody>
                {sortedAccounts.map((a, i) => (
                  <tr key={i}>
                    <td>{a.name}</td>
                    <td>{a.parent || "-"}</td>
                    <td>
                      {a.sources.map((s) => (
                        <span key={s} className={`source-badge source-${s.toLowerCase()}`}>
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className="right">
                      {Math.abs(a.inClosingInr) > tol ? fmt(a.inClosingInr) : "-"}
                    </td>
                    <td className="right">
                      {Math.abs(a.usClosingUsd) > 0.0001 ? fmt(a.usClosingUsd, "USD") : "-"}
                    </td>
                    <td className="right">
                      {Math.abs(a.usClosingInr) > tol ? fmt(a.usClosingInr) : "-"}
                    </td>
                    <td className="right">
                      <strong>
                        {Math.abs(a.closingInr) > tol ? fmt(a.closingInr) : "-"}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>Total ({sortedAccounts.length} ledgers)</th>
                  <th className="right">
                    {fmt(sortedAccounts.reduce((s, a) => s + a.inClosingInr, 0))}
                  </th>
                  <th className="right">—</th>
                  <th className="right">
                    {fmt(sortedAccounts.reduce((s, a) => s + a.usClosingInr, 0))}
                  </th>
                  <th className="right">
                    <strong>
                      {fmt(sortedAccounts.reduce((s, a) => s + a.closingInr, 0))}
                    </strong>
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── REPORTS ───────────────────────────────────────────────────────── */}
      {tab === "reports" && (
        <>
          <div className="report-picker">
            <button className={report === "trial" ? "selected" : ""} onClick={() => setReport("trial")}>
              Trial Balance
            </button>
            <button className={report === "income" ? "selected" : ""} onClick={() => setReport("income")}>
              Income &amp; Expenditure
            </button>
            <button className={report === "balance" ? "selected" : ""} onClick={() => setReport("balance")}>
              Balance Sheet
            </button>
            <button className={report === "cashflow" ? "selected" : ""} onClick={() => setReport("cashflow")}>
              Cash Flow
            </button>
            <button className={report === "cash" ? "selected" : ""} onClick={() => setReport("cash")}>
              Cash and Bank
            </button>
            <button
              className={report === "equity" ? "selected" : ""}
              onClick={() => setReport("equity")}
            >
              Equity
            </button>
          </div>

          {/* Trial Balance */}
          {report === "trial" && (() => {
            const tbRows = [...activeAccounts]
              .map((a) => {
                const isIE = ["Income", "Expense"].includes(grNature(a.parent));
                const pdr = periodCalc.dr.get(normKey(a.name)) || 0;
                const pcr = periodCalc.cr.get(normKey(a.name)) || 0;
                let dr: number, cr: number;
                if (isIE) {
                  // Net period balance — Dr-heavy in Dr column, Cr-heavy in Cr column.
                  const net = pdr - pcr;
                  dr = net > tol ? net : 0;
                  cr = net < -tol ? -net : 0;
                } else {
                  // Balance as of period end: opening + all transactions up to period end
                  const cumDr = cumulativeAtPeriodEnd.dr.get(normKey(a.name)) || 0;
                  const cumCr = cumulativeAtPeriodEnd.cr.get(normKey(a.name)) || 0;
                  const bal = a.openingInr - cumDr + cumCr;
                  dr = bal < -tol ? -bal : 0;
                  cr = bal > tol ? bal : 0;
                }
                return { a, dr, cr, isIE };
              })
              .filter(({ dr, cr }) => dr > tol || cr > tol)
              .sort((x, y) => x.a.name.localeCompare(y.a.name));
            const totalDr = tbRows.reduce((s, r) => s + r.dr, 0);
            const totalCr = tbRows.reduce((s, r) => s + r.cr, 0);
            return (
              <div className="data-panel">
                <h3>Trial Balance — All Ledgers in INR</h3>
                <p className="gr-report-note">
                  BS accounts: balance as of end of {periodLabel}. I&amp;E accounts: net activity for {periodLabel}. Totals tie when the selected period covers all data.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Ledger</th>
                      <th>Group</th>
                      <th>Src</th>
                      <th className="right">Dr (INR)</th>
                      <th className="right">Cr (INR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tbRows.map(({ a, dr, cr }, i) => (
                      <tr key={i}>
                        <td><LedgerLink name={a.name} /></td>
                        <td>{a.parent || "-"}</td>
                        <td>
                          {a.sources.map((s) => (
                            <span key={s} className={`source-badge source-${s.toLowerCase()}`}>{s}</span>
                          ))}
                        </td>
                        <td className="right">{dr > tol ? fmt(dr) : "-"}</td>
                        <td className="right">{cr > tol ? fmt(cr) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={3}>Totals</th>
                      <th className="right">{fmt(totalDr)}</th>
                      <th className="right">{fmt(totalCr)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })()}

          {/* Income & Expenditure — uses GroupedReport for collapsible groups */}
          {report === "income" && (
            <>
              <GroupedReport
                title1="Expenditure"
                rows1={ieExpenseRows}
                title2="Income"
                rows2={ieIncomeRows}
                link={(a) => <LedgerLink name={a.name} />}
                fmt={(n) => fmt(Math.abs(n))}
              />
              <div className="period-result">
                <span>Period income</span>
                <strong>{fmt(periodIncome)}</strong>
                <span>Period expenditure</span>
                <strong>{fmt(periodExpense)}</strong>
                <span>Surplus / (Deficit)</span>
                <strong>{fmt(periodSurplus)}</strong>
              </div>
            </>
          )}

          {/* Balance Sheet — uses BalanceSheetReport for collapsible sections */}
          {report === "balance" && (
            <div className="data-panel">
              <h3>Balance Sheet (GR Consolidated)</h3>
              <p className="gr-report-note">
                All-time closing balances in INR. P&amp;L section shows cumulative surplus / deficit.
              </p>
              <BalanceSheetReport
                assets={bsAssets}
                liabilities={bsLiabs}
                capitalTransfer={capitalTransfer}
                link={(a) => <LedgerLink name={a.name} />}
                fmt={(n) => fmt(n)}
              />
            </div>
          )}

          {/* Cash Flow — uses CashFlowReport for collapsible groups */}
          {report === "cashflow" && (
            <CashFlowReport
              periodLabel={periodLabel}
              cashOpening={cashOpening}
              cashInflows={cashInflows}
              cashOutflows={cashOutflows}
              cashNet={cashNet}
              cashFlowClosing={cashFlowClosing}
              cashBank={cashBank}
              cashFlowGroups={cashFlowGroups}
              tol={tol}
              fmt={(n) => fmt(n)}
              onGroup={() => {}}
              onLedger={() => {}}
            />
          )}

          {/* Equity */}
          {report === "equity" && (
            <EquityReport
              grants={equityData?.grants ?? []}
              esppPurchases={equityData?.esppPurchases ?? []}
              onSave={async () => {}}
              fmt={(n) => {
                const inr = n * latestFxRate;
                return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Math.abs(inr) < 0.005 ? 0 : inr);
              }}
              readOnly={true}
              uiTheme={uiTheme}
            />
          )}

          {/* Cash and Bank */}
          {report === "cash" && (
            <div className="data-panel">
              <h3>Cash and Bank Closing Balances</h3>
              {bankCashAccounts
                .filter((a) => Math.abs(a.closingInr) > tol)
                .sort((a, b) => a.closingInr - b.closingInr)
                .map((a, i) => (
                  <div className="report-line" key={i}>
                    <span>
                      {a.name}{" "}
                      {a.sources.map((s) => (
                        <span key={s} className={`source-badge source-${s.toLowerCase()}`}>{s}</span>
                      ))}
                    </span>
                    <strong>{fmt(-a.closingInr)}</strong>
                  </div>
                ))}
              <div className="report-total">
                <span>Total cash and bank (INR)</span>
                <strong>{fmt(-bankCashAccounts.reduce((s, a) => s + a.closingInr, 0))}</strong>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── LEDGER DETAIL OVERLAY ─────────────────────────────────────────── */}
      {selectedAccount && (
        <div className="drill-overlay" onClick={() => setSelectedLedgerName(null)}>
          <div className="drill-panel ledger-drill-panel" onClick={(e) => e.stopPropagation()}>
            <div className="drill-header-row">
              <div className="drill-header-title">
                <h2>{selectedAccount.name}</h2>
                <p className="gr-drill-group">{selectedAccount.parent || "—"}</p>
                <div className="gr-drill-src">
                  {selectedAccount.sources.map((s) => (
                    <span key={s} className={`source-badge source-${s.toLowerCase()}`}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="drill-period-bar">
                <span>Period</span>
                <select value={overlayYear} onChange={(e) => setOverlayYear(e.target.value)}>
                  <option value="all">All periods</option>
                  <optgroup label="Fiscal years">
                    {periods.years.map((y) => (
                      <option key={y} value={y}>FY {y} (Apr {y} – Mar {Number(y) + 1})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Month">
                    {periods.months.map((m) => (
                      <option key={m} value={m}>
                        {new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <button className="drill-close" onClick={() => setSelectedLedgerName(null)}>Close</button>
            </div>
            {(() => {
              const ps = overlayLedgerTxns.reduce(
                (acc, t) => {
                  const e = t.entries.find((e) => normKey(e.accountName) === normKey(selectedAccount.name));
                  if (!e) return acc;
                  if (e.amountInr < 0) {
                    acc.totalDrInr += -e.amountInr;
                    if (t.source === "US") acc.usDrUsd += e.originalAmount < 0 ? -e.originalAmount : e.originalAmount;
                  } else {
                    acc.totalCrInr += e.amountInr;
                    if (t.source === "US") acc.usCrUsd += e.originalAmount > 0 ? e.originalAmount : -e.originalAmount;
                  }
                  return acc;
                },
                { totalDrInr: 0, totalCrInr: 0, usDrUsd: 0, usCrUsd: 0 }
              );
              const periodNet = ps.totalDrInr - ps.totalCrInr;
              const isIE = ["Income", "Expense"].includes(grNature(selectedAccount.parent));
              return (
                <section className="drill-summary">
                  <div className="drill-summary-row">
                    <span>Period Dr (INR)</span>
                    <strong>{ps.totalDrInr > tol ? fmt(ps.totalDrInr) : "—"}</strong>
                  </div>
                  <div className="drill-summary-row">
                    <span>Period Cr (INR)</span>
                    <strong>{ps.totalCrInr > tol ? fmt(ps.totalCrInr) : "—"}</strong>
                  </div>
                  {selectedAccount.sources.includes("US") && (ps.usDrUsd > tol || ps.usCrUsd > tol) && (
                    <div className="drill-summary-row">
                      <span>US Dr/Cr (USD)</span>
                      <strong>
                        {ps.usDrUsd > tol ? fmt(ps.usDrUsd, "USD") : "—"}
                        {" / "}
                        {ps.usCrUsd > tol ? fmt(ps.usCrUsd, "USD") : "—"}
                      </strong>
                    </div>
                  )}
                  <div className="drill-summary-row drill-summary-total">
                    <span>Period net Dr–Cr (INR)</span>
                    <strong>{fmt(periodNet)}</strong>
                  </div>
                  {!isIE && (
                    <div className="drill-summary-row drill-summary-alltime">
                      <span>All-time closing (INR)</span>
                      <strong>{fmt(selectedAccount.closingInr)}</strong>
                    </div>
                  )}
                </section>
              );
            })()}
            {overlayLedgerTxns.length > 0 ? (
              <div className="drill-txns">
                <h4>Vouchers — {overlayLabel} ({overlayLedgerTxns.length})</h4>
                <table className="gr-modal-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Src</th>
                      <th>Type</th>
                      <th>Counterpart</th>
                      <th className="right">Dr (INR)</th>
                      <th className="right">Cr (INR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overlayLedgerTxns.map((t) => {
                      const myEntry = t.entries.find((e) => normKey(e.accountName) === normKey(selectedAccount.name));
                      const others = t.entries.filter((e) => normKey(e.accountName) !== normKey(selectedAccount.name));
                      const counterpart = others.map((e) => e.accountName).join(" / ") || "-";
                      return (
                        <tr key={t.guid} className={t.source === "US" ? "gr-row-us" : "gr-row-in"} style={{ cursor: "pointer" }} onClick={() => { setSelectedLedgerName(null); setExpandedGuid(t.guid); }}>
                          <td>{formatDate(t.date)}</td>
                          <td><span className={`source-badge source-${t.source.toLowerCase()}`}>{t.source}</span></td>
                          <td>{t.type}</td>
                          <td>{counterpart}</td>
                          <td className="right">{myEntry && myEntry.amountInr < 0 ? fmt(-myEntry.amountInr) : "—"}</td>
                          <td className="right">{myEntry && myEntry.amountInr > 0 ? fmt(myEntry.amountInr) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="gr-drill-nodata">No transactions in {overlayLabel}.</p>
            )}
          </div>
        </div>
      )}

      {/* ── VOUCHER DETAIL MODAL ──────────────────────────────────────────── */}
      {modalTx && (
        <div className="gr-modal-overlay" onClick={() => setExpandedGuid(null)}>
          <div
            className={`gr-modal-panel ${modalTx.source === "US" ? "gr-modal-us" : "gr-modal-in"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="gr-modal-close" onClick={() => setExpandedGuid(null)} aria-label="Close">×</button>
            <div className="gr-modal-head">
              <span className={`source-badge source-${modalTx.source.toLowerCase()}`}>{modalTx.source}</span>
              <strong>{modalTx.type}</strong>
              {modalTx.number && <span className="gr-modal-num">#{modalTx.number}</span>}
              {modalTx.cancelled && <span className="gr-cancelled-tag">CANCELLED</span>}
            </div>
            <div className="gr-modal-meta">
              <span>{formatDate(modalTx.date)}</span>
              {modalTx.narration && <span className="gr-modal-narr">{modalTx.narration}</span>}
              {modalTx.source === "US" && (
                <span className="gr-modal-rate">
                  FX: {modalTx.appliedRate.toFixed(4)} (prev-month avg) · {fmt(modalTx.amountUsd, "USD")} = {fmt(modalTx.amountInr)}
                </span>
              )}
            </div>
            <table className="gr-modal-table">
              <thead>
                <tr>
                  <th>Ledger</th>
                  <th className="right">Dr (INR)</th>
                  <th className="right">Cr (INR)</th>
                  {modalTx.source === "US" && <th className="right">Original (USD)</th>}
                </tr>
              </thead>
              <tbody>
                {modalTx.entries.map((e, i) => (
                  <tr key={i}>
                    <td>{e.accountName}</td>
                    <td className="right">{e.amountInr < 0 ? fmt(-e.amountInr) : "—"}</td>
                    <td className="right">{e.amountInr > 0 ? fmt(e.amountInr) : "—"}</td>
                    {modalTx.source === "US" && (
                      <td className="right">
                        {e.originalAmount !== 0
                          ? `${fmt(Math.abs(e.originalAmount), "USD")} ${e.originalAmount < 0 ? "Dr" : "Cr"}`
                          : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="right">{fmt(modalTx.amountInr)}</th>
                  <th className="right">{fmt(modalTx.amountInr)}</th>
                  {modalTx.source === "US" && <th className="right">{fmt(modalTx.amountUsd, "USD")}</th>}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── FX RATES ──────────────────────────────────────────────────────── */}
      {tab === "fxrates" && (
        <div className="data-panel gr-fxrates-panel">
          <div className="gr-fxrates-header">
            <h3>USD → INR Monthly Average Rates</h3>
            <div className="gr-fxrates-actions">
              <button onClick={refreshRates} disabled={savingRates}>
                {savingRates ? "Working..." : "Refresh from frankfurter.app"}
              </button>
              {editMode && (
                <button className="primary" onClick={saveEditedRates} disabled={savingRates}>
                  Save Custom Rates &amp; Recalculate
                </button>
              )}
            </div>
          </div>
          <p className="gr-fxrates-note">
            Each US transaction uses the <strong>previous month's</strong> average rate (e.g.,
            July 2026 transactions use the June 2026 average). Rates are fetched automatically
            from{" "}
            <a href="https://api.frankfurter.app" target="_blank" rel="noopener noreferrer">
              frankfurter.app
            </a>{" "}
            (ECB data). {editMode && "Edit mode: you can override any rate below."}
          </p>
          {gr.missingRateMonths.length > 0 && (
            <div className="vault-status" style={{ marginBottom: 12 }}>
              Missing rates for: {gr.missingRateMonths.join(", ")} — used fallback {gr.latestRate.toFixed(2)}.
              Click Refresh to attempt re-fetch, or enter rates manually in Edit Mode.
            </div>
          )}
          <table className="transaction-table gr-fxrates-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Applies To (Next Month's Transactions)</th>
                <th className="right">Avg Rate (1 USD = x INR)</th>
                {editMode && <th>Override</th>}
              </tr>
            </thead>
            <tbody>
              {Object.entries(gr.fxRates)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([month, rate]) => {
                  const [y, m] = month.split("-").map(Number);
                  const nm = m === 12 ? 1 : m + 1;
                  const ny = m === 12 ? y + 1 : y;
                  const appliesTo = `${ny}-${String(nm).padStart(2, "0")}`;
                  const isMissing = gr.missingRateMonths.includes(month);
                  return (
                    <tr key={month} className={isMissing ? "gr-missing-rate-row" : ""}>
                      <td>{month}{isMissing && " ⚠"}</td>
                      <td>
                        <span className="gr-fxrates-applies">{appliesTo} transactions</span>
                      </td>
                      <td className="right">{rate.toFixed(4)}</td>
                      {editMode && (
                        <td>
                          <input
                            type="number"
                            step="0.0001"
                            min="1"
                            value={editRates[month] ?? String(rate)}
                            onChange={(e) =>
                              setEditRates((r) => ({ ...r, [month]: e.target.value }))
                            }
                            className="gr-rate-input"
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              {Object.keys(gr.fxRates).length === 0 && (
                <tr>
                  <td colSpan={editMode ? 4 : 3} className="gr-no-rates">
                    No rates stored yet. Click "Refresh from frankfurter.app" to fetch them.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
