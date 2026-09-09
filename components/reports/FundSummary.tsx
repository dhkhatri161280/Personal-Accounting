"use client";
import type { Ledger } from "@/lib/vault-types";
import { computeFundSummary, type FundGroup } from "@/lib/fund-summary";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { fmtDate } from "@/lib/format-date";

const GOOD = "#16a34a";
const BAD = "#dc2626";

function GroupRows({ group, fmt, fmtPct }: { group: FundGroup; fmt: (n: number) => string; fmtPct: (n: number) => string }) {
  return (
    <>
      <tr className="ledger-subtotal-row">
        <td colSpan={1}>{group.label}</td>
        <td className="right"></td>
        <td className="right"></td>
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

// Sources & Uses of Funds for the app's own currently-selected "Financial period" (the header
// picker at the top of the page) -- modeled on the user's own pre-existing personal Excel tracker
// (Incoming Fund vs. Outgoing Fund split into Expenses/Fixed Assets/Investments, each line
// showing % of total Incoming Fund), rebuilt here from this book's real accounts so it stays live
// instead of being a manually-maintained spreadsheet. Deliberately has no period picker of its
// own -- switching the header's period once already carries through to every report, this one
// included, rather than needing to be set again per report.
export function FundSummary({
  data,
  fmt,
  periodStart,
  periodEnd,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  periodStart: string;
  periodEnd: string;
}) {
  const s = computeFundSummary(data, periodStart, periodEnd);
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const mismatch = Math.abs(s.liquidityBalance - s.bankCashChange) > 1;

  async function exportRows() {
    const header = ["Line", "Amount", "% of Incoming Fund"];
    const groupRows = (g: typeof s.incoming) => [
      [g.label, "", ""],
      ...g.lines.map((l) => [l.label, l.amount, l.pctOfIncoming]),
      [`Total ${g.label}`, g.total, g.pctOfIncoming],
    ];
    const body = [
      ...groupRows(s.incoming),
      [],
      ["Outgoing Fund", "", ""],
      ...groupRows(s.outgoingExpenses),
      ...groupRows(s.outgoingFixedAssets),
      ...groupRows(s.outgoingInvestments),
      ["Total Outgoing Fund", s.totalOutgoing, s.totalOutgoingPct],
      [],
      ["Liquidity Balance", s.liquidityBalance, s.liquidityBalancePct],
    ];
    await exportWorkbook(`Fund Summary ${fmtDate(s.periodStart)} to ${fmtDate(s.periodEnd)}.xlsx`, [{ name: "Fund Summary", rows: [header, ...body] }]);
  }

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <h3>Fund Summary</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Sources & Uses of Funds for{" "}
        {s.periodStart <= "0001-01-01" ? "all periods" : `${fmtDate(s.periodStart)} – ${fmtDate(s.periodEnd)}`} (follows the
        Financial period selected above) -- every line shown as % of total Incoming Fund.
      </p>
      <div className="master-toolbar">
        <ExportButton onExport={exportRows} />
      </div>
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
            <GroupRows group={s.incoming} fmt={fmt} fmtPct={fmtPct} />
            <tr className="ledger-subtotal-row">
              <td colSpan={3}>Outgoing Fund</td>
            </tr>
            <GroupRows group={s.outgoingExpenses} fmt={fmt} fmtPct={fmtPct} />
            <GroupRows group={s.outgoingFixedAssets} fmt={fmt} fmtPct={fmtPct} />
            <GroupRows group={s.outgoingInvestments} fmt={fmt} fmtPct={fmtPct} />
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
      <p style={{ fontSize: 11, opacity: mismatch ? 1 : 0.6, margin: "10px 0 0", color: mismatch ? BAD : undefined }}>
        {mismatch
          ? `⚠ Liquidity Balance (${fmt(s.liquidityBalance)}) doesn't match the real Bank + Cash balance change over this period (${fmt(s.bankCashChange)}) -- check for an account not classified as Income/Expense/Fixed Assets/Investment/Bank/Cash.`
          : `Cross-check: matches the real Bank + Cash balance change over this period (${fmt(s.bankCashChange)}).`}
      </p>
    </div>
  );
}
