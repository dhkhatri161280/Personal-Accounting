"use client";
import { useState } from "react";
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
}: {
  title: string;
  rows: ReportRow[];
  link: (a: ReportRow) => React.ReactNode;
  fmt: (n: number) => string;
  kind: "in" | "out";
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
  const grand = rows.reduce((s, a) => s + a.closing, 0);

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
}: {
  title1: string;
  rows1: ReportRow[];
  title2: string;
  rows2: ReportRow[];
  link: (a: ReportRow) => React.ReactNode;
  fmt: (n: number) => string;
}) {
  return (
    <div className="report-grid">
      <GroupColumn title={title1} rows={rows1} link={link} fmt={fmt} kind="out" />
      <GroupColumn title={title2} rows={rows2} link={link} fmt={fmt} kind="in" />
    </div>
  );
}
