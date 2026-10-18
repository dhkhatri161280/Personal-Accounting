"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { StatIcon, type IconKind } from "@/components/Icon";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { computeReconRows, RECON_TOL as tol, type ReconRow } from "@/lib/tally-recon";

export function ReconReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [fName, setFName] = useState("");
  const [fParent, setFParent] = useState("");
  const [fApp, setFApp] = useState("");
  const [fTally, setFTally] = useState("");
  const [fDiff, setFDiff] = useState("");
  const [fStatus, setFStatus] = useState("");

  const snapshot = data.tallyLedgerSnapshot;

  const rows = useMemo<ReconRow[]>(() => computeReconRows(data), [data]);

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
  const matchedCount = rows.filter((r) => r.status === "matched").length;
  const appOnlyCount = rows.filter((r) => r.status === "app-only").length;
  const tallyOnlyCount = rows.filter((r) => r.status === "tally-only").length;

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

  async function exportRecon() {
    const header = ["Ledger", "Group", "App Balance", "Tally Balance", "Difference", "Status"];
    const body = filtered.map((r) => [r.name, r.parent || "", r.appBalance ?? "", r.tallyBalance ?? "", r.diff, statusLabel[r.status]]);
    await exportWorkbook("Reconciliation — App vs Tally.xlsx", [{ name: "Tally Recon", rows: [header, ...body] }]);
  }

  const summaryCards: { label: string; value: number; icon: IconKind; color: string; format?: "count" | "money" }[] = [
    { label: "Matched", value: matchedCount, icon: "scale", color: "#16a34a", format: "count" },
    { label: "Differences", value: diffCount, icon: "tag", color: diffCount > 0 ? "#dc2626" : "#64748b", format: "count" },
    { label: "App Only", value: appOnlyCount, icon: "receipt", color: "#7c3aed", format: "count" },
    { label: "Tally Only", value: tallyOnlyCount, icon: "bank", color: "#d97706", format: "count" },
    { label: "Total Difference", value: totalDiff, icon: "cash", color: totalDiff > tol ? "#dc2626" : "#16a34a" },
  ];

  return (
    <div className="data-panel recon-panel">
      <div className="recon-header">
        <div>
          <h3 style={{ margin: 0 }}>Reconciliation — App vs Tally Ledger Balances</h3>
          <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "4px 0 0" }}>
            Tally balances as of {new Date(snapshot.asOf).toLocaleString()}.
          </p>
        </div>
        <label className="recon-only-diff">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          Show only differences
        </label>
        <ExportButton onExport={exportRecon} />
      </div>
      <div className="equity-summary-row" style={{ margin: "0.75rem 0" }}>
        {summaryCards.map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div className="equity-summary-card">
              <StatIcon kind={c.icon} color={c.color} />
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <strong className="equity-amt">{c.format === "count" ? c.value : fmt(c.value)}</strong>
              </div>
            </div>
          </div>
        ))}
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
