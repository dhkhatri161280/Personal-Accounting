"use client";
import { Fragment, useEffect, useState } from "react";
import type { BankReconException, Ledger, Tx } from "@/lib/vault-types";
import { StatIcon } from "@/components/Icon";
import {
  reconciliationStatusForAccounts,
  vaultExceptionKey,
  plaidExceptionKey,
  DIFF_TOL,
  type PlaidAccountSummary,
  type PlaidTxSummary,
  type ReconAccountStatus,
} from "@/lib/plaid-recon";

const MONEY_IN = "#16a34a";
const MONEY_OUT = "#dc2626";

export function BankReconciliation({
  data,
  fmt,
  uiTheme,
  onSave,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  uiTheme?: "classic" | "refresh";
  onSave: (next: Ledger) => Promise<boolean> | boolean;
}) {
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState("");
  const [plaidData, setPlaidData] = useState<{ accounts: PlaidAccountSummary[]; transactions: PlaidTxSummary[] } | null>(null);

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
      setPlaidData({ accounts: accounts ?? [], transactions: transactions ?? [] });
    } catch {
      setStatus("Failed to fetch Plaid data.");
      setPlaidData({ accounts: [], transactions: [] });
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived from state, not stored -- recomputes automatically once `data.bankReconExceptions`
  // changes after a "Mark as reconciled" save, with no need to re-fetch Plaid.
  const rows = plaidData
    ? reconciliationStatusForAccounts(data, plaidData.accounts, plaidData.transactions, new Date().toISOString().slice(0, 10), data.bankReconExceptions)
    : null;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  async function markException(key: string, label: string) {
    const entry: BankReconException = { key, label, markedAt: new Date().toISOString() };
    const next: Ledger = { ...data, bankReconExceptions: [...(data.bankReconExceptions ?? []), entry] };
    await onSave(next);
  }
  async function unmarkException(key: string) {
    const next: Ledger = { ...data, bankReconExceptions: (data.bankReconExceptions ?? []).filter((e) => e.key !== key) };
    await onSave(next);
  }

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
                          <BankReconDetail
                            row={r}
                            fmt={fmt}
                            onMark={markException}
                            onUnmark={unmarkException}
                            exceptions={data.bankReconExceptions ?? []}
                            allTransactions={data.transactions}
                          />
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

function BankReconDetail({
  row,
  fmt,
  onMark,
  onUnmark,
  exceptions,
  allTransactions,
}: {
  row: ReconAccountStatus;
  fmt: (n: number) => string;
  onMark: (key: string, label: string) => void;
  onUnmark: (key: string) => void;
  exceptions: BankReconException[];
  allTransactions: Tx[];
}) {
  // Exceptions already marked for THIS account, whether or not they still appear in the raw
  // unmatched lists (they won't, since reconciliationStatusForAccounts filters them out already)
  // -- shown here so there's a way to undo one. Scoped by checking which real account a "p:" key's
  // Plaid account_id or a "v:" key's vault Tx actually belongs to (the key alone doesn't say).
  const plaidAcctIds = new Set(row.plaidAccounts.map((pa) => pa.account_id));
  const vaultTxGuidsForAccount = new Set(
    allTransactions.filter((t) => t.entries.some((e) => e.accountId === row.account.id)).map((t) => t.guid)
  );
  const markedForAccount = exceptions.filter((e) => {
    if (e.key.startsWith("p:")) return plaidAcctIds.has(e.key.split(":")[1]);
    if (e.key.startsWith("v:")) return vaultTxGuidsForAccount.has(e.key.slice(2));
    return false;
  });
  const [showMarked, setShowMarked] = useState(false);
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
              <div className="report-line bank-recon-exception-row" key={t.transaction_id}>
                <span>
                  {t.date} — {t.name}
                  {t.pending && <em> (pending)</em>}
                </span>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {/* Same sign convention as the "In vault" column below (Plaid's amount already
                      matches this account's Dr/Cr entry sign directly, no flip -- see
                      lib/plaid-recon.ts) -- a genuinely matching pair reads as the identical
                      number in both columns, making a real mismatch easy to spot by eye. */}
                  <strong>{fmt(t.amount)}</strong>
                  <button
                    type="button"
                    className="tr-refresh-btn"
                    title="This will never have a matching vault voucher -- stop flagging it"
                    onClick={() => onMark(plaidExceptionKey(t.account_id, t.transaction_id), `${t.date} — ${t.name}`)}
                  >
                    Mark reconciled
                  </button>
                </span>
              </div>
            ))
        )}
      </div>
      <div className="bank-recon-detail-col">
        <strong>In vault, no Plaid match ({row.unmatchedVault.length})</strong>
        {row.noPlaidTransactionFeed ? (
          <p style={{ opacity: 0.6, fontSize: 12 }}>
            Plaid doesn't provide itemized transactions for this account (common for HSA/investment-type accounts) — only
            the balance above is compared, so there's nothing to flag here.
          </p>
        ) : row.unmatchedVault.length === 0 ? (
          <p style={{ opacity: 0.6, fontSize: 12 }}>None.</p>
        ) : (
          row.unmatchedVault
            .slice()
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((t: Tx) => (
              <div className="report-line bank-recon-exception-row" key={t.guid}>
                <span>
                  {t.date} — {t.narration || t.type}
                </span>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <strong>{fmt(t.entries.filter((e) => e.accountId === row.account.id).reduce((s, e) => s + e.amount, 0))}</strong>
                  <button
                    type="button"
                    className="tr-refresh-btn"
                    title="This will never have a matching Plaid transaction (e.g. cash) -- stop flagging it"
                    onClick={() => onMark(vaultExceptionKey(t.guid), `${t.date} — ${t.narration || t.type}`)}
                  >
                    Mark reconciled
                  </button>
                </span>
              </div>
            ))
        )}
      </div>
      {markedForAccount.length > 0 && (
        <div className="bank-recon-detail-col" style={{ flexBasis: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong>Marked as reconciled ({markedForAccount.length})</strong>
            <button type="button" className="tr-refresh-btn" onClick={() => setShowMarked((v) => !v)}>
              {showMarked ? "Hide" : "Show"}
            </button>
          </div>
          {showMarked &&
            markedForAccount.map((e) => (
              <div className="report-line" key={e.key}>
                <span style={{ opacity: 0.7 }}>{e.label}</span>
                <button type="button" className="tr-refresh-btn" onClick={() => onUnmark(e.key)}>
                  Undo
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
