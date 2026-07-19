"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { decryptVault } from "@/lib/vault-crypto";
import { fiscalYearOf } from "@/lib/vault-accounting";
import type { Ledger, Vault } from "@/lib/vault-types";
import {
  consolidateLedger,
  neededRateMonths,
  getApplicableRate,
  prevMonthKey,
  type FxRates,
  type GrLedger,
  type GrTx,
  type GrAccount,
} from "@/lib/gr-consolidation";

type Phase = "init" | "loading" | "ready" | "error";

const fmtInr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n: number, currency: "INR" | "USD" = "INR") =>
  (currency === "INR" ? fmtInr : fmtUsd).format(Math.abs(n) < 0.005 ? 0 : n);

const tol = 0.005;

function debitNames(t: GrTx) {
  return t.entries
    .filter((e) => e.amountInr < 0)
    .map((e) => e.accountName)
    .join(" / ") || "-";
}
function creditNames(t: GrTx) {
  return t.entries
    .filter((e) => e.amountInr > 0)
    .map((e) => e.accountName)
    .join(" / ") || "-";
}

function formatDate(d: string) {
  return d.split("-").reverse().join("-");
}

function prevMonth(ym: string): string {
  const y = Number(ym.slice(0, 4)),
    m = Number(ym.slice(5, 7));
  const pm = m === 1 ? 12 : m - 1,
    py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

export function GrApp() {
  const [phase, setPhase] = useState<Phase>("init");
  const [statusMsg, setStatusMsg] = useState("");
  const [gr, setGr] = useState<GrLedger | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [tab, setTab] = useState<"daybook" | "ledgers" | "fxrates">("daybook");
  const [year, setYear] = useState("all");
  const [customStart, setCustomStart] = useState("2026-04");
  const [customEnd, setCustomEnd] = useState("2026-06");
  const [query, setQuery] = useState("");
  const [editRates, setEditRates] = useState<Record<string, string>>({});
  const [savingRates, setSavingRates] = useState(false);
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [minAmount, setMinAmount] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState("");
  const loadedRef = useRef(false);

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
      const [usResp, inResp, fxResp] = await Promise.all([
        fetch("/api/vault", { cache: "no-store" }),
        fetch("/api/vault?book=india", { cache: "no-store" }),
        fetch("/api/fx-rates"),
      ]);
      if (!usResp.ok || !inResp.ok) throw new Error("Vault fetch failed");
      const [usRaw, inRaw] = await Promise.all([usResp.text(), inResp.text()]);
      const [usVault, inVault] = [JSON.parse(usRaw) as Vault, JSON.parse(inRaw) as Vault];
      const [usData, inData] = await Promise.all([
        decryptVault(usVault, usPw),
        decryptVault(inVault, inPw),
      ]);

      let rates: FxRates = {};
      if (fxResp.ok) {
        const fx = (await fxResp.json()) as { rates?: FxRates };
        rates = fx.rates ?? {};
      }

      const needed = neededRateMonths(usData.transactions);
      const missing = needed.filter((m) => rates[m] == null);
      if (missing.length) {
        setStatusMsg(`Fetching FX rates for ${missing.length} month(s) from frankfurter.app...`);
        try {
          const r = await fetch("/api/fx-rates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ months: missing }),
          });
          if (r.ok) {
            const data = (await r.json()) as { rates?: FxRates };
            rates = data.rates ?? rates;
          }
        } catch {}
      }

      const consolidated = consolidateLedger(usData, inData, rates);
      setGr(consolidated);
      setEditRates(
        Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, String(v)]))
      );
      setPhase("ready");
      setStatusMsg(
        consolidated.missingRateMonths.length
          ? `Warning: no FX rate found for ${consolidated.missingRateMonths.join(", ")} — used fallback rate.`
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
    setStatusMsg("Re-fetching all FX rates from frankfurter.app...");
    try {
      const needed = Object.keys(gr.fxRates);
      const r = await fetch("/api/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: needed }),
      });
      if (r.ok) {
        const data = (await r.json()) as { rates?: FxRates };
        const rates = data.rates ?? gr.fxRates;
        setEditRates(
          Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, String(v)]))
        );
        setStatusMsg("FX rates refreshed.");
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
      const y = Number(t.date.slice(0, 4)),
        m = Number(t.date.slice(5, 7));
      ys.add(String(m >= 4 ? y : y - 1));
      ms.add(t.date.slice(0, 7));
    }
    return {
      years: [...ys].sort().reverse(),
      months: [...ms].sort().reverse(),
    };
  }, [gr]);

  const periodLabel = useMemo(() => {
    if (year === "all") return "All periods";
    if (year === "custom")
      return `${customStart} to ${customEnd}`;
    if (year.length === 7)
      return new Date(`${year}-01T00:00:00`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
    return `FY ${year} (Apr ${year} – Mar ${Number(year) + 1})`;
  }, [year, customStart, customEnd]);

  const filteredTxns = useMemo(() => {
    if (!gr) return [];
    const start =
      year === "all"
        ? "0000-00-00"
        : year === "custom"
          ? `${customStart}-01`
          : year.length === 7
            ? `${year}-01`
            : `${year}-04-01`;
    const end =
      year === "all"
        ? "9999-99-99"
        : year === "custom"
          ? `${customEnd}-31`
          : year.length === 7
            ? `${year}-31`
            : `${Number(year) + 1}-03-31`;
    return gr.transactions
      .filter((t) => t.date >= start && t.date <= end)
      .filter(
        (t) =>
          !query ||
          `${t.date} ${t.type} ${t.number} ${t.narration} ${t.entries.map((e) => e.accountName).join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase())
      )
      .slice(0, 1000);
  }, [gr, year, customStart, customEnd, query]);

  const sortedAccounts = useMemo(() => {
    if (!gr) return [];
    return gr.accounts
      .filter((a) => Math.abs(a.closingInr) > tol || a.debitInr > tol || a.creditInr > tol || Math.abs(a.openingInr) > tol)
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
          sortKey === "name"
            ? a.name.toLowerCase()
            : sortKey === "group"
              ? a.parent.toLowerCase()
              : Number(a[sortKey as "closingInr"] ?? 0);
        const bv =
          sortKey === "name"
            ? b.name.toLowerCase()
            : sortKey === "group"
              ? b.parent.toLowerCase()
              : Number(b[sortKey as "closingInr"] ?? 0);
        const r = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
        return sortDir === "asc" ? r : -r;
      });
  }, [gr, ledgerFilter, minAmount, sortKey, sortDir]);

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

  const PeriodSelect = () => (
    <span className="period-select-inline">
      <select value={year} onChange={(e) => setYear(e.target.value)}>
        <option value="all">All periods</option>
        <option value="custom">Custom range</option>
        <optgroup label="Fiscal years">
          {periods.years.map((y) => (
            <option key={y} value={y}>FY {y}</option>
          ))}
        </optgroup>
        <optgroup label="Month">
          {periods.months.map((m) => (
            <option key={m} value={m}>
              {new Date(`${m}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
            </option>
          ))}
        </optgroup>
      </select>
      {year === "custom" && (
        <>
          <input type="month" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
          <span>–</span>
          <input type="month" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} />
        </>
      )}
    </span>
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

  // ── SUMMARY STATS ─────────────────────────────────────────────────────────

  const totalClosingInr = gr.accounts.reduce(
    (s, a) => s + (a.closingInr < 0 ? 0 : a.closingInr),
    0
  );
  const usClosingInrTotal = gr.accounts.reduce(
    (s, a) => s + (a.usClosingInr < 0 ? 0 : a.usClosingInr),
    0
  );
  const inClosingInrTotal = gr.accounts.reduce(
    (s, a) => s + (a.inClosingInr < 0 ? 0 : a.inClosingInr),
    0
  );

  // ── MAIN RENDER ───────────────────────────────────────────────────────────

  return (
    <>
      <header>
        <div>
          <small>FINTECH BY DK - ACCOUNTING RELEASE 5</small>
          <div className="book-heading">
            <h1>Dignesh Khatri</h1>
            <span className="book-badge gr">GR CONSOLIDATED | INR</span>
          </div>
          <p>
            {gr.accounts.length} ledgers | {gr.transactions.length} vouchers (US + IN combined)
          </p>
        </div>
        <div className="header-actions">
          <button
            className={`secure-action gr-edit-toggle ${editMode ? "edit-active" : ""}`}
            title={editMode ? "Exit edit mode" : "Enter edit mode"}
            onClick={() => setEditMode((v) => !v)}
          >
            {editMode ? "Lock" : "Edit"}
          </button>
        </div>
      </header>

      <div className="app-nav">
        <button className={tab === "daybook" ? "selected" : ""} onClick={() => setTab("daybook")}>
          Day Book
        </button>
        <button className={tab === "ledgers" ? "selected" : ""} onClick={() => setTab("ledgers")}>
          Ledgers
        </button>
        <button className={tab === "fxrates" ? "selected" : ""} onClick={() => setTab("fxrates")}>
          FX Rates
        </button>
      </div>

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
        <span>Rate: {fmt(gr.latestRate, "INR")} per USD (latest avg)</span>
      </div>

      {statusMsg && <div className="vault-status">{statusMsg}</div>}

      {/* GR summary cards */}
      <section className="stats gr-summary-cards">
        <div className="gr-stat-card">
          <span>Total Closing (INR)</span>
          <strong>{fmt(totalClosingInr)}</strong>
        </div>
        <div className="gr-stat-card gr-stat-in">
          <span>India Books (INR)</span>
          <strong>{fmt(inClosingInrTotal)}</strong>
        </div>
        <div className="gr-stat-card gr-stat-us">
          <span>US Books in INR</span>
          <strong>{fmt(usClosingInrTotal)}</strong>
          <small>at {fmt(gr.latestRate)}/USD</small>
        </div>
        <div className="gr-stat-card gr-stat-txn">
          <span>Period Vouchers</span>
          <strong>{filteredTxns.filter((t) => !t.cancelled).length}</strong>
          <small>{periodLabel}</small>
        </div>
      </section>

      {/* ── DAY BOOK ─────────────────────────────────────────────────────── */}
      {tab === "daybook" && (
        <div className="data-panel">
          <div className="excel-toolbar">
            <input
              className="search-box"
              placeholder="Search vouchers..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <strong>
              {filteredTxns.length} vouchers — <PeriodSelect />
            </strong>
          </div>
          <div className="table-scroll">
            <table className="transaction-table gr-daybook-table">
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
                {filteredTxns.map((t) => (
                  <tr key={t.guid} className={t.cancelled ? "cancelled-row" : ""}>
                    <td className="date-cell">{formatDate(t.date)}</td>
                    <td>
                      <span className={`source-badge source-${t.source.toLowerCase()}`}>{t.source}</span>
                    </td>
                    <td>
                      <span className={`pill ${t.cancelled ? "cancelled" : ""}`}>
                        {t.type}{t.cancelled ? " - Cancelled" : ""}
                      </span>
                    </td>
                    <td>{t.number || "-"}</td>
                    <td>{debitNames(t)}</td>
                    <td>{creditNames(t)}</td>
                    <td>{t.narration || "-"}</td>
                    <td className="right">
                      {fmt(t.amountInr)}
                      {t.source === "US" && t.amountUsd > 0 && (
                        <small className="gr-usd-hint">
                          {fmt(t.amountUsd, "USD")} @ {t.appliedRate.toFixed(2)}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={7}>Period total ({filteredTxns.filter((t) => !t.cancelled).length} vouchers)</th>
                  <th className="right">
                    {fmt(filteredTxns.filter((t) => !t.cancelled).reduce((s, t) => s + t.amountInr, 0))}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── LEDGERS ──────────────────────────────────────────────────────── */}
      {tab === "ledgers" && (
        <div className="data-panel">
          <div className="table-filters">
            <label>
              Filter ledger / group
              <input value={ledgerFilter} onChange={(e) => setLedgerFilter(e.target.value)} placeholder="Type to filter..." />
            </label>
            <label>
              Min absolute value (INR)
              <input type="number" min="0" step="1" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="Any" />
            </label>
            <button onClick={() => { setLedgerFilter(""); setMinAmount(""); setSortKey("name"); setSortDir("asc"); }}>
              Clear
            </button>
            <span>{sortedAccounts.length} of {gr.accounts.length} ledgers</span>
          </div>
          <div className="table-scroll">
            <table className="transaction-table gr-ledger-table">
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
                        <span key={s} className={`source-badge source-${s.toLowerCase()}`}>{s}</span>
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
                      <strong>{Math.abs(a.closingInr) > tol ? fmt(a.closingInr) : "-"}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>Total ({sortedAccounts.length} ledgers)</th>
                  <th className="right">{fmt(sortedAccounts.reduce((s, a) => s + a.inClosingInr, 0))}</th>
                  <th className="right">—</th>
                  <th className="right">{fmt(sortedAccounts.reduce((s, a) => s + a.usClosingInr, 0))}</th>
                  <th className="right">
                    <strong>{fmt(sortedAccounts.reduce((s, a) => s + a.closingInr, 0))}</strong>
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── FX RATES ─────────────────────────────────────────────────────── */}
      {tab === "fxrates" && (
        <div className="data-panel gr-fxrates-panel">
          <div className="gr-fxrates-header">
            <h3>USD → INR Monthly Average Rates</h3>
            <div className="gr-fxrates-actions">
              <button onClick={refreshRates} disabled={savingRates}>
                {savingRates ? "Working..." : "Refresh from frankfurter.app"}
              </button>
              {editMode && (
                <button className="secure-action" onClick={saveEditedRates} disabled={savingRates}>
                  Save Custom Rates
                </button>
              )}
            </div>
          </div>
          <p className="gr-fxrates-note">
            Each transaction uses the previous month's average rate. For example, July 2026
            transactions use the June 2026 average.
          </p>
          <table className="transaction-table gr-fxrates-table">
            <thead>
              <tr>
                <th>Month (avg applies to next month's transactions)</th>
                <th className="right">Avg USD → INR</th>
                {editMode && <th>Custom Override</th>}
              </tr>
            </thead>
            <tbody>
              {Object.entries(gr.fxRates)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([month, rate]) => (
                  <tr key={month}>
                    <td>
                      {month}{" "}
                      <small className="gr-fxrates-applies">
                        (applies to {month.slice(0, 4)}-{String(Number(month.slice(5, 7)) + 1).padStart(2, "0")} transactions)
                      </small>
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
                ))}
              {Object.keys(gr.fxRates).length === 0 && (
                <tr>
                  <td colSpan={editMode ? 3 : 2} className="gr-no-rates">
                    No rates stored yet. Click "Refresh from frankfurter.app" to fetch them.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
