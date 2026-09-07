"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { periodKeyOf, isPeriodClosed } from "@/lib/vault-accounting";
import { reconciliationStatusForAccounts, DIFF_TOL, type PlaidAccountSummary, type PlaidTxSummary } from "@/lib/plaid-recon";
import { pendingDepreciationMonths } from "@/lib/fixed-assets";
import { pendingAmortizationMonths } from "@/lib/prepaid-expense";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

// Not a hard gate -- this is purely informational, surfacing what's outstanding for a period
// before you close it. Closing is still allowed with items unchecked; nothing here blocks save().
export function PeriodCloseChecklist({
  data,
  book,
  onSave,
  onNavigateReport,
}: {
  data: Ledger;
  book: "us" | "india";
  onSave: (next: Ledger) => Promise<boolean> | boolean;
  onNavigateReport: (report: string) => void;
}) {
  // Every period with at least one voucher, most recent first -- no point offering a checklist
  // for a period nothing was ever posted to.
  const periodsWithActivity = useMemo(() => {
    const set = new Set<string>();
    for (const t of data.transactions) {
      if (t.deleted || t.cancelled) continue;
      set.add(periodKeyOf(t.date));
    }
    return [...set].sort().reverse();
  }, [data.transactions]);

  const [period, setPeriod] = useState(() => periodsWithActivity.find((p) => !isPeriodClosed(data.closedPeriods, `${p}-01`)) ?? periodsWithActivity[0] ?? "");
  const closed = isPeriodClosed(data.closedPeriods, `${period}-01`);
  const periodEndDate = useMemo(() => {
    if (!period) return "";
    const [y, m] = period.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this month
    return `${period}-${String(lastDay).padStart(2, "0")}`;
  }, [period]);

  const [fetching, setFetching] = useState(false);
  const [plaidData, setPlaidData] = useState<{ accounts: PlaidAccountSummary[]; transactions: PlaidTxSummary[] } | null>(null);
  const showBankRecon = book !== "india";

  useEffect(() => {
    if (!showBankRecon) return;
    setFetching(true);
    fetch("/api/plaid/transactions")
      .then((r) => r.json() as Promise<{ transactions?: PlaidTxSummary[]; accounts?: PlaidAccountSummary[] }>)
      .then((d) => setPlaidData({ accounts: d.accounts ?? [], transactions: d.transactions ?? [] }))
      .catch(() => setPlaidData({ accounts: [], transactions: [] }))
      .finally(() => setFetching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBankRecon]);

  const bankReconRows = plaidData
    ? reconciliationStatusForAccounts(data, plaidData.accounts, plaidData.transactions, periodEndDate, data.bankReconExceptions)
    : null;
  const unmatchedAccounts = (bankReconRows ?? []).filter((r) => Math.abs(r.diff) > DIFF_TOL || r.unmatchedPlaid.length || r.unmatchedVault.length);

  const pendingDepreciation = (data.fixedAssets ?? [])
    .filter((a) => !a.disposed)
    .reduce((s, a) => s + pendingDepreciationMonths(a, periodEndDate).length, 0);
  const pendingAmortization = (data.prepaidExpenses ?? [])
    .filter((p) => !p.writtenOff)
    .reduce((s, p) => s + pendingAmortizationMonths(p, periodEndDate).length, 0);

  async function togglePeriod() {
    const next = closed ? (data.closedPeriods ?? []).filter((p) => p !== period) : [...(data.closedPeriods ?? []), period];
    await onSave({ ...data, closedPeriods: next });
  }

  const monthLabel = (p: string) => {
    const [y, m] = p.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  };

  const items: { label: string; status: string; ok: boolean; onView?: () => void }[] = [];
  if (showBankRecon) {
    items.push({
      label: "Bank Reconciliation",
      status: fetching
        ? "Checking…"
        : bankReconRows === null
          ? "Unavailable"
          : bankReconRows.length === 0
            ? "No Plaid-connected accounts to check"
            : unmatchedAccounts.length === 0
              ? "All accounts matched"
              : `${unmatchedAccounts.length} account(s) still unmatched`,
      ok: bankReconRows !== null && unmatchedAccounts.length === 0,
      onView: () => onNavigateReport("bankrecon"),
    });
  }
  items.push({
    label: "Fixed Asset Depreciation",
    status: pendingDepreciation === 0 ? "Up to date" : `${pendingDepreciation} asset-month(s) not yet posted`,
    ok: pendingDepreciation === 0,
    onView: () => onNavigateReport("fixedassets"),
  });
  items.push({
    label: "Prepaid Expense Amortization",
    status: pendingAmortization === 0 ? "Up to date" : `${pendingAmortization} item-month(s) not yet posted`,
    ok: pendingAmortization === 0,
    onView: () => onNavigateReport("prepaid"),
  });

  return (
    <div className="data-panel">
      <h3>Period-Close Checklist</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Informational only — nothing here blocks closing the period. It's just a quick look at what's still outstanding before
        you do.
      </p>
      <div className="master-toolbar">
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periodsWithActivity.map((p) => (
            <option key={p} value={p}>
              {monthLabel(p)}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: closed ? "#16a34a" : "#dc2626" }}>{closed ? "Closed" : "Open"}</span>
        <button type="button" className="tr-refresh-btn" onClick={togglePeriod}>
          {closed ? "Reopen this period" : "Close this period"}
        </button>
        <ExportButton
          onExport={async () => {
            const header = ["Item", "Status", "OK"];
            const body = items.map((item) => [item.label, item.status, item.ok ? "Yes" : "No"]);
            await exportWorkbook(`Period Close Checklist — ${monthLabel(period)}.xlsx`, [
              { name: "Checklist", rows: [header, ...body] },
            ]);
          }}
        />
      </div>
      {items.map((item) => (
        <div className="report-line" key={item.label}>
          <span>
            <strong style={{ color: item.ok ? "#16a34a" : "#dc2626" }}>{item.ok ? "✓" : "!"}</strong> {item.label}
            <br />
            <small style={{ opacity: 0.7 }}>{item.status}</small>
          </span>
          {item.onView && (
            <button type="button" className="tr-refresh-btn" onClick={item.onView}>
              Go to report
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
