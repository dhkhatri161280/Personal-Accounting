"use client";
import { useEffect, useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";
import {
  periodBoundariesForRange,
  trimToLatestActivity,
  buildBalanceSheetColumns,
  BS_ASSET_ORDER,
  BS_LIABILITY_ORDER,
  type ColumnarRow,
  type PeriodBoundary,
} from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll, computeColumnarWidths, type DrilldownRequest } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

// Transforms cumulative closing-balance rows (the report's default Ending Balance view) into
// period-over-period deltas (the Incremental view) -- each column becomes "what moved during
// this period" instead of "the running balance as of this period's end". The first column still
// gets a true delta, not just its own closing value, via openingBeforeRange (the row's balance
// immediately before the first displayed period began) -- without it, the first column would
// misleadingly show the same number in both views. Total becomes the sum of every period's delta
// (the net change across the whole displayed range), matching how Income/Expense's own Total
// column already works, instead of repeating the final closing balance.
function toIncremental(rows: ColumnarRow[], periods: PeriodBoundary[]): ColumnarRow[] {
  return rows.map((r) => {
    const values: Record<string, number> = {};
    let total = 0;
    let prev = r.openingBeforeRange || 0;
    for (const p of periods) {
      const cur = r.values[p.key] || 0;
      const delta = cur - prev;
      values[p.key] = delta;
      total += delta;
      prev = cur;
    }
    return { ...r, values, total };
  });
}

// Tally convention: Assets on top, Liabilities & Equity on bottom. Unlike Income & Expenditure,
// each period's value is a cumulative closing balance (not a flow), so the last column is the
// true "as of today" balance and the Total column shows that same closing rather than a sum --
// see buildBalanceSheetColumns in lib/columnar-report.ts for why.
export function ColumnarBalanceSheet({
  data,
  start,
  end,
  granularity,
  fmt,
  viewMode = "ending",
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
  // Controlled by the caller (rendered alongside the Single Period/Monthly/Quarterly toggle, on
  // the same row, rather than as a second toggle row owned by this component) -- see
  // toIncremental below for what "incremental" actually does to the rows.
  viewMode?: "ending" | "incremental";
  onComputed?: (periods: PeriodBoundary[], assetRows: ColumnarRow[], liabilityRows: ColumnarRow[]) => void;
  onDrilldown?: (req: DrilldownRequest) => void;
  // "Expand All"/"Collapse All" signals -- owned by the caller (rendered as buttons on the
  // existing Single Period/Monthly/Quarterly toolbar row, not a row of our own) and shared with
  // whichever report is currently on screen. See useExpandCollapseAll in ColumnarSection.tsx.
  expandSignal?: number;
  collapseSignal?: number;
}) {
  const periods = useMemo(() => trimToLatestActivity(periodBoundariesForRange(start, end, granularity), data), [start, end, granularity, data]);
  const { assetRows, liabilityRows } = useMemo(() => buildBalanceSheetColumns(data, periods), [data, periods]);

  useEffect(() => {
    onComputed?.(periods, assetRows, liabilityRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, assetRows, liabilityRows]);

  // Display-only: flips every GL row between the report's default cumulative Ending Balance
  // (what buildBalanceSheetColumns computes -- the running closing balance as of each period's
  // end) and Incremental (what moved WITHIN each period) -- see toIncremental above. Purely a
  // local view transform; onComputed above still always reports the raw Ending Balance rows
  // (e.g. for Export to Excel), regardless of which view is on screen.
  const displayAssetRows = viewMode === "incremental" ? toIncremental(assetRows, periods) : assetRows;
  const displayLiabilityRows = viewMode === "incremental" ? toIncremental(liabilityRows, periods) : liabilityRows;
  const totalLabel = viewMode === "incremental" ? "Net Change" : "Closing";

  const assetTotals = periods.map((p) => displayAssetRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const liabilityTotals = periods.map((p) => displayLiabilityRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const diffByPeriod = assetTotals.map((v, i) => v - liabilityTotals[i]);
  const lastDiff = diffByPeriod[diffByPeriod.length - 1] || 0;
  const [sAsset, sLiab, sNet] = useSyncedScroll(3);
  const netRowLabel = "Balance check (Assets − Liabilities & Equity)";
  // One shared width pair, computed across Assets + Liabilities + the Balance Check row together,
  // applied identically to all 3 stacked tables -- see computeColumnarWidths for why this is what
  // keeps auto-fit sizing from re-breaking the cross-table alignment fixed earlier.
  const { labelWidth, valueWidth } = useMemo(
    () =>
      computeColumnarWidths(
        [
          { title: "Assets", rows: displayAssetRows },
          { title: "Liabilities & Equity", rows: displayLiabilityRows },
        ],
        [{ label: netRowLabel, values: diffByPeriod, total: lastDiff }],
        periods,
        fmt
      ),
    [displayAssetRows, displayLiabilityRows, diffByPeriod, lastDiff, periods, fmt]
  );

  return (
    <div className="columnar-report">
      <ColumnarSection
        title="Assets"
        rows={displayAssetRows}
        periods={periods}
        fmt={fmt}
        color={MONEY_IN}
        totalLabel={totalLabel}
        groupOrder={BS_ASSET_ORDER}
        scrollRef={sAsset.ref}
        onScroll={sAsset.onScroll}
        onDrilldown={onDrilldown}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
      />
      <ColumnarSection
        title="Liabilities & Equity"
        rows={displayLiabilityRows}
        periods={periods}
        fmt={fmt}
        color={MONEY_OUT}
        totalLabel={totalLabel}
        groupOrder={BS_LIABILITY_ORDER}
        scrollRef={sLiab.ref}
        onScroll={sLiab.onScroll}
        onDrilldown={onDrilldown}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
      />
      <ColumnarNetRow
        label={netRowLabel}
        values={diffByPeriod}
        total={lastDiff}
        periods={periods}
        fmt={fmt}
        colorOf={(v) => (Math.abs(v) < 0.01 ? "#16a34a" : "#dc2626")}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
        labelWidth={labelWidth}
        valueWidth={valueWidth}
      />
    </div>
  );
}
