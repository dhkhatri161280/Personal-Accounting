"use client";
import { useState } from "react";
import { todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { fmtDate } from "@/lib/format-date";
import { ExportButton } from "@/components/ExportButton";
import { SpendSection, type SpendLine } from "@/components/reports/SpendReport";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// GR's own version of SpendReport -- reuses the same SpendSection/SpendVoucherTable UI (category
// chips, drill-down, export) via SpendReport.tsx's exports, but sources lines from a caller-
// supplied `computeLines` instead of a Ledger directly, since GR's consolidated data (GrLedger)
// has a different shape (accountName-keyed entries, already-INR amounts) than a book's own
// Ledger. GrApp.tsx supplies computeLines using the same grNature-based Expense/Income
// classification every other GR report already uses, so this follows the same US+India-at-FX-
// rate principle as the rest of GR's reports.
export function GrSpendReport({
  computeLines,
  fmt,
}: {
  computeLines: (startDate: string, endDate: string) => { expenseLines: SpendLine[]; incomeLines: SpendLine[] };
  fmt: (n: number) => string;
}) {
  const [startDate, setStartDate] = useState(() => isoDaysAgo(6));
  const [endDate, setEndDate] = useState(todayLocalIso);
  const [showInfo, setShowInfo] = useState(false);

  const { expenseLines, incomeLines } = computeLines(startDate, endDate);

  const totalExpense = expenseLines.reduce((s, l) => s + l.amount, 0);
  const totalIncome = incomeLines.reduce((s, l) => s + l.amount, 0);
  const net = totalIncome - totalExpense;

  const byCategory = (lines: SpendLine[]) => {
    const map = new Map<string, number>();
    for (const l of lines) map.set(l.accountName, (map.get(l.accountName) ?? 0) + l.amount);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  };
  const expenseByCategory = byCategory(expenseLines);
  const incomeByCategory = byCategory(incomeLines);

  function applyPreset(days: number) {
    setStartDate(isoDaysAgo(days - 1));
    setEndDate(todayLocalIso());
  }
  function applyDay(daysAgo: number) {
    const iso = isoDaysAgo(daysAgo);
    setStartDate(iso);
    setEndDate(iso);
  }
  function applyThisMonth() {
    const d = new Date();
    setStartDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    setEndDate(todayLocalIso());
  }

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Spend Report
        <span
          className="info-icon-wrap"
          onMouseEnter={() => setShowInfo(true)}
          onMouseLeave={() => setShowInfo(false)}
        >
          <button
            type="button"
            className="info-icon-btn"
            aria-label="How the Spend Report works"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Postings to Expense and Income category ledgers over any date range you pick, consolidated across US +
              India Books at each month's applicable FX rate -- independent of the header's Financial period
              selector, so you can check an arbitrary window (a trip, a week, a month-to-date) at day-level
              precision. Transfers, contras, and journals are excluded either way. A refund or reimbursement against
              either category (e.g. a Receipt crediting an Expense ledger) reduces the total instead of being left
              out.
            </div>
          )}
        </span>
      </h3>
      <div className="report-line" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          From
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} max={endDate} />
        </label>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          To
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} max={todayLocalIso()} />
        </label>
        <button type="button" className="tr-refresh-btn" onClick={() => applyDay(0)}>
          Today
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => applyDay(1)}>
          Yesterday
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => applyPreset(7)}>
          Last 7 days
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => applyPreset(30)}>
          Last 30 days
        </button>
        <button type="button" className="tr-refresh-btn" onClick={applyThisMonth}>
          This month
        </button>
        <ExportButton
          disabled={expenseLines.length === 0 && incomeLines.length === 0}
          onExport={async () => {
            const header = ["Date", "Voucher Type", "Voucher #", "Account", "Narration", "Amount"];
            const expenseRows = expenseLines.map((l) => [fmtDate(l.date), l.voucherType, l.voucherNumber, l.accountName, l.narration, l.amount]);
            const incomeRows = incomeLines.map((l) => [fmtDate(l.date), l.voucherType, l.voucherNumber, l.accountName, l.narration, l.amount]);
            await exportWorkbook(`GR Spend Report ${startDate} to ${endDate}.xlsx`, [
              { name: "Expense", rows: [header, ...expenseRows] },
              { name: "Income", rows: [header, ...incomeRows] },
            ]);
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "0 0 16px" }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Expense</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#dc2626" }}>{fmt(totalExpense)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Income</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#16a34a" }}>{fmt(totalIncome)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Net</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: net >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(net)}</div>
        </div>
      </div>

      <SpendSection title="Expense" lines={expenseLines} byCategory={expenseByCategory} total={totalExpense} fmt={fmt} color="#dc2626" emptyLabel="expense" />
      <SpendSection title="Income" lines={incomeLines} byCategory={incomeByCategory} total={totalIncome} fmt={fmt} color="#16a34a" emptyLabel="income" />
    </div>
  );
}
