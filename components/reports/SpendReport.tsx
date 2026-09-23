"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { FloatingWindow } from "@/components/FloatingWindow";

export type SpendLine = {
  key: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  narration: string;
  accountName: string;
  // Signed: positive = spend (Expense section) / earned (Income section); negative = a refund or
  // reversal against that same category -- e.g. a Receipt crediting an Expense ledger (money
  // reimbursed for something already spent) reduces net spend rather than being invisible.
  amount: number;
  // GR-only: which book this line originated from, plus (for a US-sourced line) the original USD
  // amount and FX rate applied -- mirrors the Day Book's own SRC badge + "$X @ rate" hint so GR's
  // Spend Report shows the same conversion detail as every other GR report instead of only the
  // converted INR figure. Left undefined by US/India's own SpendReport (single-currency, no
  // conversion to show).
  source?: "US" | "IN";
  originalAmountUsd?: number;
  appliedRate?: number;
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Independent of the header's "Financial period" selector (which is month-granularity only --
// its custom range is built from <input type="month">) -- this report needs its own day-level
// start/end so a user can check an arbitrary window (a weekend trip, a specific week) instead of
// being stuck at whole-month boundaries. Deliberately expense AND income side by side (not just
// expense) so the range shows the full picture -- what came in as well as what went out -- with
// transfers/journals/contras excluded either way since neither is really "spend" or "earn".
export function SpendReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [startDate, setStartDate] = useState(() => isoDaysAgo(6));
  const [endDate, setEndDate] = useState(todayLocalIso);
  const [showInfo, setShowInfo] = useState(false);

  const expenseAccountIds = useMemo(
    () => new Set(data.accounts.filter((a) => a.category === "Expense").map((a) => a.id)),
    [data.accounts]
  );
  const incomeAccountIds = useMemo(
    () => new Set(data.accounts.filter((a) => a.category === "Income").map((a) => a.id)),
    [data.accounts]
  );
  const accountName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);

  const { expenseLines, incomeLines } = useMemo(() => {
    const expense: SpendLine[] = [];
    const income: SpendLine[] = [];
    for (const t of data.transactions) {
      if (t.deleted || t.cancelled || t.date < startDate || t.date > endDate) continue;
      for (const e of t.entries) {
        const isExpense = expenseAccountIds.has(e.accountId);
        const isIncome = incomeAccountIds.has(e.accountId);
        if (!isExpense && !isIncome) continue;
        // Expense: debit (negative entry) increases spend -> positive; credit (positive entry,
        // e.g. a reimbursement) reduces it -> negative. Income: credit (positive) increases
        // earned -> positive; debit (negative, e.g. a reversed/bounced payment) reduces it.
        const line: SpendLine = {
          key: `${t.guid}-${e.accountId}`,
          date: t.date,
          voucherType: t.type,
          voucherNumber: t.number,
          narration: t.narration,
          accountName: accountName.get(e.accountId) ?? "Unknown",
          amount: isExpense ? -e.amount : e.amount,
        };
        (isExpense ? expense : income).push(line);
      }
    }
    expense.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    income.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    return { expenseLines: expense, incomeLines: income };
  }, [data.transactions, startDate, endDate, expenseAccountIds, incomeAccountIds, accountName]);

  const totalExpense = expenseLines.reduce((s, l) => s + l.amount, 0);
  const totalIncome = incomeLines.reduce((s, l) => s + l.amount, 0);
  const net = totalIncome - totalExpense;

  const byCategory = (lines: SpendLine[]) => {
    const map = new Map<string, number>();
    for (const l of lines) map.set(l.accountName, (map.get(l.accountName) ?? 0) + l.amount);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  };
  const expenseByCategory = useMemo(() => byCategory(expenseLines), [expenseLines]);
  const incomeByCategory = useMemo(() => byCategory(incomeLines), [incomeLines]);

  // "Last N days" ending today; a single specific day sets both ends to that same date.
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
              Postings to Expense and Income category ledgers over any date range you pick -- independent of the
              header's Financial period selector, so you can check an arbitrary window (a trip, a week, a
              month-to-date) at day-level precision. Transfers, contras, and journals are excluded either way. A
              refund or reimbursement against either category (e.g. a Receipt crediting an Expense ledger) reduces
              the total instead of being left out.
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
            await exportWorkbook(`Spend Report ${startDate} to ${endDate}.xlsx`, [
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

export function SpendSection({
  title,
  lines,
  byCategory,
  total,
  fmt,
  color,
  emptyLabel,
}: {
  title: string;
  lines: SpendLine[];
  byCategory: [string, number][];
  total: number;
  fmt: (n: number) => string;
  color: string;
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Which category's card was clicked, if any -- opens a floating drill-down window scoped to
  // just that category's lines, separate from the "Show N vouchers" button above (which still
  // shows the whole section).
  const [drilldown, setDrilldown] = useState<string | null>(null);
  // Largest category in this section sets the 100% reference -- byCategory is already sorted
  // descending, so it's just the first entry. A refund-heavy category with a negative total gets
  // no fill (0%) rather than a visually meaningless negative-width bar.
  const maxAmt = byCategory[0]?.[1] ?? 0;
  const drilldownLines = drilldown ? lines.filter((l) => l.accountName === drilldown) : [];
  const drilldownTotal = drilldown ? drilldownLines.reduce((s, l) => s + l.amount, 0) : 0;
  return (
    <div style={{ marginBottom: 20 }}>
      <h4 style={{ margin: "0 0 6px" }}>{title}</h4>
      {lines.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6 }}>No {emptyLabel} postings in this range.</p>
      ) : (
        <>
          <div className="spend-category-grid">
            {byCategory.map(([name, amt]) => {
              const pct = maxAmt > 0 ? Math.max(0, Math.min(100, (amt / maxAmt) * 100)) : 0;
              return (
                <button
                  type="button"
                  key={name}
                  className="spend-category-chip"
                  title={`${name}: ${fmt(amt)} — click for detail`}
                  onClick={() => setDrilldown(name)}
                >
                  <span className="spend-category-chip-fill" style={{ width: `${pct}%`, background: color }} />
                  <span className="spend-category-chip-text">
                    <b>{name}</b>
                    <em>{fmt(amt)}</em>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="button" className="tr-refresh-btn" onClick={() => setExpanded((v) => !v)} style={{ marginBottom: 8 }}>
            {expanded ? "Hide vouchers" : `Show ${lines.length} voucher${lines.length !== 1 ? "s" : ""}`}
          </button>
          {expanded && <SpendVoucherTable lines={lines} total={total} fmt={fmt} color={color} />}
          {drilldown && (
            <FloatingWindow title={`${drilldown} — ${fmt(drilldownTotal)}`} onClose={() => setDrilldown(null)} wide>
              <SpendVoucherTable lines={drilldownLines} total={drilldownTotal} fmt={fmt} color={color} hideAccountColumn />
            </FloatingWindow>
          )}
        </>
      )}
    </div>
  );
}

// Shared by SpendSection's "Show N vouchers" (whole section) and its per-category drill-down
// popup (see SpendSection above) -- same table, just a different `lines` slice.
function SpendVoucherTable({
  lines,
  total,
  fmt,
  color,
  hideAccountColumn,
}: {
  lines: SpendLine[];
  total: number;
  fmt: (n: number) => string;
  color: string;
  hideAccountColumn?: boolean;
}) {
  const showSource = lines.some((l) => l.source);
  return (
    <table className="fx-ledger-table">
      <thead>
        <tr>
          <th>Date</th>
          {showSource && <th>Src</th>}
          <th>Voucher</th>
          {!hideAccountColumn && <th>Account</th>}
          <th className="fx-narration">Narration</th>
          <th className="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <td>{fmtDate(l.date)}</td>
            {showSource && (
              <td>
                {l.source && <span className={`source-badge source-${l.source.toLowerCase()}`}>{l.source}</span>}
              </td>
            )}
            <td>
              {l.voucherType} {l.voucherNumber}
            </td>
            {!hideAccountColumn && <td>{l.accountName}</td>}
            <td className="fx-narration" title={l.narration}>
              {l.narration || "—"}
            </td>
            <td className="right" style={l.amount < 0 ? { color: "#6b7280" } : undefined} title={l.amount < 0 ? "Refund / reversal — reduces the total" : undefined}>
              {fmt(l.amount)}
              {l.source === "US" && l.originalAmountUsd != null && l.appliedRate != null && (
                <small className="gr-usd-hint">
                  ${l.originalAmountUsd.toFixed(2)} @ {l.appliedRate.toFixed(2)}
                </small>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={(hideAccountColumn ? 3 : 4) + (showSource ? 1 : 0)}>Total</td>
          <td className="right" style={{ color }}>
            {fmt(total)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
