"use client";
import { useEffect, useMemo, useState } from "react";
import type React from "react";

interface ReportRow {
  id: number;
  name: string;
  parent?: string;
  category?: string;
  closing: number;
}

// Same green/red "money in vs. money out" convention used app-wide (Net Worth, Trading,
// Reconciliation, Tax report, voucher From/To) -- income is green, expenditure is red.
const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

function GroupColumn({
  title,
  rows,
  link,
  fmt,
  kind,
  expandSignal,
  collapseSignal,
  balancingRow,
}: {
  title: string;
  rows: ReportRow[];
  link: (a: ReportRow) => React.ReactNode;
  fmt: (n: number) => string;
  kind: "in" | "out";
  expandSignal?: number;
  collapseSignal?: number;
  // The shortfall side's own "Net Gain/Loss transferred to Capital" line -- same Tally-style
  // balancing convention components/reports/BalanceSheetReport.tsx already uses for its own
  // Profit & Loss A/c line (confirmed live: the user specifically wants this report to match that
  // same convention instead of leaving Total Expenditure and Total Income as two unequal, un-
  // reconciled figures). Lands on whichever side is naturally smaller, colored green for a gain
  // and red for a loss, not by which column (Expenditure/Income) it happens to render in.
  balancingRow?: { label: string; amount: number; color: string };
}) {
  const color = kind === "in" ? MONEY_IN : MONEY_OUT;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  // A line's `closing` is already signed so that the column's *expected* direction is positive
  // (Expense column: Dr-heavy = positive; Income column: Cr-heavy = positive) -- see
  // periodExpenseRows/periodIncomeRows in VaultApp.tsx. A negative closing here is a real contra
  // movement (e.g. an Income-nature account that was net-debited more than credited this period)
  // and must be shown as negative, not silently flipped positive -- taking Math.abs() before
  // display was masking exactly that case (confirmed against Fund Summary, which shows the same
  // account's true signed value for the same period).
  const contraColor = kind === "in" ? MONEY_OUT : MONEY_IN;
  const colorFor = (value: number) => (value >= 0 ? color : contraColor);

  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = row.parent || row.category || "Other";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const grand = rows.reduce((s, a) => s + a.closing, 0) + (balancingRow?.amount ?? 0);
  const groupKeys = useMemo(() => [...groups.keys()], [rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (expandSignal) setExpanded(new Set(groupKeys));
  }, [expandSignal]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (collapseSignal) setExpanded(new Set());
  }, [collapseSignal]);

  return (
    <div className="data-panel grouped-report">
      <h3>{title}</h3>
      {sorted.map(([group, items]) => {
        const isE = expanded.has(group);
        const groupTotal = items.reduce((s, a) => s + a.closing, 0);
        return (
          <section className="report-group" key={group}>
            <button className="group-heading" onClick={() => toggle(group)}>
              <span className="bs-arr">{isE ? "-" : "+"}</span>
              <strong>{group}</strong>
              <span style={{ color: colorFor(groupTotal) }}>{fmt(groupTotal)}</span>
            </button>
            {isE &&
              items
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <div className="report-line" key={a.id}>
                    {link(a)}
                    <strong style={{ color: colorFor(a.closing) }}>{fmt(a.closing)}</strong>
                  </div>
                ))}
          </section>
        );
      })}
      {balancingRow && (
        <div className="report-line report-line--balancing">
          <span>{balancingRow.label}</span>
          <strong style={{ color: balancingRow.color }}>{fmt(balancingRow.amount)}</strong>
        </div>
      )}
      <div className="report-grand">
        <span>Total {title}</span>
        <strong style={{ color: colorFor(grand) }}>{fmt(grand)}</strong>
      </div>
    </div>
  );
}

export function GroupedReport({
  title1,
  rows1,
  title2,
  rows2,
  link,
  fmt,
  expandSignal,
  collapseSignal,
  showBalancingLine,
}: {
  title1: string;
  rows1: ReportRow[];
  title2: string;
  rows2: ReportRow[];
  link: (a: ReportRow) => React.ReactNode;
  fmt: (n: number) => string;
  // Owned by the caller and rendered on the existing toolbar row -- see the matching comment in
  // ColumnarBalanceSheet.tsx.
  expandSignal?: number;
  collapseSignal?: number;
  // Adds a Tally-style "Net Gain/Loss transferred to Capital" line to whichever column (rows1 =
  // "out" side, rows2 = "in" side) is naturally smaller, so Total title1 and Total title2 always
  // land on the same figure instead of two unreconciled totals -- the same balancing convention
  // components/reports/BalanceSheetReport.tsx's own Profit & Loss A/c line already uses, and the
  // same thing Tally's own classic Trading & P&L account format does. Off by default: GroupedReport
  // is a generic two-column component, and "balancing to equal totals" only makes sense for an
  // Income & Expenditure-shaped pair of columns, not every caller.
  showBalancingLine?: boolean;
}) {
  const total1 = rows1.reduce((s, a) => s + a.closing, 0);
  const total2 = rows2.reduce((s, a) => s + a.closing, 0);
  // Positive = rows2 (income) exceeds rows1 (expenditure) -- a gain. Negative = a loss.
  const net = total2 - total1;
  const balancing = showBalancingLine && Math.abs(net) > 0.005
    ? net >= 0
      ? { side: 1 as const, row: { label: "Net Gain transferred to Capital", amount: net, color: MONEY_IN } }
      : { side: 2 as const, row: { label: "Net Loss transferred to Capital", amount: -net, color: MONEY_OUT } }
    : null;
  return (
    <div className="report-grid">
      <GroupColumn title={title1} rows={rows1} link={link} fmt={fmt} kind="out" expandSignal={expandSignal} collapseSignal={collapseSignal} balancingRow={balancing?.side === 1 ? balancing.row : undefined} />
      <GroupColumn title={title2} rows={rows2} link={link} fmt={fmt} kind="in" expandSignal={expandSignal} collapseSignal={collapseSignal} balancingRow={balancing?.side === 2 ? balancing.row : undefined} />
    </div>
  );
}
