"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { StatIcon } from "@/components/Icon";
import { compute401kLifetimeTotals } from "@/lib/payroll-401k";

interface PlaidInvestmentAccount {
  account_id: string;
  name: string;
  official_name?: string;
  type: string;    // "investment" for 401k/HSA/IRA accounts
  subtype: string; // "401k" | "hsa" | "ira" | "403b" | ...
  institution_name?: string;
  balances: { current: number | null; available: number | null; iso_currency_code?: string };
  // The trading day these holdings were priced as of -- mutual funds/401k price once per day,
  // well after market close, so this is normal, not staleness. See app/api/plaid/transactions/route.ts.
  pricingAsOf?: string;
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

// Balances are fetched fresh only on explicit Refresh -- switching sub-tabs unmounts/remounts
// this component (see the importSource conditional in VaultApp.tsx), and re-fetching Plaid every
// time someone just clicks back into this tab is exactly the multi-second wait the user asked to
// avoid. Cached in localStorage (not just component state) so it also survives a full page
// reload, not only tab-switching within the same session.
const CACHE_KEY = "dk-retirement-balances-cache";
type Cache = { accounts: PlaidInvestmentAccount[]; fetchedAt: string };

function loadCache(): Cache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cache) : null;
  } catch {
    return null;
  }
}

export function RetirementReport({
  data,
  fmt,
  uiTheme,
  onSave,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  uiTheme?: "classic" | "refresh";
  onSave?: (next: Ledger) => Promise<boolean | void>;
}) {
  const cached = useMemo(loadCache, []);
  const [accounts, setAccounts] = useState<PlaidInvestmentAccount[] | null>(cached?.accounts ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState<Date | null>(cached?.fetchedAt ? new Date(cached.fetchedAt) : null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      // Scope the refresh to ONLY the connections that actually have an investment account
      // (Fidelity, Merrill) -- without this, every Retirement refresh also re-pulls all the
      // regular banks/cards for no reason, needlessly slowing this down and duplicating what
      // the Plaid tab's own Fetch already does. hasInvestmentAccount is cached once per
      // connection server-side (see app/api/plaid/transactions/route.ts); a connection with it
      // still unknown just gets included, so nothing is silently skipped.
      const connsRes = await fetch("/api/plaid/connections");
      const conns = (await connsRes.json()) as { institution_name: string; hasInvestmentAccount?: boolean }[];
      const investmentInstitutions = conns.filter((c) => c.hasInvestmentAccount !== false).map((c) => c.institution_name);
      const qs = investmentInstitutions.length
        ? `?institution=${investmentInstitutions.map(encodeURIComponent).join(",")}`
        : "";
      const r = await fetch(`/api/plaid/transactions${qs}`);
      const json = (await r.json()) as { accounts?: PlaidInvestmentAccount[]; errors?: string[] };
      if (json.errors?.length) setError(json.errors.join(", "));
      const filtered = (json.accounts ?? []).filter((a) => a.type === "investment" && !EXCLUDED_SUBTYPES.has(a.subtype));
      const now = new Date();
      setAccounts(filtered);
      setFetchedAt(now);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ accounts: filtered, fetchedAt: now.toISOString() }));
      } catch {
        // Storage full/unavailable (private browsing, etc.) -- not fatal, just no cache next visit.
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  // Only auto-fetch the very first time there's nothing cached yet -- every subsequent visit to
  // this tab shows the cached numbers instantly, and a fresh pull only happens on Refresh.
  useEffect(() => {
    if (!cached) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lifetime employee vs. employer 401(k) contributions, sourced from imported payroll data
  // (same figures as TaxReport.tsx's "401(k) Contributions by Year" drilldown -- see
  // lib/payroll-401k.ts) rather than the single combined ledger-posting total this used to show,
  // which couldn't separate the two. The gap vs. Fidelity's real balance below is investment
  // growth/loss, plus any period not covered by an imported paystub/Excel.
  const { self: k401Self, employer: k401Employer } = useMemo(() => compute401kLifetimeTotals(data.payroll), [data.payroll]);
  const k401Contributions = k401Self + k401Employer;

  const instRank = (inst: string) => (/fidelity/i.test(inst) ? 0 : /merrill/i.test(inst) ? 1 : 2);
  const grouped = useMemo(() => {
    const byInst = new Map<string, PlaidInvestmentAccount[]>();
    for (const a of accounts ?? []) {
      const key = a.institution_name || "Unknown";
      (byInst.get(key) ?? byInst.set(key, []).get(key)!).push(a);
    }
    return [...byInst.entries()].sort((a, b) => instRank(a[0]) - instRank(b[0]));
  }, [accounts]);

  const plaidBalance = (accounts ?? []).reduce((s, a) => s + (a.balances?.current ?? 0), 0);

  // Retirement money in a private/illiquid investment Plaid can't see (e.g. Merrill IRA funds
  // moved into a private deal) -- manually entered here since the holding account, if any, may
  // also contain non-retirement capital, so only the user-entered retirement portion counts.
  const otherInvestments = data.retirementOtherInvestments ?? [];
  const otherInvestmentsTotal = otherInvestments.reduce((s, r) => s + r.amount, 0);
  const totalBalance = plaidBalance + otherInvestmentsTotal;

  const [newOtherLabel, setNewOtherLabel] = useState("");
  const [newOtherAmount, setNewOtherAmount] = useState("");
  const [savingOther, setSavingOther] = useState(false);

  async function saveOtherInvestments(next: { id: string; label: string; amount: number }[]) {
    if (!onSave) return;
    setSavingOther(true);
    try {
      await onSave({ ...data, retirementOtherInvestments: next });
    } finally {
      setSavingOther(false);
    }
  }

  async function addOtherInvestment() {
    const amount = Number(newOtherAmount);
    if (!newOtherLabel.trim() || !amount) return;
    await saveOtherInvestments([
      ...otherInvestments,
      { id: crypto.randomUUID(), label: newOtherLabel.trim(), amount },
    ]);
    setNewOtherLabel("");
    setNewOtherAmount("");
  }

  async function removeOtherInvestment(id: string) {
    await saveOtherInvestments(otherInvestments.filter((r) => r.id !== id));
  }

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
      {fetchedAt && <p style={{ fontSize: 11, opacity: 0.55, margin: "0 0 12px" }}>Last fetched {fetchedAt.toLocaleDateString()} {fetchedAt.toLocaleTimeString()}</p>}

      {accounts !== null && accounts.length === 0 && !loading && (
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          No 401(k)/IRA accounts found via Plaid yet. Make sure the retirement account was
          included when connecting (some institutions ask you to pick which accounts to share).
        </p>
      )}

      {accounts && accounts.length > 0 && (
        <>
          {k401Contributions > 0 && (
            <div className="data-panel" style={{ marginBottom: 16 }}>
              <h4 style={{ margin: "0 0 8px" }}>Retirement contributions vs. real balance</h4>
              <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
                Not a reconciliation — these are different numbers by design. "Employee" and
                "Employer Match" come from your imported paystubs/payroll Excel (same source as
                Reports &gt; Tax &gt; 401(k) Contributions by Year), covering both the Fidelity
                401(k) and the Merrill IRA. "Current balance" is the combined real number from
                both, which also includes investment growth/loss the payroll data never sees.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Employee (payroll deduction)</div>
                  <strong className="equity-amt">{fmt(k401Self)}</strong>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Employer Match</div>
                  <strong className="equity-amt">{fmt(k401Employer)}</strong>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Current balance (Fidelity + Merrill{otherInvestmentsTotal > 0 ? " + Other" : ""})</div>
                  <strong className="equity-amt">{fmt(totalBalance)}</strong>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>Growth / (loss)</div>
                  <strong className="equity-amt" style={{ color: totalBalance - k401Contributions >= 0 ? "#16a34a" : "#dc2626" }}>
                    {fmt(totalBalance - k401Contributions)}
                  </strong>
                </div>
              </div>
            </div>
          )}

          <div className="data-panel" style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 8px" }}>Other retirement investments (not visible via Plaid)</h4>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
              Retirement money moved into a private or illiquid investment Plaid can't see (e.g. a
              portion of a Merrill IRA put into a private deal). Enter only the retirement portion
              — if the holding account also has non-retirement capital, don't add the full balance.
            </p>
            {otherInvestments.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {otherInvestments.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #edf0f4", fontSize: 13 }}>
                    <span>{r.label}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <strong className="equity-amt">{fmt(r.amount)}</strong>
                      <button
                        type="button"
                        className="tr-refresh-btn"
                        disabled={savingOther}
                        onClick={() => removeOtherInvestment(r.id)}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="text"
                placeholder="Label (e.g. Canyon Investment)"
                value={newOtherLabel}
                onChange={(e) => setNewOtherLabel(e.target.value)}
                style={{ flex: "1 1 220px" }}
              />
              <input
                type="number"
                placeholder="Amount"
                value={newOtherAmount}
                onChange={(e) => setNewOtherAmount(e.target.value)}
                style={{ width: 140 }}
              />
              <button type="button" className="tr-refresh-btn" disabled={savingOther || !newOtherLabel.trim() || !Number(newOtherAmount)} onClick={addOtherInvestment}>
                {savingOther ? "Saving…" : "+ Add"}
              </button>
            </div>
          </div>

          {/* Reuses .dashboard-stats for its button/card chrome (padding, border, typography --
              all of that is scoped to ".dashboard-stats button", not ".dashboard-balance-card"
              alone), but that class also carries a FIXED grid-template-areas built for the
              Dashboard's specific 6 named cards (cash/investment/active/capital/salary/period).
              An arbitrary/variable number of Retirement cards doesn't match any of those names,
              so the browser auto-placed them into leftover cells that overlapped the reserved
              named areas. Overriding grid-template-areas/columns inline (higher specificity than
              the class rule) keeps the chrome but replaces the fixed layout with a plain
              auto-fit grid that actually fits this content. */}
          <div className="stats dashboard-stats" style={{ gridTemplateAreas: "none", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {grouped.map(([inst, accts]) =>
              accts.map((a) => (
                <button key={a.account_id} type="button" className="dashboard-balance-card" style={{ cursor: "default" }}>
                  {uiTheme === "refresh" && <StatIcon kind="bank" color="#0891b2" />}
                  <div className="dashboard-card-main">
                    <span>{inst} — {SUBTYPE_LABEL[a.subtype] || a.subtype}</span>
                    <strong>{fmt(a.balances?.current ?? 0)}</strong>
                    <small>{a.name}{a.pricingAsOf ? ` · priced as of ${a.pricingAsOf}` : ""}</small>
                  </div>
                </button>
              ))
            )}
            {otherInvestments.map((r) => (
              <button key={r.id} type="button" className="dashboard-balance-card" style={{ cursor: "default" }}>
                {uiTheme === "refresh" && <StatIcon kind="bank" color="#0891b2" />}
                <div className="dashboard-card-main">
                  <span>{r.label}</span>
                  <strong>{fmt(r.amount)}</strong>
                  <small>Not tracked via Plaid</small>
                </div>
              </button>
            ))}
            <button type="button" className="dashboard-balance-card" style={{ cursor: "default" }}>
              {uiTheme === "refresh" && <StatIcon kind="scale" color="#7c3aed" />}
              <div className="dashboard-card-main">
                <span>Total retirement</span>
                <strong>{fmt(totalBalance)}</strong>
                <small>
                  Across {accounts.length} account{accounts.length !== 1 ? "s" : ""}
                  {otherInvestments.length > 0 ? ` + ${otherInvestments.length} other` : ""}
                </small>
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
