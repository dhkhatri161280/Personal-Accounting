"use client";
import { useMemo, useState } from "react";
import type { Ledger, Tx, AmexCoverageBenefit } from "@/lib/vault-types";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { summarizeAmexBenefits, selfReportedUberCashUsed } from "@/lib/amex-benefits";

// Matched-voucher amount -- whichever entry has the larger magnitude (the card's own liability
// leg, not a tiny tax/rounding leg on the same voucher). Shared by the fee match and every
// coverage-claim match below, so the figure shown next to a drill-down link is always the same
// one used in the report's own totals.
function matchAmount(t: Tx): number {
  return Math.max(...t.entries.map((e) => Math.abs(e.amount)));
}

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

export function AmexBenefitsReport({
  data,
  fmt,
  onSave,
  onViewVoucher,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onSave?: (next: Ledger) => void;
  onViewVoucher?: (t: Tx) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const benefits = useMemo(
    () => [...(data.amexBenefits ?? [])].sort((a, b) => (a.periodEndDate < b.periodEndDate ? -1 : 1)),
    [data.amexBenefits]
  );
  const coverageBenefits = useMemo(
    () => [...(data.amexCoverageBenefits ?? [])].sort((a, b) => (a.title < b.title ? -1 : 1)),
    [data.amexCoverageBenefits]
  );
  const inactiveCredits = useMemo(
    () => [...(data.amexInactiveCredits ?? [])].sort((a, b) => (a.title < b.title ? -1 : 1)),
    [data.amexInactiveCredits]
  );
  const summary = useMemo(() => summarizeAmexBenefits(benefits), [benefits]);

  // Self-reported usage (see selfReportedUberCashUsed's own comment) -- only ever nonzero for a
  // benefit the user has explicitly toggled on, keyed and totaled separately from every other
  // (real, Amex- or voucher-verified) figure in this report so it's never silently blended in.
  const selfReportedTotal = useMemo(() => {
    const todayIso = todayLocalIso();
    return inactiveCredits.reduce((s, b) => s + (b.selfReportedFullyUsed ? selfReportedUberCashUsed(todayIso) : 0), 0);
  }, [inactiveCredits]);

  function toggleSelfReported(b: AmexCoverageBenefit) {
    if (!onSave) return;
    const next = (data.amexInactiveCredits ?? []).map((x) =>
      x.benefitKey === b.benefitKey ? { ...x, selfReportedFullyUsed: !x.selfReportedFullyUsed } : x
    );
    onSave({ ...data, amexInactiveCredits: next });
  }

  // Most recent matching voucher within the last ~13 months -- an annual fee should recur roughly
  // once a year, so anything older is a prior cycle's charge, not this one. Keeps the real Tx
  // (not just extracted fields) so the amount can drill straight down to the actual voucher.
  const feeMatch = useMemo(() => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 13);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const candidates = data.transactions.filter(
      (t) => !t.deleted && !t.cancelled && t.date >= cutoffIso && FEE_NARRATION_RE.test(t.narration) && FEE_KEYWORD_RE.test(t.narration)
    );
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.date < b.date ? 1 : -1));
    return candidates[0];
  }, [data.transactions]);

  // benefitKey -> matched real vouchers (see COVERAGE_SEARCH_TERMS' own comment on what "found"
  // and "not found" actually mean here). Real Tx objects, not just extracted fields, so each one
  // can drill straight down to the actual voucher.
  const coverageClaims = useMemo(() => {
    const out = new Map<string, Tx[]>();
    for (const b of coverageBenefits) {
      const groups = COVERAGE_SEARCH_TERMS[b.benefitKey];
      if (!groups) continue;
      const hits = data.transactions.filter((t) => {
        if (t.deleted || t.cancelled) return false;
        const n = t.narration.toLowerCase();
        return groups.some((words) => words.every((w) => n.includes(w)));
      });
      if (hits.length) out.set(b.benefitKey, hits);
    }
    return out;
  }, [coverageBenefits, data.transactions]);

  const totalCoverageClaims = useMemo(() => {
    let total = 0;
    for (const hits of coverageClaims.values()) for (const t of hits) total += matchAmount(t);
    return total;
  }, [coverageClaims]);

  const netSoFarWithClaims = feeMatch ? summary.totalUsed + totalCoverageClaims + selfReportedTotal - matchAmount(feeMatch) : null;

  // Coverage benefits with a real matched voucher, and inactive credits the user has explicitly
  // self-reported as used -- pulled together into one table above the summary stats so everything
  // with an actual dollar figure behind it is reviewable in one place, instead of scattered across
  // the Protection & Insurance and Not Tracked tables further down. A row lands here the moment it
  // has a claim or is self-reported, and drops back out (below) the moment that's no longer true --
  // e.g. unchecking "I use this every month" sends Uber Cash back down to Not Tracked by Amex.
  const foundCoverageBenefits = useMemo(() => coverageBenefits.filter((b) => coverageClaims.has(b.benefitKey)), [coverageBenefits, coverageClaims]);
  const selfReportedCredits = useMemo(() => inactiveCredits.filter((b) => b.selfReportedFullyUsed), [inactiveCredits]);
  const remainingCoverageBenefits = useMemo(() => coverageBenefits.filter((b) => !coverageClaims.has(b.benefitKey)), [coverageBenefits, coverageClaims]);
  const remainingInactiveCredits = useMemo(() => inactiveCredits.filter((b) => !b.selfReportedFullyUsed), [inactiveCredits]);

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

      {(foundCoverageBenefits.length > 0 || selfReportedCredits.length > 0) && (
        <>
          <h4 style={{ margin: "0 0 8px" }}>Claims found &amp; self-reported usage</h4>
          <table className="fx-ledger-table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ width: 170 }}>Benefit</th>
                <th>Real terms (from Amex)</th>
                <th style={{ width: 170 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {foundCoverageBenefits.map((b) => {
                const claims = coverageClaims.get(b.benefitKey)!;
                const claimsTotal = claims.reduce((s, t) => s + matchAmount(t), 0);
                return (
                  <tr key={b.benefitKey}>
                    <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>{b.title}</td>
                    <td style={{ fontSize: 12, whiteSpace: "normal" }}>{b.summary}</td>
                    <td style={{ fontSize: 12, verticalAlign: "top" }}>
                      <div style={{ marginBottom: 2 }}>
                        {fmt(claimsTotal)} ({claims.length} voucher{claims.length === 1 ? "" : "s"})
                      </div>
                      {claims.map((t) =>
                        onViewVoucher ? (
                          <button
                            key={t.guid}
                            type="button"
                            className="columnar-cell-btn"
                            style={{ display: "block", fontSize: 12 }}
                            title={t.narration}
                            onClick={() => onViewVoucher(t)}
                          >
                            {fmtDate(t.date)}: {fmt(matchAmount(t))}
                          </button>
                        ) : (
                          <div key={t.guid} title={t.narration}>
                            {fmtDate(t.date)}: {fmt(matchAmount(t))}
                          </div>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
              {selfReportedCredits.map((b) => (
                <tr key={b.benefitKey}>
                  <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>{b.title}</td>
                  <td style={{ fontSize: 12, whiteSpace: "normal" }}>{b.summary}</td>
                  <td style={{ fontSize: 12, verticalAlign: "top" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: onSave ? "pointer" : "default" }}>
                      <input type="checkbox" checked disabled={!onSave} onChange={() => toggleSelfReported(b)} />
                      self-reported: <strong style={{ color: "#2563eb" }}>{fmt(selfReportedUberCashUsed(todayLocalIso()))}</strong>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

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
              {feeMatch && onViewVoucher ? (
                <button
                  type="button"
                  className="columnar-cell-btn"
                  style={{ fontSize: 20, fontWeight: 700 }}
                  title="Open the matching voucher"
                  onClick={() => onViewVoucher(feeMatch)}
                >
                  {fmt(matchAmount(feeMatch))}
                </button>
              ) : (
                <div style={{ fontSize: 20, fontWeight: 700 }}>{feeMatch ? fmt(matchAmount(feeMatch)) : "not found"}</div>
              )}
            </span>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Used year to date</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#16a34a" }}>{fmt(summary.totalUsed)}</div>
            </span>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Annual potential</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{fmt(summary.totalTarget)}</div>
            </span>
            <span>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Protection claims found in your vouchers</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: totalCoverageClaims > 0 ? "#16a34a" : undefined }}>
                {fmt(totalCoverageClaims)}
              </div>
            </span>
            {selfReportedTotal > 0 && (
              <span>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Uber Cash (self-reported, not Amex-verified)</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#2563eb" }}>{fmt(selfReportedTotal)}</div>
              </span>
            )}
            {netSoFarWithClaims != null && (
              <span>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Net so far (used{totalCoverageClaims > 0 ? " + claims" : ""}
                  {selfReportedTotal > 0 ? " + self-reported" : ""} − fee)
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: netSoFarWithClaims >= 0 ? "#16a34a" : "#dc2626" }}>
                  {fmt(netSoFarWithClaims)}
                </div>
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
              <th>YTD progress</th>
              <th className="right">Used YTD</th>
              <th className="right">Annual value</th>
              <th>This cycle</th>
              <th>Cadence</th>
              <th>Resets</th>
            </tr>
          </thead>
          <tbody>
            {benefits.map((b) => {
              // YTD against the real annual value -- NOT the current sub-period's own target,
              // which would make e.g. Resy's $296.12/$400 look like a near-empty 0% bar when read
              // against its $100 current-quarter target alone.
              const pct = b.annualTargetAmount > 0 ? Math.min(100, Math.round((b.yearToDateAmount / b.annualTargetAmount) * 100)) : 0;
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
                  <td className="right">{fmt(b.yearToDateAmount)}</td>
                  <td className="right">{fmt(b.annualTargetAmount)}</td>
                  <td style={{ fontSize: 12, opacity: 0.75, whiteSpace: "nowrap" }}>
                    {fmt(b.spentAmount)} / {fmt(b.targetAmount)}
                  </td>
                  <td>{b.trackerDuration || "—"}</td>
                  <td>{b.periodEndDate ? fmtDate(b.periodEndDate) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {remainingCoverageBenefits.length > 0 && (
        <>
          <h4 style={{ margin: "20px 0 8px" }}>Protection &amp; Insurance</h4>
          <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 10px" }}>
            Claim-based coverage, not statement credits -- there's no running spend/remaining balance from
            Amex the way the credits above have. "Limit" is parsed straight out of Amex's own terms (left
            blank when Amex's copy doesn't state a dollar figure -- several of these only say "coverage
            limits apply", with the real numbers in a separate certificate of insurance this doesn't have
            access to). Nothing matched here yet -- once a real voucher is found for one of these, it moves
            up into "Claims found &amp; self-reported usage" above.
          </p>
          <table className="fx-ledger-table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>Benefit</th>
                <th>Real coverage terms (from Amex)</th>
                <th style={{ width: 140 }}>Limit</th>
              </tr>
            </thead>
            <tbody>
              {remainingCoverageBenefits.map((b) => {
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {remainingInactiveCredits.length > 0 && (
        <>
          <h4 style={{ margin: "20px 0 8px" }}>Not Tracked by Amex</h4>
          <p style={{ fontSize: 11, opacity: 0.6, margin: "0 0 10px" }}>
            Real credits your account has access to per Amex's own catalog, but with no active usage tracker
            on Amex's side -- confirmed with Amex support for $200 Uber Cash: it's credited straight to your
            Uber account on the 1st of each month, bypassing Amex's own tracking entirely, so this will never
            show real usage numbers here automatically, regardless of enrollment. "I use this every month" is
            YOUR OWN direct statement, not anything Amex or this app verified -- always labeled self-reported,
            kept separate from every other (Amex- or voucher-verified) figure here, and never defaulted to on
            its own. Checking it moves this row up into "Claims found &amp; self-reported usage" above.
          </p>
          <table className="fx-ledger-table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>Benefit</th>
                <th>Real terms (from Amex)</th>
                <th style={{ width: 140 }}>Value</th>
                <th style={{ width: 170 }}>Self-reported usage</th>
              </tr>
            </thead>
            <tbody>
              {remainingInactiveCredits.map((b) => {
                // Only Uber Cash's specific $15/mo + $20-in-December math applies here -- gated by
                // key, not offered generically, so a future differently-structured inactive credit
                // doesn't get an incorrect self-report option.
                const supportsSelfReport = b.benefitKey === "uber-rides-with-platinum";
                return (
                  <tr key={b.benefitKey}>
                    <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>{b.title}</td>
                    <td style={{ fontSize: 12, whiteSpace: "normal" }}>{b.summary}</td>
                    <td style={{ fontSize: 12, verticalAlign: "top" }}>
                      {b.periodLimit != null ? `${fmt(b.periodLimit)} ${b.periodLabel || ""}`.trim() : <span style={{ opacity: 0.4 }}>—</span>}
                    </td>
                    <td style={{ fontSize: 12, verticalAlign: "top" }}>
                      {supportsSelfReport ? (
                        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: onSave ? "pointer" : "default" }}>
                          <input
                            type="checkbox"
                            checked={!!b.selfReportedFullyUsed}
                            disabled={!onSave}
                            onChange={() => toggleSelfReported(b)}
                          />
                          I use this every month
                          {b.selfReportedFullyUsed && (
                            <strong style={{ color: "#2563eb" }}>{fmt(selfReportedUberCashUsed(todayLocalIso()))}</strong>
                          )}
                        </label>
                      ) : (
                        <span style={{ opacity: 0.4 }}>—</span>
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
