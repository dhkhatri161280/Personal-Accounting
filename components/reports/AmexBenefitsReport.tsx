"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { fmtDate } from "@/lib/format-date";
import { summarizeAmexBenefits } from "@/lib/amex-benefits";

// Real Amex Platinum benefit utilization -- what you pay (the annual fee, cross-referenced from
// your own real vouchers) against what you actually use (each statement credit's live status,
// imported straight from Amex's own account data via tools/amex-benefits/). See AmexBenefit's own
// comment in lib/vault-types.ts and that tool's README for how this data is captured -- Amex has
// no public API for this, so it's the same no-guessing, real-browser-capture approach already
// proven for Costco receipts in this app.
//
// The annual fee is found by searching real voucher narrations (same best-effort text-match
// approach the narration-based Costco reward estimate already uses elsewhere in this app, NOT a
// guess at Amex's own fee amount) rather than asked for by hand -- shown plainly as "not found"
// when nothing matches, never silently assumed to be $0 or any particular figure.
const FEE_NARRATION_RE = /amex|platinum/i;
const FEE_KEYWORD_RE = /annual fee|membership fee|card fee/i;

// Best-effort search for a real claim reimbursement against a protection/insurance benefit --
// same honest "not found" standard as the annual fee search above, never assumed $0. Each
// benefit maps to one or more word GROUPS (every word in a group must appear, case-insensitive,
// anywhere in the narration); any group matching counts as a hit. Derived from each benefit's own
// real title, not guessed -- but a reimbursement posting with fully generic bank text (just
// "AMERICAN EXPRESS CREDIT", no mention of what it's for) genuinely can't be found this way, so a
// "not found" here means "no narration says so," not "definitely never happened."
const COVERAGE_SEARCH_TERMS: Record<string, string[][]> = {
  "return-protection": [["return", "protection"]],
  "purchase-protection": [["purchase", "protection"]],
  "extended-warranty": [["extended", "warranty"]],
  "cell-phone-protection": [["cell", "protection"], ["phone", "protection"]],
  "baggage-insurance-plan": [["baggage", "insurance"]],
  "premium-car-rental-protection": [["car", "rental", "protection"]],
  "car-rental-insurance": [["car", "rental", "insurance"]],
  "trip-delay-insurance": [["trip", "delay"]],
  "trip-cancel-interrupt-insurance": [["trip", "cancel"], ["trip", "interrupt"]],
  "credit-secure": [["creditsecure"], ["credit", "secure"]],
};

export function AmexBenefitsReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [showInfo, setShowInfo] = useState(false);
  const benefits = useMemo(
    () => [...(data.amexBenefits ?? [])].sort((a, b) => (a.periodEndDate < b.periodEndDate ? -1 : 1)),
    [data.amexBenefits]
  );
  const coverageBenefits = useMemo(
    () => [...(data.amexCoverageBenefits ?? [])].sort((a, b) => (a.title < b.title ? -1 : 1)),
    [data.amexCoverageBenefits]
  );
  const summary = useMemo(() => summarizeAmexBenefits(benefits), [benefits]);

  // Most recent matching voucher within the last ~13 months -- an annual fee should recur roughly
  // once a year, so anything older is a prior cycle's charge, not this one.
  const feeMatch = useMemo(() => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 13);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const candidates = data.transactions.filter(
      (t) => !t.deleted && !t.cancelled && t.date >= cutoffIso && FEE_NARRATION_RE.test(t.narration) && FEE_KEYWORD_RE.test(t.narration)
    );
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.date < b.date ? 1 : -1));
    const v = candidates[0];
    // The fee itself is whichever entry has the larger magnitude (the card's own liability leg,
    // not a tiny tax/rounding leg on the same voucher).
    const amount = Math.max(...v.entries.map((e) => Math.abs(e.amount)));
    return { date: v.date, narration: v.narration, amount };
  }, [data.transactions]);

  const netSoFar = feeMatch ? summary.totalUsed - feeMatch.amount : null;

  // benefitKey -> matched real vouchers (see COVERAGE_SEARCH_TERMS' own comment on what "found"
  // and "not found" actually mean here).
  const coverageClaims = useMemo(() => {
    const out = new Map<string, { date: string; narration: string; amount: number }[]>();
    for (const b of coverageBenefits) {
      const groups = COVERAGE_SEARCH_TERMS[b.benefitKey];
      if (!groups) continue;
      const hits = data.transactions
        .filter((t) => {
          if (t.deleted || t.cancelled) return false;
          const n = t.narration.toLowerCase();
          return groups.some((words) => words.every((w) => n.includes(w)));
        })
        .map((t) => ({ date: t.date, narration: t.narration, amount: Math.max(...t.entries.map((e) => Math.abs(e.amount))) }));
      if (hits.length) out.set(b.benefitKey, hits);
    }
    return out;
  }, [coverageBenefits, data.transactions]);

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Amex Platinum Benefits
        <span
          className="info-icon-wrap"
          onMouseEnter={() => setShowInfo(true)}
          onMouseLeave={() => setShowInfo(false)}
        >
          <button
            type="button"
            className="info-icon-btn"
            aria-label="About this report"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Real usage data imported from your own Amex account (Masters → Amex Benefits) --
              tools/amex-benefits/ captures it straight from Amex's own ReadBestLoyaltyBenefitsTrackers
              data, the same thing your account's own Benefits page shows. Each benefit's current/used/
              remaining figures are only as fresh as your last import -- re-run the capture periodically
              to keep this current. The annual fee above is found by searching your real voucher
              narrations for "Amex"/"Platinum" plus "annual fee"/"membership fee" -- not a guessed
              amount, and shown as "not found" rather than $0 when nothing matches.
            </div>
          )}
        </span>
      </h3>
      <div style={{ marginBottom: 16 }}>
        {!benefits.length ? (
          <p style={{ opacity: 0.7 }}>
            No benefit data imported yet. Run the capture tool at <code>tools/amex-benefits/</code>,
            then import the <code>benefits.json</code> it produces from Masters → Amex Benefits.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Annual fee{feeMatch ? ` (${fmtDate(feeMatch.date)})` : ""}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{feeMatch ? fmt(feeMatch.amount) : "not found"}</div>
            </span>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Used so far (current cycles)</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#16a34a" }}>{fmt(summary.totalUsed)}</div>
            </span>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Available this cycle set</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{fmt(summary.totalTarget)}</div>
            </span>
            {netSoFar != null && (
              <span>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Net so far (used − fee)</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: netSoFar >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(netSoFar)}</div>
              </span>
            )}
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Achieved / in progress</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {summary.achievedCount} / {summary.achievedCount + summary.inProgressCount}
              </div>
            </span>
          </div>
        )}
      </div>

      {benefits.length > 0 && (
        <table className="fx-ledger-table">
          <thead>
            <tr>
              <th>Benefit</th>
              <th>Status</th>
              <th>Progress</th>
              <th className="right">Used</th>
              <th className="right">Target</th>
              <th>Cadence</th>
              <th>Resets</th>
            </tr>
          </thead>
          <tbody>
            {benefits.map((b) => {
              const pct = b.targetAmount > 0 ? Math.min(100, Math.round((b.spentAmount / b.targetAmount) * 100)) : 0;
              const achieved = b.status === "ACHIEVED";
              return (
                <tr key={b.benefitId}>
                  <td className="fx-narration">{b.benefitName}</td>
                  <td style={{ color: achieved ? "#16a34a" : undefined, fontWeight: achieved ? 700 : undefined }}>
                    {achieved ? "✓ Achieved" : "In progress"}
                  </td>
                  <td style={{ minWidth: 120 }}>
                    <div style={{ background: "#edf0f4", borderRadius: 4, height: 8, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, background: achieved ? "#16a34a" : "#2563eb", height: "100%" }} />
                    </div>
                  </td>
                  <td className="right">{fmt(b.spentAmount)}</td>
                  <td className="right">{fmt(b.targetAmount)}</td>
                  <td>{b.trackerDuration || "—"}</td>
                  <td>{b.periodEndDate ? fmtDate(b.periodEndDate) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {coverageBenefits.length > 0 && (
        <>
          <h4 style={{ margin: "20px 0 8px" }}>Protection &amp; Insurance</h4>
          <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 10px" }}>
            Claim-based coverage, not statement credits -- there's no running spend/remaining balance from
            Amex the way the credits above have. "Limit" is parsed straight out of Amex's own terms (left
            blank when Amex's copy doesn't state a dollar figure -- several of these only say "coverage
            limits apply", with the real numbers in a separate certificate of insurance this doesn't have
            access to). "Found in your vouchers" is a best-effort search of your real narrations for a
            matching reimbursement -- "not found" means no voucher says so, not that it definitely never
            happened (a generic "AMERICAN EXPRESS CREDIT" posting with no description can't be matched this way).
          </p>
          <table className="fx-ledger-table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>Benefit</th>
                <th>Real coverage terms (from Amex)</th>
                <th style={{ width: 140 }}>Limit</th>
                <th style={{ width: 170 }}>Found in your vouchers</th>
              </tr>
            </thead>
            <tbody>
              {coverageBenefits.map((b) => {
                const claims = coverageClaims.get(b.benefitKey);
                const claimsTotal = claims?.reduce((s, c) => s + c.amount, 0);
                const limitBits: string[] = [];
                if (b.perClaimLimit != null) limitBits.push(`${fmt(b.perClaimLimit)}/claim`);
                if (b.periodLimit != null) limitBits.push(`${fmt(b.periodLimit)} ${b.periodLabel || ""}`.trim());
                if (b.deductible != null) limitBits.push(`${fmt(b.deductible)} deductible`);
                if (b.claimsPerPeriod != null) limitBits.push(`max ${b.claimsPerPeriod} claims`);
                if (b.monthlyCost != null) limitBits.push(`${fmt(b.monthlyCost)}/mo after trial`);
                return (
                  <tr key={b.benefitKey}>
                    <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>{b.title}</td>
                    <td style={{ fontSize: 12, whiteSpace: "normal" }}>{b.summary}</td>
                    <td style={{ fontSize: 12, verticalAlign: "top" }}>
                      {limitBits.length ? limitBits.map((bit, i) => <div key={i}>{bit}</div>) : <span style={{ opacity: 0.4 }}>—</span>}
                    </td>
                    <td style={{ fontSize: 12, verticalAlign: "top" }}>
                      {claims?.length ? (
                        <span title={claims.map((c) => `${fmtDate(c.date)}: ${c.narration}`).join("\n")}>
                          {fmt(claimsTotal!)} ({claims.length} voucher{claims.length === 1 ? "" : "s"})
                        </span>
                      ) : (
                        <span style={{ opacity: 0.4 }}>not found</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
