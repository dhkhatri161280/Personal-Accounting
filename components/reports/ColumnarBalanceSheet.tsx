"use client";
import { useEffect, useMemo } from "react";
import type { Ledger } from "@/lib/vault-types";
import {
  periodBoundaries,
  trimToLatestActivity,
  buildBalanceSheetColumns,
  BS_ASSET_ORDER,
  BS_LIABILITY_ORDER,
  type ColumnarRow,
  type PeriodBoundary,
} from "@/lib/columnar-report";
import { ColumnarSection, ColumnarNetRow, useSyncedScroll } from "@/components/reports/ColumnarSection";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

// Tally convention: Assets on top, Liabilities & Equity on bottom. Unlike Income & Expenditure,
// each period's value is a cumulative closing balance (not a flow), so the last column is the
// true "as of today" balance and the Total column shows that same closing rather than a sum --
// see buildBalanceSheetColumns in lib/columnar-report.ts for why.
export function ColumnarBalanceSheet({
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
  onComputed?: (periods: PeriodBoundary[], assetRows: ColumnarRow[], liabilityRows: ColumnarRow[]) => void;
}) {
  const periods = useMemo(() => trimToLatestActivity(periodBoundaries(fy, granularity), data), [fy, granularity, data]);
  const { assetRows, liabilityRows } = useMemo(() => buildBalanceSheetColumns(data, periods), [data, periods]);

  useEffect(() => {
    onComputed?.(periods, assetRows, liabilityRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, assetRows, liabilityRows]);

  const assetTotals = periods.map((p) => assetRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const liabilityTotals = periods.map((p) => liabilityRows.reduce((s, r) => s + (r.values[p.key] || 0), 0));
  const diffByPeriod = assetTotals.map((v, i) => v - liabilityTotals[i]);
  const lastDiff = diffByPeriod[diffByPeriod.length - 1] || 0;
  const [sAsset, sLiab, sNet] = useSyncedScroll(3);

  return (
    <div className="columnar-report">
      <ColumnarSection
        title="Assets"
        rows={assetRows}
        periods={periods}
        fmt={fmt}
        color={MONEY_IN}
        totalLabel="Closing"
        groupOrder={BS_ASSET_ORDER}
        scrollRef={sAsset.ref}
        onScroll={sAsset.onScroll}
      />
      <ColumnarSection
        title="Liabilities & Equity"
        rows={liabilityRows}
        periods={periods}
        fmt={fmt}
        color={MONEY_OUT}
        totalLabel="Closing"
        groupOrder={BS_LIABILITY_ORDER}
        scrollRef={sLiab.ref}
        onScroll={sLiab.onScroll}
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
