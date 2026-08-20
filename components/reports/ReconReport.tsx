"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { fiscalYearOf } from "@/lib/vault-accounting";

interface ReconRow {
  name: string;
  parent: string;
  appBalance: number | null;
  tallyBalance: number | null;
  diff: number;
  status: "matched" | "difference" | "app-only" | "tally-only";
}

const tol = 0.005;

// Authoritative nature check — mirrors natureFor() in VaultApp.tsx exactly. The account's
// own `category` field is set once at master-sync link time and can go stale; the group
// name (`parent`) plus any user-configured MasterGroup override is the live source of truth
// everywhere else in this app, so Recon must use the same logic or it'll disagree with the
// app's own Balance Sheet / Trial Balance for any account whose category field drifted.
function natureForRecon(a: { parent: string }, masterGroups: Map<string, { nature: string }>): string {
  const group = (a.parent || "").toLowerCase(), configured = masterGroups.get(group);
  if (group.includes("(asset)")) return "Asset";
  if (configured) return configured.nature;
  if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
  if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
  if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
  if (/^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(group)) return "Liability";
  if (group === "bank accounts") return "Bank";
  if (group === "cash-in-hand") return "Cash";
  if (group === "investments") return "Investment";
  return "Asset";
}

// Income/Expense ledgers reset to zero at the start of each fiscal year in Tally (they
// roll into Profit & Loss / Capital rather than carrying their own balance forward), so
// only Balance Sheet accounts (Asset/Liability/Capital/Bank/Cash/Investment) should be
// compared life-to-date. Comparing a P&L ledger's full history against Tally's current-FY
// balance would show a permanent, meaningless "difference" for every P&L account.
function isProfitAndLossNature(nature: string): boolean {
  return nature === "Income" || nature === "Expense";
}

// The synthetic "Profit & Loss A/c" ledger isn't posted to directly — Tally computes it as
// the net Income − Expense movement for the current fiscal year and rolls it into Capital
// at year-end. It must be computed the same way, not treated as a normal Capital-nature
// ledger with a life-to-date opening balance (which would show the deficit/surplus from
// every past year stacked up, not just the current one).
const isProfitAndLossAccountName = (name: string): boolean => /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(name);

function computeAppBalances(data: Ledger, fyStart: string, fyEnd: string): Map<string, number> {
  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g]));
  const natureOf = (a: { parent: string }) => natureForRecon(a, masterGroups);
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const sums = new Map<number, number>();
  let currentYearPL = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    const inCurrentFy = t.date >= fyStart && t.date <= fyEnd;
    for (const e of t.entries) {
      const acc = accountById.get(e.accountId);
      if (!acc) continue;
      if (isProfitAndLossNature(natureOf(acc))) {
        if (inCurrentFy) currentYearPL += e.amount;
        if (!inCurrentFy) continue;
      }
      sums.set(e.accountId, (sums.get(e.accountId) || 0) + e.amount);
    }
  }
  const closingFor = (a: Ledger["accounts"][number]) =>
    isProfitAndLossAccountName(a.name)
      ? currentYearPL
      : (isProfitAndLossNature(natureOf(a)) ? 0 : (a.openingBalance || 0)) + (sums.get(a.id) || 0);
  const byName = new Map<string, number>();
  // Two passes so an inactive duplicate ledger can never silently overwrite the active one
  // when two accounts share the same display name.
  for (const a of data.accounts) {
    if (a.active === false) continue;
    byName.set(a.name.trim().toLowerCase(), closingFor(a));
  }
  for (const a of data.accounts) {
    const key = a.name.trim().toLowerCase();
    if (a.active === false && !byName.has(key)) byName.set(key, closingFor(a));
  }
  return byName;
}

export function ReconReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [fName, setFName] = useState("");
  const [fParent, setFParent] = useState("");
  const [fApp, setFApp] = useState("");
  const [fTally, setFTally] = useState("");
  const [fDiff, setFDiff] = useState("");
  const [fStatus, setFStatus] = useState("");

  const snapshot = data.tallyLedgerSnapshot;

  const rows = useMemo<ReconRow[]>(() => {
    const asOfDate = snapshot ? snapshot.asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const fy = fiscalYearOf(asOfDate);
    const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
    const appByName = computeAppBalances(data, fyStart, fyEnd);
    const tallyByName = new Map<string, { parent?: string; closingBalance: number }>();
    for (const b of snapshot?.balances || []) tallyByName.set(b.name.trim().toLowerCase(), b);

    const names = new Set<string>([...appByName.keys(), ...tallyByName.keys()]);
    const accountParent = new Map(data.accounts.map((a) => [a.name.trim().toLowerCase(), a.parent]));

    const out: ReconRow[] = [];
    for (const key of names) {
      const app = appByName.has(key) ? appByName.get(key)! : null;
      const t = tallyByName.get(key);
      const tally = t ? t.closingBalance : null;
      const parent = accountParent.get(key) || t?.parent || "";
      const displayName = data.accounts.find((a) => a.name.trim().toLowerCase() === key)?.name
        || snapshot?.balances.find((b) => b.name.trim().toLowerCase() === key)?.name
        || key;
      let status: ReconRow["status"];
      let diff: number;
      if (app === null) { status = "tally-only"; diff = -(tally || 0); }
      else if (tally === null) { status = "app-only"; diff = app; }
      else { diff = app - tally; status = Math.abs(diff) > tol ? "difference" : "matched"; }
      out.push({ name: displayName, parent, appBalance: app, tallyBalance: tally, diff, status });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [data, snapshot]);

  const filtered = rows.filter((r) => {
    if (onlyDiff && r.status === "matched") return false;
    if (fName && !r.name.toLowerCase().includes(fName.toLowerCase())) return false;
    if (fParent && !r.parent.toLowerCase().includes(fParent.toLowerCase())) return false;
    if (fApp && !(r.appBalance === null ? "" : r.appBalance.toFixed(2)).includes(fApp)) return false;
    if (fTally && !(r.tallyBalance === null ? "" : r.tallyBalance.toFixed(2)).includes(fTally)) return false;
    if (fDiff && !r.diff.toFixed(2).includes(fDiff)) return false;
    if (fStatus && r.status !== fStatus) return false;
    return true;
  });

  const diffCount = rows.filter((r) => r.status !== "matched").length;
  const totalDiff = rows.reduce((s, r) => s + Math.abs(r.diff), 0);

  const statusLabel: Record<ReconRow["status"], string> = {
    matched: "Matched",
    difference: "Difference",
    "app-only": "App only",
    "tally-only": "Tally only",
  };

  if (!snapshot) {
    return (
      <div className="data-panel recon-panel">
        <div className="recon-empty">
          No Tally ledger balance snapshot yet. This is captured automatically by the sync
          engine (master-sync step) on your personal laptop — run &quot;RUN US SYNC NOW&quot; once,
          then reload this report.
        </div>
      </div>
    );
  }

  return (
    <div className="data-panel recon-panel">
      <div className="recon-header">
        <div>
          <h3 style={{ margin: 0 }}>Reconciliation — App vs Tally Ledger Balances</h3>
          <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "4px 0 0" }}>
            Tally balances as of {new Date(snapshot.asOf).toLocaleString()}. {diffCount} ledger(s)
            differ, total absolute difference {fmt(totalDiff)}.
          </p>
        </div>
        <label className="recon-only-diff">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          Show only differences
        </label>
      </div>
      <table className="recon-table">
        <thead>
          <tr>
            <th>Ledger</th>
            <th>Group</th>
            <th className="right">App Balance</th>
            <th className="right">Tally Balance</th>
            <th className="right">Difference</th>
            <th>Status</th>
          </tr>
          <tr className="recon-filter-row">
            <th><input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Filter…" /></th>
            <th><input value={fParent} onChange={(e) => setFParent(e.target.value)} placeholder="Filter…" /></th>
            <th><input value={fApp} onChange={(e) => setFApp(e.target.value)} placeholder="Filter…" /></th>
            <th><input value={fTally} onChange={(e) => setFTally(e.target.value)} placeholder="Filter…" /></th>
            <th><input value={fDiff} onChange={(e) => setFDiff(e.target.value)} placeholder="Filter…" /></th>
            <th>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">All</option>
                <option value="matched">Matched</option>
                <option value="difference">Difference</option>
                <option value="app-only">App only</option>
                <option value="tally-only">Tally only</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr><td colSpan={6} className="recon-empty-row">No ledgers match the current filters.</td></tr>
          ) : (
            filtered.map((r) => (
              <tr key={r.name} className={r.status !== "matched" ? "recon-row-diff" : ""}>
                <td>{r.name}</td>
                <td className="recon-parent">{r.parent || "—"}</td>
                <td className="right">{r.appBalance === null ? "—" : fmt(r.appBalance)}</td>
                <td className="right">{r.tallyBalance === null ? "—" : fmt(r.tallyBalance)}</td>
                <td className={`right ${Math.abs(r.diff) > tol ? "recon-diff-amt" : ""}`}>
                  {Math.abs(r.diff) > tol ? fmt(r.diff) : "—"}
                </td>
                <td><span className={`pill recon-status-${r.status}`}>{statusLabel[r.status]}</span></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
