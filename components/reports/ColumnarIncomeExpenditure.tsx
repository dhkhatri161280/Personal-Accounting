"use client";
import { useEffect, useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";
import { periodBoundaries, trimToLatestActivity, buildIncomeExpenseColumns, type ColumnarRow, type PeriodBoundary } from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

export function ColumnarIncomeExpenditure({
  data,
  fy,
  granularity,
  fmt,
  onComputed,
}: {
  data: Ledger;
  fy: number;
  granularity: "monthly" | "quarterly";
  fmt: (n: number) => string;
  onComputed?: (periods: PeriodBoundary[], incomeRows: ColumnarRow[], expenseRows: ColumnarRow[]) => void;
}) {
  const periods = useMemo(() => trimToLatestActivity(periodBoundaries(fy, granularity), data), [fy, granularity, data]);
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

  return (
    <div className="columnar-report">
      <ColumnarSection title="Income" rows={incomeRows} periods={periods} fmt={fmt} color={MONEY_IN} scrollRef={sIncome.ref} onScroll={sIncome.onScroll} />
      <ColumnarSection title="Expense" rows={expenseRows} periods={periods} fmt={fmt} color={MONEY_OUT} scrollRef={sExpense.ref} onScroll={sExpense.onScroll} />
      <ColumnarNetRow
        label="Surplus / (Deficit)"
        values={surplusByPeriod}
        total={surplusTotal}
        periods={periods}
        fmt={fmt}
        colorOf={(v) => (v >= 0 ? MONEY_IN : MONEY_OUT)}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
      />
    </div>
  );
}
