"use client";
import { useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { computeCashFlowForecast } from "@/lib/cash-flow-forecast";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const GOOD = "#16a34a";
const BAD = "#dc2626";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CashFlowForecast({
  data,
  fmt,
  onSave,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onSave?: (exclusions: string[]) => void;
}) {
  const [months, setMonths] = useState(6);
  const [expensesOpen, setExpensesOpen] = useState(true);
  const [annualOpen, setAnnualOpen] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const { points, unplacedYearly, expenseCategories, annualItems, budgetTieIn } = computeCashFlowForecast(data, months);
  const dismissed = data.cashFlowForecastExclusions ?? [];
  const firstNegative = points.find((p) => p.projectedCash < 0);

  const dismissCategory = (label: string) => onSave?.([...dismissed, label]);
  const reincludeCategory = (label: string) => onSave?.(dismissed.filter((l) => l.toLowerCase() !== label.toLowerCase()));

  return (
    <div className="data-panel grouped-report columnar-report-section">
      <h3 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        Cash Flow Forecast
        <span className="info-icon-wrap" onMouseEnter={() => setShowInfo(true)} onMouseLeave={() => setShowInfo(false)}>
          <button
            type="button"
            className="info-icon-btn"
            aria-label="How this forecast is calculated"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Projects cash forward from five sources: your projected paycheck (repeats your most recent pay period&apos;s net
              take-home, after tax/401(k)/ESPP deductions, on your real pay cadence -- or, without a payroll import, a trailing
              3-month average of deposits that look like a paycheck), projected dividends/interest (replays each month&apos;s
              actual dividend/interest inflow from one year ago), projected recurring living expenses (a trailing 6-month
              monthly average per category -- household, HOA, vehicle, and everything else posted as a real cash expense),
              active monthly Recurring Transactions, projected annual payments (any Expense account that only shows up in 3 or
              fewer distinct calendar months across your last 5 years of history -- an active yearly Recurring Template placed
              via its own posting log, OR any other account with that same infrequent pattern even with no template at all, e.g.
              Property Tax you&apos;ve simply posted by hand every year -- placed into its real month(s) using its own historical
              average for each; items with no detectable pattern are listed separately below instead of guessing), and active
              Loan payments. Fixed Asset depreciation,
              Prepaid amortization, paycheck deductions (tax, 401(k), ESPP -- already netted into Paycheck above), and anything
              already counted via Recurring Transactions or a loan&apos;s own interest are excluded from Living Expenses to
              avoid double-counting or fabricating a cash outflow that never happened. All of this is an estimate from your
              recent pattern, not a guarantee -- a raise, a changed deduction, a dividend cut, or one-off spending won&apos;t be
              reflected until it actually happens and updates your data. Click the ✕ next to a category that&apos;s finished (a
              one-time fee, a paid-off item) to exclude it until you see new activity. If any month&apos;s projected cash goes
              negative, a warning banner appears above the table. If a Budget exists for the current fiscal year, a callout
              below the table compares your budgeted net to your year-to-date actual plus this same projection logic run
              through the rest of the fiscal year.
            </div>
          )}
        </span>
      </h3>
      <div className="master-toolbar">
        <label>
          Months ahead{" "}
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <ExportButton
          onExport={async () => {
            const header = ["", ...points.map((p) => p.label)];
            const body = [
              ["Projected Paycheck (Net)", ...points.map((p) => p.paycheckNet)],
              ["Projected Dividends & Interest", ...points.map((p) => p.passiveIncome)],
              ["Projected Living Expenses", ...points.map((p) => -p.livingExpenses)],
              ["Recurring Net", ...points.map((p) => p.recurringNet)],
              ["Projected Annual Payments", ...points.map((p) => p.yearlyNet)],
              ["Loan Payments", ...points.map((p) => -p.loanPayments)],
              ["Projected Cash", ...points.map((p) => p.projectedCash)],
              [],
              ["Living Expenses breakdown (monthly average)"],
              ["Category", "Monthly Average"],
              ...expenseCategories.map((c) => [c.label, -c.monthlyAverage]),
              [],
              ["Annual Payments breakdown (placed month(s), from your posting history)"],
              ["Item", "Month(s)", "Total per year"],
              ...annualItems.map((item) => [item.label, item.months.map((mm) => MONTH_NAMES[mm - 1]).join(", "), -item.totalPerYear]),
              [],
              ["Upcoming annual items (timing not tracked)"],
              ["Item", "Amount"],
              ...unplacedYearly.map((item) => [item.label, item.amount]),
            ];
            await exportWorkbook("Cash Flow Forecast.xlsx", [{ name: "Cash Flow Forecast", rows: [header, ...body] }]);
          }}
        />
      </div>
      {firstNegative && (
        <div className="balance-check difference" style={{ marginBottom: 14, marginTop: 0 }}>
          <strong>⚠ Projected cash goes negative in {firstNegative.label}</strong>
          <span>{fmt(firstNegative.projectedCash)}</span>
          <small>Based on your recent pattern -- review Living Expenses/Projected Annual Payments below, or plan around it.</small>
        </div>
      )}
      <div className="columnar-report-scroll">
        <table className="columnar-report-table">
          <thead>
            <tr>
              <th></th>
              {points.map((p) => (
                <th className="right" key={p.period}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Projected Paycheck (Net)</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.paycheckNet > 0 ? GOOD : undefined }}>
                  {fmt(p.paycheckNet)}
                </td>
              ))}
            </tr>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Projected Dividends &amp; Interest</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.passiveIncome > 0 ? GOOD : undefined }}>
                  {fmt(p.passiveIncome)}
                </td>
              ))}
            </tr>
            <tr className="columnar-group-row">
              <td>
                <button type="button" className="group-heading" onClick={() => setExpensesOpen((v) => !v)}>
                  <span className="bs-arr">{expensesOpen ? "-" : "+"}</span>
                  <strong>Projected Living Expenses</strong>
                </button>
              </td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.livingExpenses > 0 ? BAD : undefined }}>
                  {p.livingExpenses > 0 ? `(${fmt(p.livingExpenses)})` : fmt(0)}
                </td>
              ))}
            </tr>
            {expensesOpen &&
              expenseCategories.map((c) => (
                <tr className="columnar-ledger-row" key={c.label}>
                  <td className="columnar-ledger-name">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {c.label}
                      {onSave && (
                        <button
                          type="button"
                          title={`This is done/no longer recurring -- exclude "${c.label}" from the projection`}
                          onClick={() => dismissCategory(c.label)}
                          style={{ border: "none", background: "none", cursor: "pointer", opacity: 0.5, fontSize: 11, padding: 0 }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </td>
                  {points.map((p) => (
                    <td className="right" key={p.period} style={{ color: BAD }}>
                      ({fmt(c.monthlyAverage)})
                    </td>
                  ))}
                </tr>
              ))}
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Recurring Net</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.recurringNet >= 0 ? GOOD : BAD }}>
                  {fmt(p.recurringNet)}
                </td>
              ))}
            </tr>
            <tr className="columnar-group-row">
              <td>
                <button type="button" className="group-heading" onClick={() => setAnnualOpen((v) => !v)}>
                  <span className="bs-arr">{annualOpen ? "-" : "+"}</span>
                  <strong>Projected Annual Payments</strong>
                </button>
              </td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.yearlyNet !== 0 ? (p.yearlyNet > 0 ? GOOD : BAD) : undefined }}>
                  {p.yearlyNet < 0 ? `(${fmt(-p.yearlyNet)})` : fmt(p.yearlyNet)}
                </td>
              ))}
            </tr>
            {annualOpen &&
              annualItems.map((item) => (
                <tr className="columnar-ledger-row" key={item.label}>
                  <td className="columnar-ledger-name">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {item.label}
                      <span style={{ opacity: 0.6, fontSize: 11 }}>({item.months.map((mm) => MONTH_NAMES[mm - 1]).join(", ")})</span>
                      {onSave && (
                        <button
                          type="button"
                          title={`This isn't recurring -- exclude "${item.label}" from the projection`}
                          onClick={() => dismissCategory(item.label)}
                          style={{ border: "none", background: "none", cursor: "pointer", opacity: 0.5, fontSize: 11, padding: 0 }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </td>
                  {points.map((p) => {
                    const mm = Number(p.period.slice(5, 7));
                    const amount = item.monthAmounts[mm];
                    return (
                      <td className="right" key={p.period} style={{ color: amount !== undefined ? BAD : undefined, opacity: amount !== undefined ? 1 : 0.4 }}>
                        {amount !== undefined ? `(${fmt(amount)})` : fmt(0)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">Loan Payments</td>
              {points.map((p) => (
                <td className="right" key={p.period} style={{ color: p.loanPayments > 0 ? BAD : undefined }}>
                  {p.loanPayments > 0 ? `(${fmt(p.loanPayments)})` : fmt(0)}
                </td>
              ))}
            </tr>
            <tr className="columnar-ledger-row">
              <td className="columnar-ledger-name">
                <strong>Projected Cash</strong>
              </td>
              {points.map((p) => (
                <td className="right" key={p.period}>
                  <strong style={{ color: p.projectedCash >= 0 ? GOOD : BAD }}>{fmt(p.projectedCash)}</strong>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {budgetTieIn && (
        <div className={`balance-check ${budgetTieIn.varianceVsBudget >= 0 ? "tied" : "difference"}`} style={{ marginTop: 14 }}>
          <strong>
            FY{budgetTieIn.fy} Budget: {budgetTieIn.varianceVsBudget >= 0 ? "on track to beat budget by" : "on track to miss budget by"}
          </strong>
          <span>{fmt(Math.abs(budgetTieIn.varianceVsBudget))}</span>
          <small>
            Budgeted net {fmt(budgetTieIn.budgetedNet)} vs. year-to-date actual {fmt(budgetTieIn.ytdActualNet)} + projected
            remaining months {fmt(budgetTieIn.projectedRemainingNet)} = projected FY net {fmt(budgetTieIn.projectedFYNet)}.
          </small>
        </div>
      )}
      {expenseCategories.length === 0 && (
        <p style={{ fontSize: 12, opacity: 0.7, margin: "10px 0 0" }}>
          No recurring living-expense pattern found in the trailing 6 months (or every posted expense is already covered by an
          active Recurring Transaction or loan interest).
        </p>
      )}
      {dismissed.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: "0 0 8px" }}>Excluded from Living Expenses / Annual Payments</h4>
          {dismissed.map((label) => (
            <div className="report-line" key={label}>
              <span>{label}</span>
              <button type="button" className="tr-refresh-btn" onClick={() => reincludeCategory(label)}>
                Include again
              </button>
            </div>
          ))}
        </div>
      )}
      {unplacedYearly.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: "0 0 8px" }}>Yearly items with no detectable month</h4>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
            These recur yearly, but there's no posting history yet to tell which month -- not included in "Projected Annual
            Payments" above. Once one is posted, it'll be placed automatically from then on.
          </p>
          {unplacedYearly.map((item) => (
            <div className="report-line" key={item.label}>
              <span>{item.label}</span>
              <span style={{ color: item.amount >= 0 ? GOOD : BAD }}>{fmt(item.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
