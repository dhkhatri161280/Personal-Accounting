"use client";
import { useEffect, useMemo } from "react";
import { type GrLedger, type GrAccount, buildGrCashFlowColumns, trimGrToLatestActivity } from "@/lib/gr-consolidation";
import { periodBoundariesForRange, type ColumnarRow, type PeriodBoundary } from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll, computeColumnarWidths } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

// GR Books' own sibling of components/reports/ColumnarCashFlow.tsx (US/India) -- same JSX shape
// and Tally convention (Inflows on top, Outflows on bottom), built against GrLedger's name-keyed,
// dual-currency shape via buildGrCashFlowColumns instead of the numeric-id-keyed
// buildCashFlowColumns. No onDrilldown: GR's existing single-period Cash Flow is already
// read-only (its own onGroup/onLedger are both no-ops), so this periodic view stays consistent
// with that rather than introducing click-through only here.
export function ColumnarCashFlowGr({
  gr,
  bankCashAccounts,
  start,
  end,
  granularity,
  accountFilter = "",
  fmt,
  onComputed,
  expandSignal,
  collapseSignal,
}: {
  gr: GrLedger;
  bankCashAccounts: GrAccount[];
  start: string;
  end: string;
  granularity: "monthly" | "quarterly" | "yearly";
  accountFilter?: string;
  fmt: (n: number) => string;
  onComputed?: (periods: PeriodBoundary[], inflowRows: ColumnarRow[], outflowRows: ColumnarRow[]) => void;
  expandSignal?: number;
  collapseSignal?: number;
}) {
  const periods = useMemo(
    () => trimGrToLatestActivity(periodBoundariesForRange(start, end, granularity), gr),
    [start, end, granularity, gr]
  );
  const { inflowRows, outflowRows, closingByPeriod } = useMemo(
    () => buildGrCashFlowColumns(gr, periods, bankCashAccounts, accountFilter),
    [gr, periods, bankCashAccounts, accountFilter]
  );

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
  // Display only, same reasoning as ColumnarCashFlow: Yearly reads current-year-first,
  // Monthly/Quarterly stay chronological. `lastClosing`/the Total columns above are unaffected --
  // they're read from the ascending arrays before this reversal happens.
  const displayPeriods = granularity === "yearly" ? periods.slice().reverse() : periods;
  const displayNetByPeriod = granularity === "yearly" ? netByPeriod.slice().reverse() : netByPeriod;
  const displayClosingValues = granularity === "yearly" ? closingValues.slice().reverse() : closingValues;
  const [sIn, sOut, sNet, sClosing] = useSyncedScroll(4);
  const netRowLabel = "Net increase / (decrease) in cash";
  const closingRowLabel = "Closing cash and bank balance";
  const { labelWidth, valueWidth } = useMemo(
    () =>
      computeColumnarWidths(
        [
          { title: "Cash Inflows", rows: inflowRows },
          { title: "Cash Outflows", rows: outflowRows },
        ],
        [
          { label: netRowLabel, values: netByPeriod, total: netTotal },
          { label: closingRowLabel, values: closingValues, total: lastClosing },
        ],
        periods,
        fmt
      ),
    [inflowRows, outflowRows, netByPeriod, netTotal, closingValues, lastClosing, periods, fmt]
  );

  return (
    <div className="columnar-report">
      <ColumnarSection
        title="Cash Inflows"
        rows={inflowRows}
        periods={displayPeriods}
        fmt={fmt}
        color={MONEY_IN}
        scrollRef={sIn.ref}
        onScroll={sIn.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
      />
      <ColumnarSection
        title="Cash Outflows"
        rows={outflowRows}
        periods={displayPeriods}
        fmt={fmt}
        color={MONEY_OUT}
        scrollRef={sOut.ref}
        onScroll={sOut.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
      />
      <ColumnarNetRow
        label={netRowLabel}
        values={displayNetByPeriod}
        total={netTotal}
        periods={displayPeriods}
        fmt={fmt}
        colorOf={(v) => (v >= 0 ? MONEY_IN : MONEY_OUT)}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
      />
      <ColumnarNetRow
        label={closingRowLabel}
        values={displayClosingValues}
        total={lastClosing}
        periods={displayPeriods}
        fmt={fmt}
        colorOf={() => "#1e40af"}
        scrollRef={sClosing.ref}
        onScroll={sClosing.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
      />
    </div>
  );
}
