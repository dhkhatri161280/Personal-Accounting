"use client";
import { Fragment, useEffect, useState } from "react";
import type { Ledger, Tx } from "@/lib/vault-types";
import { StatIcon } from "@/components/Icon";
import {
  reconciliationStatusForAccounts,
  DIFF_TOL,
  type PlaidAccountSummary,
  type PlaidTxSummary,
  type ReconAccountStatus,
} from "@/lib/plaid-recon";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

export function BankReconciliation({ data, fmt, uiTheme }: { data: Ledger; fmt: (n: number) => string; uiTheme?: "classic" | "refresh" }) {
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<ReconAccountStatus[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  async function load() {
    setFetching(true);
    setStatus("Fetching live balances from Plaid…");
    try {
      const r = await fetch("/api/plaid/transactions");
      const { transactions, accounts, errors } = (await r.json()) as {
        transactions: PlaidTxSummary[];
        accounts: PlaidAccountSummary[];
        errors?: string[];
      };
      if (errors?.length) setStatus(`Partial fetch — ${errors.join(", ")}`);
      else setStatus("");
      const today = new Date().toISOString().slice(0, 10);
      setRows(reconciliationStatusForAccounts(data, accounts ?? [], transactions ?? [], today));
    } catch {
      setStatus("Failed to fetch Plaid data.");
      setRows([]);
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const reconciled = (rows ?? []).filter((r) => Math.abs(r.diff) <= DIFF_TOL).length;
  const total = rows?.length ?? 0;
  const needsAttention = total - reconciled;
  const totalUnmatched = (rows ?? []).reduce((s, r) => s + r.unmatchedPlaid.length + r.unmatchedVault.length, 0);

  const summaryCards: { label: string; value: string; icon: "bank" | "scale" | "receipt"; color: string }[] = [
    { label: "Accounts Reconciled", value: `${reconciled} / ${total}`, icon: "bank", color: needsAttention > 0 ? MONEY_OUT : MONEY_IN },
    { label: "Need Attention", value: String(needsAttention), icon: "scale", color: needsAttention > 0 ? MONEY_OUT : MONEY_IN },
    { label: "Unmatched Transactions", value: String(totalUnmatched), icon: "receipt", color: totalUnmatched > 0 ? MONEY_OUT : MONEY_IN },
  ];

  return (
    <div className="data-panel">
      <div className="equity-summary-row" style={{ marginBottom: "0.75rem" }}>
        {summaryCards.map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div className="equity-summary-card">
              {uiTheme === "refresh" && <StatIcon kind={c.icon} color={c.color} />}
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <strong className="equity-amt" style={{ color: c.color }}>
                  {c.value}
                </strong>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="report-view-toggle-row">
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          {rows === null
            ? status || "Loading…"
            : total === 0
              ? "No Plaid-connected accounts matched a vault ledger by name."
              : status || "Live balances from Plaid, compared against the vault's own computed balance."}
        </span>
        <button type="button" className="tr-refresh-btn" disabled={fetching} onClick={load}>
          {fetching ? "Refreshing…" : "⟳ Refresh"}
        </button>
      </div>
      {rows !== null && total > 0 && (
        <div className="columnar-report-scroll">
          <table className="columnar-report-table budget-table">
            <thead>
              <tr>
                <th></th>
                <th className="right">Plaid Balance</th>
                <th className="right">Vault Balance</th>
                <th className="right">Diff</th>
                <th className="right">Unmatched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isE = expanded.has(r.account.id);
                const materialDiff = Math.abs(r.diff) > DIFF_TOL;
                const unmatchedCount = r.unmatchedPlaid.length + r.unmatchedVault.length;
                return (
                  <Fragment key={r.account.id}>
                    <tr className="columnar-group-row">
                      <td>
                        <button type="button" className="group-heading" onClick={() => toggle(r.account.id)}>
                          <span className="bs-arr">{isE ? "-" : "+"}</span>
                          <strong>{r.account.name}</strong>
                          {r.plaidAccounts.length > 1 && (
                            <small style={{ opacity: 0.6, fontWeight: 400 }}>({r.plaidAccounts.length} Plaid accounts combined)</small>
                          )}
                        </button>
                      </td>
                      <td className="right">{fmt(r.plaidBalance)}</td>
                      <td className="right">{fmt(r.vaultBalance)}</td>
                      <td className="right" style={{ color: materialDiff ? MONEY_OUT : MONEY_IN }}>
                        {materialDiff ? `${r.diff >= 0 ? "+" : ""}${fmt(r.diff)}` : "Matched"}
                      </td>
                      <td className="right" style={{ color: unmatchedCount > 0 ? MONEY_OUT : undefined }}>
                        {unmatchedCount || "–"}
                      </td>
                    </tr>
                    {isE && (
                      <tr className="budget-detail-row">
                        <td colSpan={5}>
                          <BankReconDetail row={r} fmt={fmt} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BankReconDetail({ row, fmt }: { row: ReconAccountStatus; fmt: (n: number) => string }) {
  return (
    <div className="bank-recon-detail">
      {row.plaidAccounts.length > 1 && (
        <div className="bank-recon-detail-col" style={{ flexBasis: "100%" }}>
          <strong>Plaid accounts combined into this row</strong>
          {row.plaidAccounts.map((pa) => (
            <div className="report-line" key={pa.account_id}>
              <span>{pa.name}</span>
              <strong>{fmt(pa.type === "depository" ? (pa.balances.available ?? pa.balances.current ?? 0) : (pa.balances.current ?? 0))}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="bank-recon-detail-col">
        <strong>In Plaid, not yet in vault ({row.unmatchedPlaid.length})</strong>
        {row.unmatchedPlaid.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 12 }}>None.</p>
        ) : (
          row.unmatchedPlaid
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((t) => (
              <div className="report-line" key={t.transaction_id}>
                <span>
                  {t.date} — {t.name}
                  {t.pending && <em> (pending)</em>}
                </span>
                <strong>{fmt(-t.amount)}</strong>
              </div>
            ))
        )}
      </div>
      <div className="bank-recon-detail-col">
        <strong>In vault, no Plaid match ({row.unmatchedVault.length})</strong>
        {row.unmatchedVault.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 12 }}>None.</p>
        ) : (
          row.unmatchedVault
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((t: Tx) => (
              <div className="report-line" key={t.guid}>
                <span>
                  {t.date} — {t.narration || t.type}
                </span>
                <strong>{fmt(t.entries.filter((e) => e.accountId === row.account.id).reduce((s, e) => s + e.amount, 0))}</strong>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
