"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { fmtDate } from "@/lib/format-date";
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

// Translates every posting to the India book's "Loans & Advances (Asset)" ledgers into USD using
// the real INR/USD rate on each transaction's own date -- funds lent out of this book are really
// US-sourced money, so seeing the outstanding balance in USD terms (not just INR) matters for
// gauging real exposure. Deliberately a separate daily-rate lookup (lib/fx-daily.ts) from the
// monthly-average one GR Consolidated uses elsewhere -- that one is a previous-month approximation,
// this feature was explicitly asked to use the literal date's rate.
export function LoansAdvancesFxRegister({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [dailyRates, setDailyRates] = useState<DailyFxRates>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const groupAccounts = useMemo(
    () =>
      data.accounts
        .filter((a) => (a.parent || "").trim().toLowerCase() === GROUP_NAME)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data.accounts]
  );

  const rowsByAccount = useMemo(() => {
    const map = new Map<number, LedgerRow[]>();
    for (const acc of groupAccounts) map.set(acc.id, []);
    for (const t of data.transactions) {
      if (t.deleted || t.cancelled) continue;
      for (const e of t.entries) {
        const rows = map.get(e.accountId);
        if (!rows) continue;
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
    for (const rows of map.values()) rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    return map;
  }, [data.transactions, groupAccounts]);

  const neededDatesKey = useMemo(() => {
    const set = new Set<string>();
    for (const rows of rowsByAccount.values()) for (const r of rows) set.add(r.date);
    return Array.from(set).sort().join(",");
  }, [rowsByAccount]);

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

  return (
    <div className="data-panel">
      <h3>Loans &amp; Advances — USD Translation</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Every voucher posted to the India book's "Loans &amp; Advances (Asset)" ledgers, translated to USD at the
        INR/USD rate on that transaction's own date (sourced from frankfurter.app, cached once per date). Lent
        (Dr) increases the outstanding USD balance; Repaid (Cr) reduces it — a running historical-cost USD
        balance, not a mark-to-market revaluation of the whole balance at today's rate.
      </p>
      {status === "loading" && <p style={{ fontSize: 12, opacity: 0.7 }}>Loading FX rates…</p>}
      {status === "error" && (
        <p style={{ fontSize: 12, color: "#dc2626" }}>Couldn't load some FX rates: {errorMsg}</p>
      )}
      {groupAccounts.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No ledgers found under "Loans &amp; Advances (Asset)".</p>
      ) : (
        groupAccounts.map((acc) => {
          const rows = rowsByAccount.get(acc.id) ?? [];
          let runningUsd = 0;
          const rendered = rows.map((r) => {
            const rate = getApplicableDailyRate(dailyRates, r.date);
            const amountUsd = -r.amountInr / rate;
            runningUsd += amountUsd;
            return { ...r, rate, amountUsd, runningUsd };
          });
          const currentBalanceInr = rows.reduce((s, r) => s - r.amountInr, acc.openingBalance);
          const currentBalanceUsd = rendered.length ? rendered[rendered.length - 1].runningUsd : 0;
          return (
            <div key={acc.id} style={{ marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 6px" }}>
                <h4 style={{ margin: 0 }}>{acc.name}</h4>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    Outstanding: {fmt(currentBalanceInr)} ≈ {usdFmt(currentBalanceUsd)}
                  </span>
                  {rows.length > 0 && (
                    <ExportButton
                      onExport={async () => {
                        const header = ["Date", "Voucher Type", "Voucher #", "Narration", "Amount (INR)", "FX Rate", "Amount (USD)", "Running Balance (USD)"];
                        const body = rendered.map((r) => [
                          fmtDate(r.date),
                          r.voucherType,
                          r.voucherNumber,
                          r.narration,
                          -r.amountInr,
                          r.rate,
                          r.amountUsd,
                          r.runningUsd,
                        ]);
                        await exportWorkbook(`${acc.name} - USD Translation.xlsx`, [{ name: "USD Translation", rows: [header, ...body] }]);
                      }}
                    />
                  )}
                </div>
              </div>
              {rows.length === 0 ? (
                <p style={{ fontSize: 12, opacity: 0.6 }}>No postings on this ledger.</p>
              ) : (
                <div className="columnar-report-scroll">
                  <table className="columnar-report-table budget-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Voucher</th>
                        <th>Narration</th>
                        <th className="right">Lent (Dr)</th>
                        <th className="right">Repaid (Cr)</th>
                        <th className="right">FX Rate</th>
                        <th className="right">USD Amount</th>
                        <th className="right">Running USD Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rendered.map((r) => (
                        <tr key={r.key}>
                          <td>{fmtDate(r.date)}</td>
                          <td>
                            {r.voucherType} {r.voucherNumber}
                          </td>
                          <td>{r.narration || "—"}</td>
                          <td className="right">{r.amountInr < 0 ? fmt(-r.amountInr) : "—"}</td>
                          <td className="right">{r.amountInr > 0 ? fmt(r.amountInr) : "—"}</td>
                          <td className="right">{r.rate.toFixed(4)}</td>
                          <td className="right">{usdFmt(r.amountUsd)}</td>
                          <td className="right">{usdFmt(r.runningUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>Total</td>
                        <td className="right">{fmt(rows.filter((r) => r.amountInr < 0).reduce((s, r) => s - r.amountInr, 0))}</td>
                        <td className="right">{fmt(rows.filter((r) => r.amountInr > 0).reduce((s, r) => s + r.amountInr, 0))}</td>
                        <td></td>
                        <td></td>
                        <td className="right">{usdFmt(currentBalanceUsd)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
