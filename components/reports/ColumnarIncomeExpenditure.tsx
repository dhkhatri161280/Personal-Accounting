"use client";
import { useEffect, useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";
import { periodBoundariesForRange, trimToLatestActivity, buildIncomeExpenseColumns, type ColumnarRow, type PeriodBoundary } from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll, computeColumnarWidths, type DrilldownRequest } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

export function ColumnarIncomeExpenditure({
  data,
  start,
  end,
  granularity,
  fmt,
  onComputed,
  onDrilldown,
  expandSignal,
  collapseSignal,
}: {
  data: Ledger;
  start: string;
  end: string;
  granularity: "monthly" | "quarterly";
  fmt: (n: number) => string;
  onComputed?: (periods: PeriodBoundary[], incomeRows: ColumnarRow[], expenseRows: ColumnarRow[]) => void;
  onDrilldown?: (req: DrilldownRequest) => void;
  // Owned by the caller and rendered on the existing toolbar row -- see the matching comment in
  // ColumnarBalanceSheet.tsx.
  expandSignal?: number;
  collapseSignal?: number;
}) {
  const periods = useMemo(() => trimToLatestActivity(periodBoundariesForRange(start, end, granularity), data), [start, end, granularity, data]);
  const { incomeRows, expenseRows } = useMemo(() => buildIncomeExpenseColumns(data, periods), [data, periods]);

  useEffect(() => {
    onComputed?.(periods, incomeRows, expenseRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, incomeRows, expenseRows]);

  const incomeTotals = periods.map((p) => incomeRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const expenseTotals = periods.map((p) => expenseRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const surplusByPeriod = incomeTotals.map((v, i) => v - expenseTotals[i]);
  const surplusTotal = surplusByPeriod.reduce((s, v) => s + v, 0);
  const [sIncome, sExpense, sNet] = useSyncedScroll(3);
  const netRowLabel = "Surplus / (Deficit)";
  const { labelWidth, valueWidth } = useMemo(
    () =>
      computeColumnarWidths(
        [
          { title: "Income", rows: incomeRows },
          { title: "Expense", rows: expenseRows },
        ],
        [{ label: netRowLabel, values: surplusByPeriod, total: surplusTotal }],
        periods,
        fmt
      ),
    [incomeRows, expenseRows, surplusByPeriod, surplusTotal, periods, fmt]
  );

  return (
    <div className="columnar-report">
      <ColumnarSection title="Income" rows={incomeRows} periods={periods} fmt={fmt} color={MONEY_IN} scrollRef={sIncome.ref} onScroll={sIncome.onScroll} onDrilldown={onDrilldown} labelWidth={labelWidth} valueWidth={valueWidth} expandSignal={expandSignal} collapseSignal={collapseSignal} />
      <ColumnarSection title="Expense" rows={expenseRows} periods={periods} fmt={fmt} color={MONEY_OUT} scrollRef={sExpense.ref} onScroll={sExpense.onScroll} onDrilldown={onDrilldown} labelWidth={labelWidth} valueWidth={valueWidth} expandSignal={expandSignal} collapseSignal={collapseSignal} />
      <ColumnarNetRow
        label={netRowLabel}
        values={surplusByPeriod}
        total={surplusTotal}
        periods={periods}
        fmt={fmt}
        colorOf={(v) => (v >= 0 ? MONEY_IN : MONEY_OUT)}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
      />
    </div>
  );
}
