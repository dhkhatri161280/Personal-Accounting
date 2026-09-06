"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Budget, BudgetLine, Ledger } from "@/lib/vault-types";
import { budgetVsActualRows, generateBudgetFromActuals, type BudgetRow } from "@/lib/budget";
import type { PeriodBoundary } from "@/lib/columnar-report";
import type { DrilldownRequest } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";
const ZERO_TOL = 0.005;

function cell(v: number, fmt: (n: number) => string): string {
  return Math.abs(v) < ZERO_TOL ? "–" : fmt(v);
}

// Income: actual above budget is favorable (more money in). Expense: actual above budget is
// unfavorable (overspent) -- same "money in vs money out" color convention as the rest of the app.
function varianceColor(v: number, kind: "in" | "out"): string | undefined {
  if (Math.abs(v) < ZERO_TOL) return undefined;
  const favorable = kind === "in" ? v >= 0 : v <= 0;
  return favorable ? MONEY_IN : MONEY_OUT;
}

function BudgetSection({
  title,
  kind,
  rows,
  periods,
  fmt,
  editing,
  expanded,
  onToggleExpand,
  onEditCell,
  onDrilldown,
}: {
  title: string;
  kind: "in" | "out";
  rows: BudgetRow[];
  periods: PeriodBoundary[];
  fmt: (n: number) => string;
  editing: boolean;
  expanded: Set<number>;
  onToggleExpand: (id: number) => void;
  onEditCell: (accountId: number, monthIndex: number, value: number) => void;
  onDrilldown?: (req: DrilldownRequest) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) =>
    setOpenGroups((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const groups = new Map<string, BudgetRow[]>();
  for (const row of rows) {
    const key = row.parent || row.category || "Other";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sum = (items: BudgetRow[], field: "totalBudget" | "totalActual") => items.reduce((s, r) => s + r[field], 0);
  const grandBudget = sum(rows, "totalBudget"), grandActual = sum(rows, "totalActual");
  const grandVariance = grandActual - grandBudget;

  const rangeStart = periods[0]?.start, rangeEnd = periods[periods.length - 1]?.end;
  const drill = (label: string, accountIds: number[]) => () =>
    onDrilldown?.({ label, accountIds, start: rangeStart, end: rangeEnd });

  return (
    <div className="data-panel grouped-report columnar-report-section budget-section">
      <h3>{title}</h3>
      <div className="columnar-report-scroll">
        <table className="columnar-report-table budget-table">
          <thead>
            <tr>
              <th></th>
              <th className="right">Budget</th>
              <th className="right">Actual</th>
              <th className="right">Variance</th>
              <th className="right">Variance %</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([group, items]) => {
              const isE = openGroups.has(group);
              const gBudget = sum(items, "totalBudget"), gActual = sum(items, "totalActual"), gVar = gActual - gBudget;
              return (
                <Fragment key={group}>
                  <tr className="columnar-group-row">
                    <td>
                      <button type="button" className="group-heading" onClick={() => toggleGroup(group)}>
                        <span className="bs-arr">{isE ? "-" : "+"}</span>
                        <strong>{group}</strong>
                      </button>
                    </td>
                    <td className="right">{cell(gBudget, fmt)}</td>
                    <td className="right">
                      {onDrilldown ? (
                        <button type="button" className="columnar-cell-btn" onClick={drill(`${group} — Actual`, items.map((r) => r.id))}>
                          {cell(gActual, fmt)}
                        </button>
                      ) : (
                        cell(gActual, fmt)
                      )}
                    </td>
                    <td className="right" style={{ color: varianceColor(gVar, kind) }}>
                      {cell(gVar, fmt)}
                    </td>
                    <td className="right" style={{ color: varianceColor(gVar, kind) }}>
                      {Math.abs(gBudget) > ZERO_TOL ? `${((gVar / gBudget) * 100).toFixed(0)}%` : "–"}
                    </td>
                  </tr>
                  {isE &&
                    items.map((r) => {
                      const rowExpanded = expanded.has(r.id);
                      return (
                        <Fragment key={r.id}>
                          <tr className="columnar-ledger-row">
                            <td className="columnar-ledger-name">
                              <button type="button" className="group-heading" onClick={() => onToggleExpand(r.id)}>
                                <span className="bs-arr">{rowExpanded ? "-" : "+"}</span>
                                {r.name}
                              </button>
                            </td>
                            <td className="right">{cell(r.totalBudget, fmt)}</td>
                            <td className="right">
                              {onDrilldown ? (
                                <button type="button" className="columnar-cell-btn" onClick={drill(`${r.name} — Actual`, [r.id])}>
                                  {cell(r.totalActual, fmt)}
                                </button>
                              ) : (
                                cell(r.totalActual, fmt)
                              )}
                            </td>
                            <td className="right" style={{ color: varianceColor(r.varianceAmt, kind) }}>
                              {cell(r.varianceAmt, fmt)}
                            </td>
                            <td className="right" style={{ color: varianceColor(r.varianceAmt, kind) }}>
                              {r.variancePct === null ? "–" : `${r.variancePct.toFixed(0)}%`}
                            </td>
                          </tr>
                          {rowExpanded && (
                            <tr className="budget-detail-row">
                              <td colSpan={5}>
                                <div className="columnar-report-scroll">
                                  <table className="columnar-report-table budget-detail-table">
                                    <thead>
                                      <tr>
                                        <th></th>
                                        {periods.map((p) => (
                                          <th className="right" key={p.key}>
                                            {p.label}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      <tr>
                                        <td>Budget</td>
                                        {periods.map((p, i) =>
                                          editing ? (
                                            <td className="right" key={p.key}>
                                              <input
                                                type="number"
                                                step="0.01"
                                                className="budget-cell-input"
                                                value={r.monthlyBudget[i] || ""}
                                                onChange={(e) => onEditCell(r.id, i, Number(e.target.value) || 0)}
                                              />
                                            </td>
                                          ) : (
                                            <td className="right" key={p.key}>
                                              {cell(r.monthlyBudget[i], fmt)}
                                            </td>
                                          )
                                        )}
                                      </tr>
                                      <tr>
                                        <td>Actual</td>
                                        {periods.map((p, i) => (
                                          <td className="right" key={p.key}>
                                            {onDrilldown ? (
                                              <button type="button" className="columnar-cell-btn" onClick={drill(`${r.name} — ${p.label}`, [r.id])}>
                                                {cell(r.monthlyActual[i], fmt)}
                                              </button>
                                            ) : (
                                              cell(r.monthlyActual[i], fmt)
                                            )}
                                          </td>
                                        ))}
                                      </tr>
                                      <tr>
                                        <td>Variance</td>
                                        {periods.map((p, i) => {
                                          const v = r.monthlyActual[i] - r.monthlyBudget[i];
                                          return (
                                            <td className="right" key={p.key} style={{ color: varianceColor(v, kind) }}>
                                              {cell(v, fmt)}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total {title}</th>
              <th className="right">{cell(grandBudget, fmt)}</th>
              <th className="right">
                {onDrilldown ? (
                  <button type="button" className="columnar-cell-btn" onClick={drill(`Total ${title} — Actual`, rows.map((r) => r.id))}>
                    {cell(grandActual, fmt)}
                  </button>
                ) : (
                  cell(grandActual, fmt)
                )}
              </th>
              <th className="right" style={{ color: varianceColor(grandVariance, kind) }}>
                {cell(grandVariance, fmt)}
              </th>
              <th className="right" style={{ color: varianceColor(grandVariance, kind) }}>
                {Math.abs(grandBudget) > ZERO_TOL ? `${((grandVariance / grandBudget) * 100).toFixed(0)}%` : "–"}
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function BudgetVsActual({
  data,
  fy,
  fmt,
  onSave,
  onDrilldown,
  onComputed,
  exporting,
  onExport,
}: {
  data: Ledger;
  fy: string | null; // null when the selected period isn't a plain fiscal year -- budgets need one
  fmt: (n: number) => string;
  onSave: (budget: Budget) => Promise<boolean> | boolean | void;
  onDrilldown?: (req: DrilldownRequest) => void;
  onComputed?: (periods: PeriodBoundary[], incomeRows: BudgetRow[], expenseRows: BudgetRow[]) => void;
  exporting?: boolean;
  onExport?: () => void;
}) {
  const savedBudget = useMemo(() => (fy ? data.budgets?.find((b) => b.fy === fy) : undefined), [data.budgets, fy]);
  const [editing, setEditing] = useState(false);
  const [draftLines, setDraftLines] = useState<BudgetLine[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    setEditing(false);
    setDraftLines(null);
    setExpanded(new Set());
  }, [fy]);

  // Memoized so `periods`/`incomeRows`/`expenseRows` keep a stable identity across renders that
  // don't actually change the inputs -- without this, the onComputed effect below (which lifts
  // this data up to VaultApp's state) would fire on every render, since VaultApp storing that
  // state triggers a re-render here too, recomputing fresh array references and firing again.
  const activeBudget = useMemo<Budget | undefined>(
    () =>
      fy && draftLines
        ? { fy, lines: draftLines, generatedFromFy: savedBudget?.generatedFromFy, updatedAt: savedBudget?.updatedAt ?? "" }
        : savedBudget,
    [fy, draftLines, savedBudget]
  );
  const { incomeRows, expenseRows, periods } = useMemo(
    () => (fy ? budgetVsActualRows(data, activeBudget, fy) : { incomeRows: [], expenseRows: [], periods: [] }),
    [data, activeBudget, fy]
  );

  useEffect(() => {
    if (fy) onComputed?.(periods, incomeRows, expenseRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy, periods, incomeRows, expenseRows]);

  if (!fy) {
    return (
      <div className="data-panel">
        <p style={{ opacity: 0.7 }}>
          Select a specific fiscal year (not &ldquo;All periods&rdquo;, a custom range, or a single month) to budget against.
        </p>
      </div>
    );
  }

  const priorFy = String(Number(fy) - 1);

  function startEditing() {
    setDraftLines(savedBudget ? savedBudget.lines.map((l) => ({ ...l, monthly: [...l.monthly] })) : []);
    setEditing(true);
  }

  function generateFromPriorYear() {
    if (savedBudget && !window.confirm(`Replace the current FY ${fy} budget with one generated from FY ${priorFy}'s actuals? Any manual edits will be lost.`)) return;
    setDraftLines(generateBudgetFromActuals(data, priorFy));
    setEditing(true);
  }

  function updateCell(accountId: number, monthIndex: number, value: number) {
    setDraftLines((prev) => {
      const lines = prev ? [...prev] : [];
      const idx = lines.findIndex((l) => l.accountId === accountId);
      if (idx === -1) {
        const monthly = periods.map(() => 0);
        monthly[monthIndex] = value;
        return [...lines, { id: `budget-${accountId}`, accountId, monthly }];
      }
      const monthly = [...lines[idx].monthly];
      monthly[monthIndex] = value;
      const next = [...lines];
      next[idx] = { ...lines[idx], monthly };
      return next;
    });
  }

  async function commitSave() {
    if (!draftLines) return;
    setSaving(true);
    const ok = await onSave({ fy: fy as string, lines: draftLines, generatedFromFy: savedBudget?.generatedFromFy, updatedAt: new Date().toISOString() });
    setSaving(false);
    if (ok !== false) {
      setEditing(false);
      setDraftLines(null);
    }
  }

  function cancelEditing() {
    setEditing(false);
    setDraftLines(null);
  }

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="columnar-report budget-vs-actual">
      <div className="report-view-toggle-row">
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {savedBudget ? `Budget saved ${new Date(savedBudget.updatedAt).toLocaleDateString()}` : "No budget saved yet for this fiscal year."}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          {!editing && (
            <button type="button" className="tr-refresh-btn" onClick={generateFromPriorYear}>
              {savedBudget ? `Regenerate from FY ${priorFy}` : `Generate from FY ${priorFy} actuals`}
            </button>
          )}
          {!editing && (
            <button type="button" className="tr-refresh-btn" onClick={startEditing}>
              Edit Budget
            </button>
          )}
          {editing && (
            <>
              <button type="button" className="tr-refresh-btn" onClick={cancelEditing} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="tr-refresh-btn" onClick={commitSave} disabled={saving}>
                {saving ? "Saving…" : "Save Budget"}
              </button>
            </>
          )}
          {!editing && onExport && (
            <button type="button" className="tr-refresh-btn" disabled={exporting} onClick={onExport}>
              {exporting ? "Exporting…" : "⬇ Export to Excel"}
            </button>
          )}
        </span>
      </div>
      <BudgetSection
        title="Income"
        kind="in"
        rows={incomeRows}
        periods={periods}
        fmt={fmt}
        editing={editing}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        onEditCell={updateCell}
        onDrilldown={onDrilldown}
      />
      <BudgetSection
        title="Expense"
        kind="out"
        rows={expenseRows}
        periods={periods}
        fmt={fmt}
        editing={editing}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        onEditCell={updateCell}
        onDrilldown={onDrilldown}
      />
    </div>
  );
}
