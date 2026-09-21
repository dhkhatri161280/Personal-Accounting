"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { getApplicableDailyRate, type DailyFxRates } from "@/lib/fx-daily";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

const usdFmt = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const GROUP_NAME = "loans & advances (asset)";

type LedgerRow = {
  key: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  narration: string;
  amountInr: number; // signed, this app's convention: negative = debit (lent), positive = credit (repaid)
};

// Translates postings to one India-book "Loans & Advances (Asset)" ledger into USD using the real
// INR/USD rate on each transaction's own date -- funds lent out of this book are really
// US-sourced money, so seeing the outstanding balance in USD terms (not just INR) matters for
// gauging real exposure. Deliberately a separate daily-rate lookup (lib/fx-daily.ts) from the
// monthly-average one GR Consolidated uses elsewhere -- that one is a previous-month approximation,
// this feature was explicitly asked to use the literal date's rate.
//
// Styled and scoped like the app's own single-ledger drill-down (opening balance folded from
// everything before the period, only in-period postings listed, running balance per row) and
// follows the header's "Financial period" selector via periodStart/periodEnd -- the same
// convention FundSummary already uses (see VaultApp.tsx's fundSummaryStart/fundSummaryEnd).
export function LoansAdvancesFxRegister({
  data,
  fmt,
  periodStart,
  periodEnd,
  periodLabel,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
}) {
  const [dailyRates, setDailyRates] = useState<DailyFxRates>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // "historical" (default, matches how this register originally shipped): each row's Balance is
  // the running sum of every transaction translated at ITS OWN date's rate. "mtm": every Balance
  // figure instead revalues the current INR balance at TODAY's rate, like a bank statement's
  // "value in USD today" -- Debit/Credit amounts stay historical either way (what that specific
  // payment was actually worth on the day it happened doesn't change retroactively).
  const [valuationMode, setValuationMode] = useState<"historical" | "mtm">("historical");
  const todayStr = todayLocalIso();

  const groupAccounts = useMemo(
    () =>
      data.accounts
        .filter((a) => (a.parent || "").trim().toLowerCase() === GROUP_NAME)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data.accounts]
  );

  useEffect(() => {
    if (groupAccounts.length === 0) {
      if (selectedId !== null) setSelectedId(null);
    } else if (selectedId === null || !groupAccounts.some((a) => a.id === selectedId)) {
      setSelectedId(groupAccounts[0].id);
    }
  }, [groupAccounts, selectedId]);

  const selectedAccount = groupAccounts.find((a) => a.id === selectedId) ?? null;

  // Opening balance = ledger's static opening + every posting dated before the period, folded
  // into one figure (raw sign convention: negative = net debit). Only postings within
  // [periodStart, periodEnd] are kept as visible rows, matching VaultApp's own `calc`.
  const { openingRawInr, priorEntries, periodRows } = useMemo(() => {
    if (!selectedAccount) return { openingRawInr: 0, priorEntries: [] as { date: string; amount: number }[], periodRows: [] as LedgerRow[] };
    let openingRawInr = selectedAccount.openingBalance;
    const priorEntries: { date: string; amount: number }[] = [];
    const rows: LedgerRow[] = [];
    for (const t of data.transactions) {
      if (t.deleted || t.cancelled) continue;
      for (const e of t.entries) {
        if (e.accountId !== selectedAccount.id) continue;
        if (t.date < periodStart) {
          openingRawInr += e.amount;
          priorEntries.push({ date: t.date, amount: e.amount });
        } else if (t.date <= periodEnd) {
          rows.push({
            key: `${t.guid}-${e.accountId}`,
            date: t.date,
            voucherType: t.type,
            voucherNumber: t.number,
            narration: t.narration,
            amountInr: e.amount,
          });
        }
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    return { openingRawInr, priorEntries, periodRows: rows };
  }, [data.transactions, selectedAccount, periodStart, periodEnd]);

  const neededDatesKey = useMemo(() => {
    const set = new Set<string>();
    for (const r of periodRows) set.add(r.date);
    for (const e of priorEntries) set.add(e.date);
    if (selectedAccount && selectedAccount.openingBalance !== 0) set.add(periodStart);
    // Always fetched (not just when mark-to-market is selected) so switching the toggle is
    // instant, no fetch-on-demand delay.
    set.add(todayStr);
    return Array.from(set).sort().join(",");
  }, [periodRows, priorEntries, selectedAccount, periodStart, todayStr]);

  useEffect(() => {
    const neededDates = neededDatesKey ? neededDatesKey.split(",") : [];
    if (neededDates.length === 0) return;
    let cancelled = false;
    setStatus("loading");
    setErrorMsg("");
    (async () => {
      try {
        const getResp = await fetch("/api/fx-rates-daily");
        const cached: DailyFxRates = getResp.ok ? ((await getResp.json()) as { rates?: DailyFxRates }).rates ?? {} : {};
        const missing = neededDates.filter((d) => cached[d] == null);
        let rates = cached;
        if (missing.length) {
          const postResp = await fetch("/api/fx-rates-daily", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dates: missing }),
          });
          if (postResp.ok) {
            const j = (await postResp.json()) as { rates?: DailyFxRates; errors?: string[] };
            rates = j.rates ?? cached;
            if (j.errors?.length && !cancelled) setErrorMsg(j.errors.join("; "));
          } else if (!cancelled) {
            setErrorMsg(`FX rate fetch failed: HTTP ${postResp.status}`);
          }
        }
        if (!cancelled) {
          setDailyRates(rates);
          setStatus("ready");
        }
      } catch (e: any) {
        if (!cancelled) {
          setErrorMsg(e?.message || "Failed to load FX rates");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [neededDatesKey]);

  // openingUsd carries the same "positive = net amount lent out" polarity as each row's own
  // translated amountUsd below, so the running total can just keep adding onto it.
  const openingUsd = useMemo(() => {
    if (!selectedAccount) return 0;
    let usd = selectedAccount.openingBalance !== 0 ? -selectedAccount.openingBalance / getApplicableDailyRate(dailyRates, periodStart) : 0;
    for (const e of priorEntries) usd += -e.amount / getApplicableDailyRate(dailyRates, e.date);
    return usd;
  }, [selectedAccount, priorEntries, dailyRates, periodStart]);

  const openingInr = -openingRawInr;
  const todaysRate = getApplicableDailyRate(dailyRates, todayStr);
  const openingUsdMtm = openingInr / todaysRate;

  let runningRawInr = openingRawInr;
  let runningUsd = openingUsd;
  const rendered = periodRows.map((r) => {
    runningRawInr += r.amountInr;
    const rate = getApplicableDailyRate(dailyRates, r.date);
    const amountUsd = -r.amountInr / rate;
    runningUsd += amountUsd;
    const balanceInr = -runningRawInr;
    return {
      ...r,
      rate,
      amountUsd,
      balanceInr,
      balanceUsd: valuationMode === "mtm" ? balanceInr / todaysRate : runningUsd,
    };
  });

  const closingInr = -runningRawInr;
  const closingUsdHistorical = runningUsd;
  const closingUsdMtm = closingInr / todaysRate;
  const openingUsdDisplay = valuationMode === "mtm" ? openingUsdMtm : openingUsd;
  const closingUsd = valuationMode === "mtm" ? closingUsdMtm : closingUsdHistorical;
  const totalDebitInr = periodRows.filter((r) => r.amountInr < 0).reduce((s, r) => s - r.amountInr, 0);
  const totalCreditInr = periodRows.filter((r) => r.amountInr > 0).reduce((s, r) => s + r.amountInr, 0);
  // Kept in the same signed polarity each row's own USD sub-line already shows (Lent positive,
  // Repaid negative -- see amountUsd below), not flipped to a positive magnitude, so the total
  // reads as a straight sum of the column above it.
  const totalDebitUsd = rendered.filter((r) => r.amountInr < 0).reduce((s, r) => s + r.amountUsd, 0);
  const totalCreditUsd = rendered.filter((r) => r.amountInr > 0).reduce((s, r) => s + r.amountUsd, 0);

  return (
    <div className="data-panel">
      <h3>Loans &amp; Advances — USD Translation</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Every voucher posted to the selected "Loans &amp; Advances (Asset)" ledger, translated to USD at the
        INR/USD rate on that transaction's own date (sourced from frankfurter.app, cached once per date). Lent
        (Dr)/Repaid (Cr) amounts always show what that specific payment was worth in USD on the day it happened.
        The Balance column follows the toggle below: Historical-cost accumulates each payment's own-date USD
        value; Mark-to-market instead revalues today's outstanding INR balance at today's rate. Follows the
        header's Financial period selector, same as every other report.
      </p>
      {groupAccounts.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No ledgers found under "Loans &amp; Advances (Asset)".</p>
      ) : (
        <>
          <div className="report-line" style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              Ledger
              <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.target.value))}>
                {groupAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, marginLeft: 16 }}>
              Balance valuation
              <select value={valuationMode} onChange={(e) => setValuationMode(e.target.value as "historical" | "mtm")}>
                <option value="historical">Historical-cost</option>
                <option value="mtm">Mark-to-market (today's rate)</option>
              </select>
            </label>
            {status === "loading" && <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 10 }}>Loading FX rates…</span>}
            {status === "error" && (
              <span style={{ fontSize: 12, color: "#dc2626", marginLeft: 10 }}>Couldn't load some FX rates: {errorMsg}</span>
            )}
          </div>

          {selectedAccount && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, margin: "0 0 4px" }}>
                <h4 style={{ margin: 0 }}>{selectedAccount.name}</h4>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{periodLabel}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "0 0 6px" }}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  Opening: {fmt(openingInr)} ≈ {usdFmt(openingUsdDisplay)} &nbsp;·&nbsp; Closing: {fmt(closingInr)} ≈ {usdFmt(closingUsd)}
                  {valuationMode === "mtm" && (
                    <span title={`Today's rate: ${todaysRate.toFixed(4)} (${fmtDate(todayStr)})`}> · MTM @ {todaysRate.toFixed(4)}</span>
                  )}
                </span>
                {periodRows.length > 0 && (
                  <ExportButton
                    onExport={async () => {
                      const header = ["Date", "Voucher Type", "Voucher #", "Narration", "Debit (INR)", "Credit (INR)", "FX Rate", "Amount (USD)", "Running Balance (INR)", "Running Balance (USD)"];
                      const body = rendered.map((r) => [
                        fmtDate(r.date),
                        r.voucherType,
                        r.voucherNumber,
                        r.narration,
                        r.amountInr < 0 ? -r.amountInr : "",
                        r.amountInr > 0 ? r.amountInr : "",
                        r.rate,
                        r.amountUsd,
                        r.balanceInr,
                        r.balanceUsd,
                      ]);
                      await exportWorkbook(`${selectedAccount.name} - USD Translation.xlsx`, [{ name: "USD Translation", rows: [header, ...body] }]);
                    }}
                  />
                )}
              </div>
              {periodRows.length === 0 ? (
                <p style={{ fontSize: 12, opacity: 0.6 }}>No postings on this ledger in {periodLabel}.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="fx-ledger-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Voucher</th>
                        <th className="fx-narration">Narration</th>
                        <th className="right">Debit</th>
                        <th className="right">Credit</th>
                        <th className="right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rendered.map((r) => {
                        const rateTitle = `FX rate ${r.rate.toFixed(4)} on ${fmtDate(r.date)}`;
                        return (
                          <tr key={r.key}>
                            <td>{fmtDate(r.date)}</td>
                            <td>
                              {r.voucherType} {r.voucherNumber}
                            </td>
                            <td className="fx-narration" title={r.narration}>
                              {r.narration || "—"}
                            </td>
                            <td className="right" title={r.amountInr < 0 ? rateTitle : undefined}>
                              {r.amountInr < 0 ? (
                                <>
                                  {fmt(-r.amountInr)}
                                  <span className="fx-usd-sub">≈ {usdFmt(r.amountUsd)}</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="right" title={r.amountInr > 0 ? rateTitle : undefined}>
                              {r.amountInr > 0 ? (
                                <>
                                  {fmt(r.amountInr)}
                                  <span className="fx-usd-sub">≈ {usdFmt(r.amountUsd)}</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="right">
                              {fmt(r.balanceInr)}
                              <span className="fx-usd-sub">≈ {usdFmt(r.balanceUsd)}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>Total</td>
                        <td className="right">
                          {fmt(totalDebitInr)}
                          <span className="fx-usd-sub">≈ {usdFmt(totalDebitUsd)}</span>
                        </td>
                        <td className="right">
                          {fmt(totalCreditInr)}
                          <span className="fx-usd-sub">≈ {usdFmt(totalCreditUsd)}</span>
                        </td>
                        <td className="right">
                          {fmt(closingInr)}
                          <span className="fx-usd-sub">≈ {usdFmt(closingUsd)}</span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
