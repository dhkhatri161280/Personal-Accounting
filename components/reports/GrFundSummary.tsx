"use client";
import type { GrFundSummaryResult, GrFundGroup } from "@/lib/gr-fund-summary";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const GOOD = "#16a34a";
const BAD = "#dc2626";

function DetailGroupRows({ group, fmt, fmtPct }: { group: GrFundGroup; fmt: (n: number) => string; fmtPct: (n: number) => string }) {
  return (
    <>
      <tr className="ledger-subtotal-row">
        <td colSpan={3}>{group.label}</td>
      </tr>
      {group.lines.map((l) => (
        <tr key={l.label}>
          <td className="columnar-ledger-name">{l.label}</td>
          <td className="right">{fmt(l.amount)}</td>
          <td className="right">{fmtPct(l.pctOfIncoming)}</td>
        </tr>
      ))}
      <tr className="columnar-ledger-row">
        <td>
          <strong>Total {group.label}</strong>
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

// GR-consolidated counterpart to components/reports/FundSummary.tsx -- same layout, sourced from
// computeGrFundSummary (lib/gr-fund-summary.ts) instead of computeFundSummary. No per-line
// drilldown: GrAccount has no numeric id to resolve back to a specific voucher across two source
// books, consistent with every other GR report (none of which have a drilldown either).
export function GrFundSummary({ s, fmt, periodLabel }: { s: GrFundSummaryResult; fmt: (n: number) => string; periodLabel: string }) {
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const mismatch = Math.abs(s.liquidityBalance - s.bankCashChange) > 1;

  async function exportRows() {
    const header = ["Line", "Amount", "% of Incoming Fund"];
    const summaryRows = [
      ["Incoming Fund", s.incoming.total, s.incoming.pctOfIncoming],
      [`  ${s.financing.label}`, s.financing.total, s.financing.pctOfIncoming],
      ["Outgoing Fund", "", ""],
      [`  ${s.outgoingExpenses.label}`, s.outgoingExpenses.total, s.outgoingExpenses.pctOfIncoming],
      [`  ${s.outgoingFixedAssets.label}`, s.outgoingFixedAssets.total, s.outgoingFixedAssets.pctOfIncoming],
      [`  ${s.outgoingInvestments.label}`, s.outgoingInvestments.total, s.outgoingInvestments.pctOfIncoming],
      [`  ${s.outgoingLoans.label}`, s.outgoingLoans.total, s.outgoingLoans.pctOfIncoming],
      ["Total Outgoing Fund", s.totalOutgoing, s.totalOutgoingPct],
      [],
      ["Liquidity Balance", s.liquidityBalance, s.liquidityBalancePct],
    ];
    const groupRows = (g: GrFundGroup) => [
      [g.label, "", ""],
      ...g.lines.map((l) => [l.label, l.amount, l.pctOfIncoming]),
      [`Total ${g.label}`, g.total, g.pctOfIncoming],
    ];
    const detailRows = [
      ...groupRows(s.incoming),
      [],
      ...groupRows(s.financing),
      [],
      ["Outgoing Fund", "", ""],
      ...groupRows(s.outgoingExpenses),
      ...groupRows(s.outgoingFixedAssets),
      ...groupRows(s.outgoingInvestments),
      ...groupRows(s.outgoingLoans),
    ];
    await exportWorkbook(`GR Fund Summary ${periodLabel}.xlsx`, [
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
        Sources &amp; Uses of Funds for {periodLabel} (follows the Financial period selected above), consolidated across both
        books in INR.
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
                <strong>Incoming Fund</strong>
              </td>
              <td className="right">
                <strong>{fmt(s.incoming.total)}</strong>
              </td>
              <td className="right">
                <strong>{fmtPct(s.incoming.pctOfIncoming)}</strong>
              </td>
            </tr>
            {Math.abs(s.financing.total) > 0.005 && (
              <tr>
                <td>{s.financing.label}</td>
                <td className="right">{fmt(s.financing.total)}</td>
                <td className="right">{fmtPct(s.financing.pctOfIncoming)}</td>
              </tr>
            )}
            <tr className="ledger-subtotal-row">
              <td colSpan={3}>Outgoing Fund</td>
            </tr>
            {[s.outgoingExpenses, s.outgoingFixedAssets, s.outgoingInvestments, s.outgoingLoans].map((g) => (
              <tr key={g.label}>
                <td style={{ paddingLeft: 24 }}>{g.label}</td>
                <td className="right">{fmt(g.total)}</td>
                <td className="right">{fmtPct(g.pctOfIncoming)}</td>
              </tr>
            ))}
            <tr className="columnar-ledger-row">
              <td>
                <strong>Total Outgoing Fund</strong>
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
        {mismatch ? (
          <>
            ⚠ Liquidity Balance ({fmt(s.liquidityBalance)}) doesn&apos;t match the real Bank + Cash balance change over this
            period ({fmt(s.bankCashChange)}) -- check for an account not classified as Income/Expense/Fixed
            Assets/Investment/Bank/Cash.
          </>
        ) : (
          <>Cross-check: matches the real Bank + Cash balance change over this period ({fmt(s.bankCashChange)}).</>
        )}
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
            <DetailGroupRows group={s.incoming} fmt={fmt} fmtPct={fmtPct} />
            {Math.abs(s.financing.total) > 0.005 && <DetailGroupRows group={s.financing} fmt={fmt} fmtPct={fmtPct} />}
            <tr className="ledger-subtotal-row">
              <td colSpan={3}>Outgoing Fund</td>
            </tr>
            <DetailGroupRows group={s.outgoingExpenses} fmt={fmt} fmtPct={fmtPct} />
            <DetailGroupRows group={s.outgoingFixedAssets} fmt={fmt} fmtPct={fmtPct} />
            <DetailGroupRows group={s.outgoingInvestments} fmt={fmt} fmtPct={fmtPct} />
            <DetailGroupRows group={s.outgoingLoans} fmt={fmt} fmtPct={fmtPct} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
