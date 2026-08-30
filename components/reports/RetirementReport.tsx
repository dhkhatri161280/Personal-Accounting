"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { StatIcon } from "@/components/Icon";

interface PlaidInvestmentAccount {
  account_id: string;
  name: string;
  official_name?: string;
  type: string;    // "investment" for 401k/HSA/IRA accounts
  subtype: string; // "401k" | "hsa" | "ira" | "403b" | ...
  institution_name?: string;
  balances: { current: number | null; available: number | null; iso_currency_code?: string };
}

const SUBTYPE_LABEL: Record<string, string> = {
  "401k": "401(k)",
  "403b": "403(b)",
  ira: "IRA",
  roth: "Roth IRA",
};
// HSA lives in the Import > Plaid > Balances tab instead -- once it has a real Bank-group ledger
// (see matchVaultAccount in PlaidImport.tsx), it should be reconciled the same way as any other
// bank account (Plaid balance vs. vault balance, expect ~$0 difference), not lumped in here with
// 401K's fundamentally different "don't expect these to match" framing.
const EXCLUDED_SUBTYPES = new Set(["hsa"]);

// Sums every posted entry against a specific account name -- the account's own running balance,
// same asset sign convention used throughout this app (entries store debit-negative/credit-
// positive; an asset's real value is the negated sum). Deliberately NOT scoped to the dashboard's
// selected financial period: contribution tracking is a running total across all time, same as
// any other balance-sheet account, not something that resets or restarts per FY.
function ledgerAccountBalance(data: Ledger, accountName: string): number {
  let sum = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    for (const e of t.entries) if (e.accountName === accountName) sum += e.amount;
  }
  return -sum;
}

export function RetirementReport({ data, fmt, uiTheme }: { data: Ledger; fmt: (n: number) => string; uiTheme?: "classic" | "refresh" }) {
  const [accounts, setAccounts] = useState<PlaidInvestmentAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/plaid/transactions");
      const json = (await r.json()) as { accounts?: PlaidInvestmentAccount[]; errors?: string[] };
      if (json.errors?.length) setError(json.errors.join(", "));
      setAccounts((json.accounts ?? []).filter((a) => a.type === "investment" && !EXCLUDED_SUBTYPES.has(a.subtype)));
      setFetchedAt(new Date());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cumulative payroll contributions already tracked in the ledger (the existing "401K
  // Investments" account, also shown as a Dashboard highlight) -- a genuinely different number
  // from Fidelity's real balance below, not something that should ever be expected to match it.
  // The gap between them is investment growth/loss plus any employer match, which the ledger
  // doesn't record on its own.
  const k401Contributions = useMemo(() => ledgerAccountBalance(data, "401K Investments"), [data]);

  const grouped = useMemo(() => {
    const byInst = new Map<string, PlaidInvestmentAccount[]>();
    for (const a of accounts ?? []) {
      const key = a.institution_name || "Unknown";
      (byInst.get(key) ?? byInst.set(key, []).get(key)!).push(a);
    }
    return [...byInst.entries()];
  }, [accounts]);

  const totalBalance = (accounts ?? []).reduce((s, a) => s + (a.balances?.current ?? 0), 0);

  return (
    <div className="data-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>Retirement</h3>
          <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
            Live balances from Plaid's Balances product (already covered by your existing Fidelity
            connection -- no separate Investments product enabled). Fund-level holdings/allocation
            aren't available here yet, only total account balance. HSA has its own reconciliation
            in Import &gt; Plaid &gt; Balances instead, since it's tracked as a real ledger account.
          </p>
        </div>
        <button className="tr-refresh-btn" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {error && <p style={{ fontSize: 12, color: "#dc2626" }}>Error: {error}</p>}
      {fetchedAt && <p style={{ fontSize: 11, opacity: 0.55, margin: "0 0 12px" }}>Last fetched {fetchedAt.toLocaleTimeString()}</p>}

      {accounts !== null && accounts.length === 0 && !loading && (
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          No 401(k)/IRA accounts found via Plaid yet. Make sure the retirement account was
          included when connecting (some institutions ask you to pick which accounts to share).
        </p>
      )}

      {accounts && accounts.length > 0 && (
        <>
          <div className="dashboard-stats" style={{ marginBottom: 16 }}>
            {grouped.map(([inst, accts]) =>
              accts.map((a) => (
                <div key={a.account_id} className="dashboard-card-slot">
                  <div className="dashboard-balance-card" style={{ cursor: "default" }}>
                    {uiTheme === "refresh" && <StatIcon kind="bank" color="#0891b2" />}
                    <div className="dashboard-card-main">
                      <span>{inst} — {SUBTYPE_LABEL[a.subtype] || a.subtype}</span>
                      <strong>{fmt(a.balances?.current ?? 0)}</strong>
                      <small>{a.name}</small>
                    </div>
                  </div>
                </div>
              ))
            )}
            <div className="dashboard-card-slot">
              <div className="dashboard-balance-card" style={{ cursor: "default" }}>
                {uiTheme === "refresh" && <StatIcon kind="scale" color="#7c3aed" />}
                <div className="dashboard-card-main">
                  <span>Total retirement</span>
                  <strong>{fmt(totalBalance)}</strong>
                  <small>Across {accounts.length} account{accounts.length !== 1 ? "s" : ""}</small>
                </div>
              </div>
            </div>
          </div>

          {k401Contributions > 0 && (
            <div className="data-panel" style={{ marginTop: 4 }}>
              <h4 style={{ margin: "0 0 8px" }}>401(k) contributions vs. real balance</h4>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
                Not a reconciliation — these are two different numbers by design. "Contributed"
                is your payroll ledger's running total (what's come out of your paycheck);
                "Current balance" is Fidelity's real number, which also includes employer match
                and investment growth/loss the ledger never sees.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Contributed (payroll ledger)</div>
                  <strong className="equity-amt">{fmt(k401Contributions)}</strong>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Current balance (Fidelity)</div>
                  <strong className="equity-amt">
                    {fmt((accounts ?? []).filter((a) => a.subtype === "401k").reduce((s, a) => s + (a.balances?.current ?? 0), 0))}
                  </strong>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Growth + employer match</div>
                  <strong className="equity-amt" style={{ color: "#16a34a" }}>
                    {fmt((accounts ?? []).filter((a) => a.subtype === "401k").reduce((s, a) => s + (a.balances?.current ?? 0), 0) - k401Contributions)}
                  </strong>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
