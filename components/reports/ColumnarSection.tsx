"use client";
import { Fragment, useRef, useState } from "react";
import type React from "react";
import type { ColumnarRow, PeriodBoundary } from "@/lib/columnar-report";

// Keeps every section's (and the net row's) horizontal scroll position in lockstep -- on mobile
// each table has its own scrollbar, so without this, scrolling the Income table right to see a
// far period leaves the Expense table (and the Surplus/Deficit row) still showing the left edge,
// and there's no way to compare the same period across sections. Call once per columnar report
// (3 tables: two sections + one net row) and spread the returned {ref, onScroll} pair onto each
// scroll container.
export function useSyncedScroll(count: number) {
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const syncing = useRef(false);
  const makeRef = (i: number) => (el: HTMLDivElement | null) => {
    els.current[i] = el;
  };
  const makeOnScroll = (i: number) => (e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current) return;
    syncing.current = true;
    const left = e.currentTarget.scrollLeft;
    for (let j = 0; j < count; j++) {
      const el = els.current[j];
      if (el && j !== i) el.scrollLeft = left;
    }
    syncing.current = false;
  };
  return Array.from({ length: count }, (_, i) => ({ ref: makeRef(i), onScroll: makeOnScroll(i) }));
}

// Zero cells are the majority in a monthly/quarterly grid (most ledgers only post in a few
// periods), so rendering "$0.00" everywhere buries the handful of real numbers. A plain dash
// (Tally's own convention, and the one the user asked for) reads as "nothing happened here"
// without competing visually with actual amounts.
const ZERO_TOL = 0.005;
function cell(v: number, fmt: (n: number) => string): string {
  return Math.abs(v) < ZERO_TOL ? "–" : fmt(v);
}

// What a clicked cell drills down to: the account(s) behind it, a human label for the modal
// title, and the date range that cell covers (a single period, or the whole displayed range for
// a Total/Closing column click).
export type DrilldownRequest = { label: string; accountIds: number[]; start: string; end: string };

// Shared by every columnar (monthly/quarterly) report -- Income & Expenditure, Balance Sheet,
// Cash Flow -- one collapsible group-by-parent table with a period column per header + Total.
export function ColumnarSection({
  title,
  rows,
  periods,
  fmt,
  color,
  totalLabel = "Total",
  groupOrder,
  scrollRef,
  onScroll,
  onDrilldown,
}: {
  title: string;
  rows: ColumnarRow[];
  periods: PeriodBoundary[];
  fmt: (n: number) => string;
  color: string;
  totalLabel?: string;
  groupOrder?: string[];
  scrollRef?: (el: HTMLDivElement | null) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onDrilldown?: (req: DrilldownRequest) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const groups = new Map<string, ColumnarRow[]>();
  for (const row of rows) {
    const key = row.parent || row.category || "Other";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const sorted = groupOrder
    ? [...groups.entries()].sort((a, b) => {
        const ia = groupOrder.indexOf(a[0]), ib = groupOrder.indexOf(b[0]);
        return (ia === -1 ? groupOrder.length : ia) - (ib === -1 ? groupOrder.length : ib);
      })
    : [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalsByPeriod = (items: ColumnarRow[]) => periods.map((p) => items.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const grandByPeriod = totalsByPeriod(rows);
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const fullRangeStart = periods[0]?.start, fullRangeEnd = periods[periods.length - 1]?.end;

  const Cell = ({ v, accountIds, label, period }: { v: number; accountIds: number[]; label: string; period?: PeriodBoundary }) =>
    onDrilldown ? (
      <button
        type="button"
        className="columnar-cell-btn"
        onClick={() =>
          onDrilldown({
            label,
            accountIds,
            start: period ? period.start : fullRangeStart,
            end: period ? period.end : fullRangeEnd,
          })
        }
      >
        {cell(v, fmt)}
      </button>
    ) : (
      <>{cell(v, fmt)}</>
    );

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <h3>{title}</h3>
      <div className="columnar-report-scroll" ref={scrollRef} onScroll={onScroll}>
        <table className="columnar-report-table">
          <thead>
            <tr>
              <th></th>
              {periods.map((p) => (
                <th className="right" key={p.key}>
                  {p.label}
                </th>
              ))}
              <th className="right">{totalLabel}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([group, items]) => {
              const isE = expanded.has(group);
              const groupTotals = totalsByPeriod(items);
              const groupTotal = items.reduce((s, r) => s + r.total, 0);
              const groupAccountIds = items.map((r) => r.id);
              return (
                <Fragment key={group}>
                  <tr className="columnar-group-row">
                    <td>
                      <button type="button" className="group-heading" onClick={() => toggle(group)}>
                        <span className="bs-arr">{isE ? "-" : "+"}</span>
                        <strong>{group}</strong>
                      </button>
                    </td>
                    {groupTotals.map((v, i) => (
                      <td className="right" key={periods[i].key} style={{ color }}>
                        <Cell v={v} accountIds={groupAccountIds} label={`${group} — ${periods[i].label}`} period={periods[i]} />
                      </td>
                    ))}
                    <td className="right" style={{ color }}>
                      <strong>
                        <Cell v={groupTotal} accountIds={groupAccountIds} label={`${group} — ${totalLabel}`} />
                      </strong>
                    </td>
                  </tr>
                  {isE &&
                    items
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((r) => (
                        <tr className="columnar-ledger-row" key={r.id}>
                          <td className="columnar-ledger-name">{r.name}</td>
                          {periods.map((p) => (
                            <td className="right" key={p.key}>
                              <Cell v={r.values[p.key] || 0} accountIds={[r.id]} label={`${r.name} — ${p.label}`} period={p} />
                            </td>
                          ))}
                          <td className="right">
                            <strong>
                              <Cell v={r.total} accountIds={[r.id]} label={`${r.name} — ${totalLabel}`} />
                            </strong>
                          </td>
                        </tr>
                      ))}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total {title}</th>
              {grandByPeriod.map((v, i) => (
                <th className="right" key={periods[i].key} style={{ color }}>
                  <Cell
                    v={v}
                    accountIds={rows.map((r) => r.id)}
                    label={`Total ${title} — ${periods[i].label}`}
                    period={periods[i]}
                  />
                </th>
              ))}
              <th className="right" style={{ color }}>
                <Cell v={grandTotal} accountIds={rows.map((r) => r.id)} label={`Total ${title} — ${totalLabel}`} />
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// A single-row footer table (Surplus/Deficit, Net cash change, Balance check) -- the bottom line
// of a columnar report, one value per period + a total/closing column.
export function ColumnarNetRow({
  label,
  values,
  total,
  periods,
  fmt,
  colorOf,
  scrollRef,
  onScroll,
}: {
  label: string;
  values: number[];
  total: number;
  periods: PeriodBoundary[];
  fmt: (n: number) => string;
  colorOf: (n: number) => string;
  scrollRef?: (el: HTMLDivElement | null) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="data-panel columnar-report-section">
      <div className="columnar-report-scroll" ref={scrollRef} onScroll={onScroll}>
        <table className="columnar-report-table">
          <tfoot>
            <tr>
              <th>{label}</th>
              {values.map((v, i) => (
                <th className="right" key={periods[i].key} style={{ color: colorOf(v) }}>
                  {fmt(v)}
                </th>
              ))}
              <th className="right" style={{ color: colorOf(total) }}>
                {fmt(total)}
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
