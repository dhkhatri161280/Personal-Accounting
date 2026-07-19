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

function GroupColumn({
  title,
  rows,
  link,
  fmt,
}: {
  title: string;
  rows: ReportRow[];
  link: (a: ReportRow) => React.ReactNode;
  fmt: (n: number) => string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = row.parent || row.category || "Other";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const grand = rows.reduce((s, a) => s + Math.abs(a.closing), 0);

  return (
    <div className="data-panel grouped-report">
      <h3>{title}</h3>
      {sorted.map(([group, items]) => {
        const isE = expanded.has(group);
        const groupTotal = items.reduce((s, a) => s + Math.abs(a.closing), 0);
        return (
          <section className="report-group" key={group}>
            <button className="group-heading" onClick={() => toggle(group)}>
              <span className="bs-arr">{isE ? "-" : "+"}</span>
              <strong>{group}</strong>
              <span>{fmt(groupTotal)}</span>
            </button>
            {isE &&
              items
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <div className="report-line" key={a.id}>
                    {link(a)}
                    <strong>{fmt(Math.abs(a.closing))}</strong>
                  </div>
                ))}
          </section>
        );
      })}
      <div className="report-grand">
        <span>Total {title}</span>
        <strong>{fmt(grand)}</strong>
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
      <GroupColumn title={title1} rows={rows1} link={link} fmt={fmt} />
      <GroupColumn title={title2} rows={rows2} link={link} fmt={fmt} />
    </div>
  );
}
