"use client";
import type { Ledger } from "@/lib/vault-types";
import { computeFundSummary, type FundGroup } from "@/lib/fund-summary";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { fmtDate } from "@/lib/format-date";
import type { DrilldownRequest } from "@/components/reports/ColumnarSection";

const GOOD = "#16a34a";
const BAD = "#dc2626";

function DetailGroupRows({
  group,
  fmt,
  fmtPct,
  onDrilldown,
}: {
  group: FundGroup;
  fmt: (n: number) => string;
  fmtPct: (n: number) => string;
  onDrilldown: (label: string, accountIds: number[]) => void;
}) {
  return (
    <>
      <tr className="ledger-subtotal-row">
        <td colSpan={3}>{group.label}</td>
      </tr>
      {group.lines.map((l) => (
        <tr key={l.label}>
          <td className="columnar-ledger-name">
            <button type="button" className="ledger-link" onClick={() => onDrilldown(l.label, l.accountIds)}>
              {l.label}
            </button>
          </td>
          <td className="right">{fmt(l.amount)}</td>
          <td className="right">{fmtPct(l.pctOfIncoming)}</td>
        </tr>
      ))}
      <tr className="columnar-ledger-row">
        <td>
          <button type="button" className="ledger-link" onClick={() => onDrilldown(`Total ${group.label}`, group.accountIds)}>
            <strong>Total {group.label}</strong>
          </button>
        </td>
        <td className="right">
          <strong>{fmt(group.total)}</strong>
        </td>
        <td className="right">
          <strong>{fmtPct(group.pctOfIncoming)}</strong>
        </td>
      </tr>
    </>
  );
}

// Sources & Uses of Funds for the app's own currently-selected "Financial period" (the header
// picker at the top of the page) -- modeled on the user's own pre-existing personal Excel tracker,
// which is laid out as two distinct blocks: a compact Summary panel (Incoming Fund vs. Outgoing
// Fund subtotals, ending in Liquidity Balance) followed by a fully itemized Detail breakdown of
// every line behind those subtotals. Rebuilt here from this book's real accounts so it stays live
// instead of being a manually-maintained spreadsheet. Every line and subtotal is clickable,
// drilling into the real vouchers behind it via the same mechanism the columnar reports already
// use (see onDrilldown/DrilldownRequest). Deliberately has no period picker of its own --
// switching the header's period once already carries through to every report, this one included.
export function FundSummary({
  data,
  fmt,
  periodStart,
  periodEnd,
  onDrilldown,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  periodStart: string;
  periodEnd: string;
  onDrilldown: (req: DrilldownRequest) => void;
}) {
  const s = computeFundSummary(data, periodStart, periodEnd);
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const mismatch = Math.abs(s.liquidityBalance - s.bankCashChange) > 1;
  const drill = (label: string, accountIds: number[]) => onDrilldown({ label, accountIds, start: s.periodStart, end: s.periodEnd });

  async function exportRows() {
    const header = ["Line", "Amount", "% of Incoming Fund"];
    const summaryRows = [
      ["Incoming Fund", s.incoming.total, s.incoming.pctOfIncoming],
      ["Outgoing Fund", "", ""],
      [`  ${s.outgoingExpenses.label}`, s.outgoingExpenses.total, s.outgoingExpenses.pctOfIncoming],
      [`  ${s.outgoingFixedAssets.label}`, s.outgoingFixedAssets.total, s.outgoingFixedAssets.pctOfIncoming],
      [`  ${s.outgoingInvestments.label}`, s.outgoingInvestments.total, s.outgoingInvestments.pctOfIncoming],
      ["Total Outgoing Fund", s.totalOutgoing, s.totalOutgoingPct],
      [],
      ["Liquidity Balance", s.liquidityBalance, s.liquidityBalancePct],
    ];
    const groupRows = (g: FundGroup) => [
      [g.label, "", ""],
      ...g.lines.map((l) => [l.label, l.amount, l.pctOfIncoming]),
      [`Total ${g.label}`, g.total, g.pctOfIncoming],
    ];
    const detailRows = [
      ...groupRows(s.incoming),
      [],
      ["Outgoing Fund", "", ""],
      ...groupRows(s.outgoingExpenses),
      ...groupRows(s.outgoingFixedAssets),
      ...groupRows(s.outgoingInvestments),
    ];
    await exportWorkbook(`Fund Summary ${fmtDate(s.periodStart)} to ${fmtDate(s.periodEnd)}.xlsx`, [
      { name: "Summary", rows: [header, ...summaryRows] },
      { name: "Detail", rows: [header, ...detailRows] },
    ]);
  }

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Fund Summary</h3>
        <ExportButton onExport={exportRows} />
      </div>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Sources & Uses of Funds for{" "}
        {s.periodStart <= "0001-01-01" ? "all periods" : `${fmtDate(s.periodStart)} – ${fmtDate(s.periodEnd)}`} (follows the
        Financial period selected above). Click any line to see the vouchers behind it.
      </p>

      <h4 style={{ margin: "0 0 8px" }}>Summary</h4>
      <div className="columnar-report-scroll">
        <table className="columnar-report-table budget-table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="right">Amount</th>
              <th className="right">% of Incoming Fund</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <button type="button" className="ledger-link" onClick={() => drill(s.incoming.label, s.incoming.accountIds)}>
                  <strong>Incoming Fund</strong>
                </button>
              </td>
              <td className="right">
                <strong>{fmt(s.incoming.total)}</strong>
              </td>
              <td className="right">
                <strong>{fmtPct(s.incoming.pctOfIncoming)}</strong>
              </td>
            </tr>
            <tr className="ledger-subtotal-row">
              <td colSpan={3}>Outgoing Fund</td>
            </tr>
            {[s.outgoingExpenses, s.outgoingFixedAssets, s.outgoingInvestments].map((g) => (
              <tr key={g.label}>
                <td style={{ paddingLeft: 24 }}>
                  <button type="button" className="ledger-link" onClick={() => drill(g.label, g.accountIds)}>
                    {g.label}
                  </button>
                </td>
                <td className="right">{fmt(g.total)}</td>
                <td className="right">{fmtPct(g.pctOfIncoming)}</td>
              </tr>
            ))}
            <tr className="columnar-ledger-row">
              <td>
                <button type="button" className="ledger-link" onClick={() => drill("Total Outgoing Fund", s.totalOutgoingAccountIds)}>
                  <strong>Total Outgoing Fund</strong>
                </button>
              </td>
              <td className="right">
                <strong>{fmt(s.totalOutgoing)}</strong>
              </td>
              <td className="right">
                <strong>{fmtPct(s.totalOutgoingPct)}</strong>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th>Liquidity Balance</th>
              <th className="right" style={{ color: s.liquidityBalance >= 0 ? GOOD : BAD }}>
                {fmt(s.liquidityBalance)}
              </th>
              <th className="right" style={{ color: s.liquidityBalance >= 0 ? GOOD : BAD }}>
                {fmtPct(s.liquidityBalancePct)}
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
      <p style={{ fontSize: 11, opacity: mismatch ? 1 : 0.6, margin: "10px 0 20px", color: mismatch ? BAD : undefined }}>
        {mismatch
          ? `⚠ Liquidity Balance (${fmt(s.liquidityBalance)}) doesn't match the real Bank + Cash balance change over this period (${fmt(s.bankCashChange)}) -- check for an account not classified as Income/Expense/Fixed Assets/Investment/Bank/Cash.`
          : `Cross-check: matches the real Bank + Cash balance change over this period (${fmt(s.bankCashChange)}).`}
      </p>

      <h4 style={{ margin: "0 0 8px" }}>Detail</h4>
      <div className="columnar-report-scroll">
        <table className="columnar-report-table budget-table">
          <thead>
            <tr>
              <th>Line</th>
              <th className="right">Amount</th>
              <th className="right">% of Incoming Fund</th>
            </tr>
          </thead>
          <tbody>
            <DetailGroupRows group={s.incoming} fmt={fmt} fmtPct={fmtPct} onDrilldown={drill} />
            <tr className="ledger-subtotal-row">
              <td colSpan={3}>Outgoing Fund</td>
            </tr>
            <DetailGroupRows group={s.outgoingExpenses} fmt={fmt} fmtPct={fmtPct} onDrilldown={drill} />
            <DetailGroupRows group={s.outgoingFixedAssets} fmt={fmt} fmtPct={fmtPct} onDrilldown={drill} />
            <DetailGroupRows group={s.outgoingInvestments} fmt={fmt} fmtPct={fmtPct} onDrilldown={drill} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
