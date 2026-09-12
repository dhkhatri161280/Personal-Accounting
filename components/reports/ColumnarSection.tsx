"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ColumnarRow, PeriodBoundary } from "@/lib/columnar-report";
import { measureTextWidth } from "@/lib/text-measure";

// Excel-style auto-fit for a whole columnar report GROUP (e.g. Balance Sheet's Assets section +
// Liabilities section + Balance Check row -- 3 separate <table> elements that must render at
// IDENTICAL widths to stay aligned, per ColumnarSection/ColumnarNetRow below). Computed ONCE
// across every row/label/value that will appear in ANY of those tables, then applied identically
// to all of them via labelWidth/valueWidth props -- content-aware sizing (a long label actually
// widens the column instead of wrapping to 2 lines) without losing cross-table alignment, since
// every table receives the exact same two numbers regardless of its own individual content.
// 900 weight matches the heaviest actual render weight (.shell table tfoot th forces
// font-weight: 900 !important on "Total X"/net-row labels and totals) -- measuring at the
// heaviest weight in use guarantees we never UNDER-measure a label/value that's actually bold.
const LABEL_FONT = "900 11px var(--font-sans), Arial, sans-serif";
const VALUE_FONT = "900 11px var(--font-sans), Arial, sans-serif";
const LEAF_INDENT = 26; // matches .columnar-ledger-name's own padding-left
const CELL_PADDING = 24; // matches td/th's 10px horizontal padding on both sides + a little room
const MIN_LABEL_WIDTH = 220;
const MIN_VALUE_WIDTH = 90;

export function computeColumnarWidths(
  groups: { title: string; rows: ColumnarRow[] }[],
  netRows: { label: string; values: number[]; total: number }[],
  periods: PeriodBoundary[],
  fmt: (n: number) => string
): { labelWidth: number; valueWidth: number } {
  let maxLabel = 0;
  let maxValue = 0;
  const bumpLabel = (text: string, indent = 0) => {
    maxLabel = Math.max(maxLabel, measureTextWidth(text, LABEL_FONT) + indent);
  };
  const bumpValue = (n: number) => {
    maxValue = Math.max(maxValue, measureTextWidth(fmt(n), VALUE_FONT));
  };

  for (const g of groups) {
    bumpLabel(`Total ${g.title}`);
    const groupNames = new Set<string>();
    for (const r of g.rows) {
      bumpLabel(r.name, LEAF_INDENT);
      groupNames.add(r.parent || r.category || "Other");
      for (const p of periods) bumpValue(r.values[p.key] || 0);
      bumpValue(r.total);
    }
    for (const name of groupNames) bumpLabel(name);
    for (const p of periods) bumpValue(g.rows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
    bumpValue(g.rows.reduce((s, r) => s + r.total, 0));
  }
  for (const n of netRows) {
    bumpLabel(n.label);
    for (const v of n.values) bumpValue(v);
    bumpValue(n.total);
  }

  return {
    labelWidth: Math.max(MIN_LABEL_WIDTH, Math.ceil(maxLabel) + CELL_PADDING),
    valueWidth: Math.max(MIN_VALUE_WIDTH, Math.ceil(maxValue) + CELL_PADDING),
  };
}

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

// Drives a report's "Expand All"/"Collapse All" buttons. Exposes two monotonically-increasing
// counters (not booleans) so clicking the same button twice in a row -- e.g. Expand All after a
// user already hand-expanded then hand-collapsed one group -- still fires the effect that resets
// every ColumnarSection's expanded-groups state; a boolean toggling true->true wouldn't.
export function useExpandCollapseAll() {
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);
  return {
    expandSignal,
    collapseSignal,
    expandAll: () => setExpandSignal((s) => s + 1),
    collapseAll: () => setCollapseSignal((s) => s + 1),
  };
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
  labelWidth,
  valueWidth,
  expandSignal,
  collapseSignal,
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
  // Excel-style auto-fit, computed ONCE across the whole report group (see computeColumnarWidths
  // above) and applied identically to every stacked table so they stay aligned -- falls back to
  // the plain CSS defaults (220px/110px) when a caller doesn't pass them.
  labelWidth?: number;
  valueWidth?: number;
  // Bumped by the report's "Expand All"/"Collapse All" buttons (see ColumnarBalanceSheet etc.) --
  // a plain boolean can't retrigger the effect on repeated clicks of the same button, so the
  // caller increments a counter instead. Undefined/0 on mount means neither has fired yet.
  expandSignal?: number;
  collapseSignal?: number;
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
  const groupKeys = useMemo(() => [...groups.keys()], [rows]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (expandSignal) setExpanded(new Set(groupKeys));
  }, [expandSignal]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (collapseSignal) setExpanded(new Set());
  }, [collapseSignal]);
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
        <table
          className="columnar-report-table"
          style={
            labelWidth || valueWidth
              ? { width: (labelWidth || 0) + (valueWidth || 0) * (periods.length + 1) }
              : undefined
          }
        >
          {(labelWidth || valueWidth) && (
            <colgroup>
              <col style={{ width: labelWidth }} />
              {periods.map((p) => (
                <col key={p.key} style={{ width: valueWidth }} />
              ))}
              <col style={{ width: valueWidth }} />
            </colgroup>
          )}
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
  labelWidth,
  valueWidth,
}: {
  label: string;
  values: number[];
  total: number;
  periods: PeriodBoundary[];
  fmt: (n: number) => string;
  colorOf: (n: number) => string;
  scrollRef?: (el: HTMLDivElement | null) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  labelWidth?: number;
  valueWidth?: number;
}) {
  return (
    // "grouped-report" matches ColumnarSection's own wrapper class above -- without it, this
    // panel keeps .data-panel's default 18px padding while ColumnarSection's zeroes it out (see
    // .grouped-report in globals.css), leaving this row's table ~36px narrower than the Assets/
    // Liabilities tables stacked above it and visibly out of alignment despite identical columns.
    <div className="data-panel grouped-report columnar-report-section">
      <div className="columnar-report-scroll" ref={scrollRef} onScroll={onScroll}>
        <table
          className="columnar-report-table"
          style={
            labelWidth || valueWidth
              ? { width: (labelWidth || 0) + (valueWidth || 0) * (periods.length + 1) }
              : undefined
          }
        >
          {(labelWidth || valueWidth) && (
            <colgroup>
              <col style={{ width: labelWidth }} />
              {periods.map((p) => (
                <col key={p.key} style={{ width: valueWidth }} />
              ))}
              <col style={{ width: valueWidth }} />
            </colgroup>
          )}
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
