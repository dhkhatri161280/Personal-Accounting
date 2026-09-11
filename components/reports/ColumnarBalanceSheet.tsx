"use client";
import { useEffect, useMemo, useState } from "react";
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
import { ColumnarSection, ColumnarNetRow, useSyncedScroll, type DrilldownRequest } from "@/components/reports/ColumnarSection";

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
  onComputed,
  onDrilldown,
}: {
  data: Ledger;
  start: string;
  end: string;
  granularity: "monthly" | "quarterly";
  fmt: (n: number) => string;
  onComputed?: (periods: PeriodBoundary[], assetRows: ColumnarRow[], liabilityRows: ColumnarRow[]) => void;
  onDrilldown?: (req: DrilldownRequest) => void;
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
  const [viewMode, setViewMode] = useState<"ending" | "incremental">("ending");
  const displayAssetRows = viewMode === "incremental" ? toIncremental(assetRows, periods) : assetRows;
  const displayLiabilityRows = viewMode === "incremental" ? toIncremental(liabilityRows, periods) : liabilityRows;
  const totalLabel = viewMode === "incremental" ? "Net Change" : "Closing";

  const assetTotals = periods.map((p) => displayAssetRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const liabilityTotals = periods.map((p) => displayLiabilityRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const diffByPeriod = assetTotals.map((v, i) => v - liabilityTotals[i]);
  const lastDiff = diffByPeriod[diffByPeriod.length - 1] || 0;
  const [sAsset, sLiab, sNet] = useSyncedScroll(3);

  return (
    <div className="columnar-report">
      <div className="report-view-toggle-row" style={{ marginBottom: "0.5rem" }}>
        <span className="report-view-toggle" role="group" aria-label="Balance Sheet view">
          <button
            type="button"
            className={viewMode === "ending" ? "selected" : ""}
            onClick={() => setViewMode("ending")}
            title="Each column is the running closing balance as of that period's end"
          >
            Ending Balance
          </button>
          <button
            type="button"
            className={viewMode === "incremental" ? "selected" : ""}
            onClick={() => setViewMode("incremental")}
            title="Each column is what moved during that period only, not the running balance"
          >
            Incremental
          </button>
        </span>
      </div>
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
      />
      <ColumnarNetRow
        label="Balance check (Assets − Liabilities & Equity)"
        values={diffByPeriod}
        total={lastDiff}
        periods={periods}
        fmt={fmt}
        colorOf={(v) => (Math.abs(v) < 0.01 ? "#16a34a" : "#dc2626")}
        scrollRef={sNet.ref}
        onScroll={sNet.onScroll}
      />
    </div>
  );
}
