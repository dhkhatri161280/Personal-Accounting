"use client";
import { useEffect, useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";
import { periodBoundaries, trimToLatestActivity, buildCashFlowColumns, type ColumnarRow, type PeriodBoundary } from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

// Tally convention: Inflows on top, Outflows on bottom.
export function ColumnarCashFlow({
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
  onComputed?: (periods: PeriodBoundary[], inflowRows: ColumnarRow[], outflowRows: ColumnarRow[]) => void;
}) {
  const periods = useMemo(() => trimToLatestActivity(periodBoundaries(fy, granularity), data), [fy, granularity, data]);
  const { inflowRows, outflowRows, closingByPeriod } = useMemo(() => buildCashFlowColumns(data, periods), [data, periods]);

  useEffect(() => {
    onComputed?.(periods, inflowRows, outflowRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, inflowRows, outflowRows]);

  const inflowTotals = periods.map((p) => inflowRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const outflowTotals = periods.map((p) => outflowRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const netByPeriod = inflowTotals.map((v, i) => v - outflowTotals[i]);
  const netTotal = netByPeriod.reduce((s, v) => s + v, 0);
  const closingValues = periods.map((p) => closingByPeriod[p.key] || 0);
  const lastClosing = closingValues[closingValues.length - 1] || 0;
  const [sIn, sOut, sNet, sClosing] = useSyncedScroll(4);

  return (
    <div className="columnar-report">
      <ColumnarSection title="Cash Inflows" rows={inflowRows} periods={periods} fmt={fmt} color={MONEY_IN} scrollRef={sIn.ref} onScroll={sIn.onScroll} />
      <ColumnarSection title="Cash Outflows" rows={outflowRows} periods={periods} fmt={fmt} color={MONEY_OUT} scrollRef={sOut.ref} onScroll={sOut.onScroll} />
      <ColumnarNetRow
        label="Net increase / (decrease) in cash"
        values={netByPeriod}
        total={netTotal}
        periods={periods}
        fmt={fmt}
        colorOf={(v) => (v >= 0 ? MONEY_IN : MONEY_OUT)}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
      />
      <ColumnarNetRow
        label="Closing cash and bank balance"
        values={closingValues}
        total={lastClosing}
        periods={periods}
        fmt={fmt}
        colorOf={() => "#1e40af"}
        scrollRef={sClosing.ref}
        onScroll={sClosing.onScroll}
      />
    </div>
  );
}
