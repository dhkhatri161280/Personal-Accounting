"use client";
import { useMemo, useState } from "react";
import type { Ledger, Tx, AmexBenefit, AmexCoverageBenefit } from "@/lib/vault-types";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { summarizeAmexBenefits, selfReportedUberCashUsed, effectiveYearToDate } from "@/lib/amex-benefits";

// Matched-voucher amount -- whichever entry has the larger magnitude (the card's own liability
// leg, not a tiny tax/rounding leg on the same voucher). Shared by the fee match and every
// coverage-claim match below, so the figure shown next to a drill-down link is always the same
// one used in the report's own totals.
function matchAmount(t: Tx): number {
  return Math.max(...t.entries.map((e) => Math.abs(e.amount)));
}

const FEE_NARRATION_RE = /amex|platinum/i;
const FEE_KEYWORD_RE = /annual fee|membership fee|card fee/i;

// Best-effort search for a real claim reimbursement against a protection/insurance benefit, by
// ledger voucher narration. Real, but incomplete -- the ledger's own posting text doesn't always
// say "return"/"protection" etc, which is exactly why AmexCoverageBenefit.statementClaims exists
// as a second, hand-reconciled source (see its own comment in lib/vault-types.ts). Both are
// combined below, each filtered to the CURRENT calendar year -- Amex resets these claim caps
// every calendar year, so a prior year's claim must never count against this year's cap.
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

// A single real claim/credit event, however it was found -- a matched ledger voucher (clickable)
// or a hand-reconciled Amex statement line (not, since there's no Tx to open).
type ClaimEvent = { date: string; amount: number; voucher?: Tx };

// One row in the single unified table -- a tagged union over the three real data shapes
// (AmexBenefit trackers, AmexCoverageBenefit claims, AmexCoverageBenefit self-reported) so they
// can share one table/sort/totals instead of three separate tables, per direct request.
type Row =
  | { kind: "credit"; key: string; name: string; usedAmount: number; annualValue?: number; benefit: AmexBenefit }
  | { kind: "protection"; key: string; name: string; usedAmount: number; annualValue?: number; benefit: AmexCoverageBenefit; claims: ClaimEvent[] }
  | { kind: "inactive"; key: string; name: string; usedAmount: number; annualValue?: number; benefit: AmexCoverageBenefit };

// Small ⓘ hover/click popover -- same pattern as the report header's own info icon, reused per
// row so a row's full Amex terms text doesn't have to sit inline in the table (keeps rows to one
// line, per direct request for less text).
function InfoIcon({ id, open, setOpen, children }: { id: string; open: string | null; setOpen: (id: string | null) => void; children: React.ReactNode }) {
  const isOpen = open === id;
  return (
    <span className="info-icon-wrap" onMouseEnter={() => setOpen(id)} onMouseLeave={() => setOpen(null)}>
      <button type="button" className="info-icon-btn" aria-label="More information" onClick={() => setOpen(isOpen ? null : id)}>
        ⓘ
      </button>
      {isOpen && <div className="info-icon-popover info-icon-popover-left" style={{ textAlign: "left" }}>{children}</div>}
    </span>
  );
}

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
  const [rowInfo, setRowInfo] = useState<string | null>(null);
  const currentYear = useMemo(() => todayLocalIso().slice(0, 4), []);

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
  const summary = useMemo(() => summarizeAmexBenefits(benefits, currentYear), [benefits, currentYear]);

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

  // benefitKey -> every real claim event THIS CALENDAR YEAR, combining voucher-narration matches,
  // hand-reconciled Amex statement claims with a confirmed exact voucherGuid (also clickable -- for
  // when the real voucher's own narration doesn't use words the regex search could ever match), and
  // statement claims with no known voucher at all (not clickable -- confirmed real, just nothing to
  // open). All filtered to currentYear since Amex resets these caps annually -- a claim from a
  // prior year must not inflate this year's use.
  const txByGuid = useMemo(() => new Map(data.transactions.map((t) => [t.guid, t])), [data.transactions]);
  const coverageClaims = useMemo(() => {
    const out = new Map<string, ClaimEvent[]>();
    for (const b of coverageBenefits) {
      const events: ClaimEvent[] = [];
      const groups = COVERAGE_SEARCH_TERMS[b.benefitKey];
      if (groups) {
        for (const t of data.transactions) {
          if (t.deleted || t.cancelled || !t.date.startsWith(currentYear)) continue;
          const n = t.narration.toLowerCase();
          if (groups.some((words) => words.every((w) => n.includes(w)))) events.push({ date: t.date, amount: matchAmount(t), voucher: t });
        }
      }
      for (const c of b.statementClaims ?? []) {
        if (!c.date.startsWith(currentYear)) continue;
        // Skip a statement claim that's effectively the same event as an already-matched voucher
        // (same date, amount within a cent) so it isn't double-counted.
        if (events.some((e) => e.date === c.date && Math.abs(e.amount - c.amount) < 0.01)) continue;
        const voucher = c.voucherGuid ? txByGuid.get(c.voucherGuid) : undefined;
        events.push({ date: c.date, amount: c.amount, voucher });
      }
      if (events.length) {
        events.sort((a, b) => (a.date < b.date ? 1 : -1));
        out.set(b.benefitKey, events);
      }
    }
    return out;
  }, [coverageBenefits, data.transactions, txByGuid, currentYear]);

  const totalCoverageClaims = useMemo(() => {
    let total = 0;
    for (const events of coverageClaims.values()) for (const e of events) total += e.amount;
    return total;
  }, [coverageClaims]);

  const netSoFarWithClaims = feeMatch ? summary.totalUsed + totalCoverageClaims + selfReportedTotal - matchAmount(feeMatch) : null;

  // Every benefit as one row set -- credit trackers, protection/insurance claims, and self-reported
  // credits share a single table/sort/totals (per direct request: one table, not three). Sorted so
  // rows with a real dollar figure float to the top and empty/unused rows sink to the bottom, so
  // the useful numbers don't require scrolling past a wall of zeros.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const b of benefits) {
      out.push({ kind: "credit", key: `credit:${b.benefitId}`, name: b.benefitName, usedAmount: effectiveYearToDate(b, currentYear), annualValue: b.annualTargetAmount, benefit: b });
    }
    for (const b of coverageBenefits) {
      const claims = coverageClaims.get(b.benefitKey) ?? [];
      out.push({ kind: "protection", key: `protection:${b.benefitKey}`, name: b.title, usedAmount: claims.reduce((s, c) => s + c.amount, 0), annualValue: b.periodLimit, benefit: b, claims });
    }
    for (const b of inactiveCredits) {
      out.push({ kind: "inactive", key: `inactive:${b.benefitKey}`, name: b.title, usedAmount: b.selfReportedFullyUsed ? selfReportedUberCashUsed(todayLocalIso()) : 0, annualValue: b.periodLimit, benefit: b });
    }
    out.sort((a, b) => (b.usedAmount > 0 ? 1 : 0) - (a.usedAmount > 0 ? 1 : 0) || b.usedAmount - a.usedAmount || a.name.localeCompare(b.name));
    return out;
  }, [benefits, coverageBenefits, coverageClaims, inactiveCredits, currentYear]);

  const totalUsedClaimedReported = summary.totalUsed + totalCoverageClaims + selfReportedTotal;
  const totalAnnualValueAndLimits = useMemo(() => rows.reduce((s, r) => s + (r.annualValue ?? 0), 0), [rows]);
  const totalRemaining = useMemo(() => rows.reduce((s, r) => s + (r.annualValue != null ? Math.max(0, r.annualValue - r.usedAmount) : 0), 0), [rows]);

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Amex Platinum Benefits
        <span className="info-icon-wrap" onMouseEnter={() => setShowInfo(true)} onMouseLeave={() => setShowInfo(false)}>
          <button type="button" className="info-icon-btn" aria-label="About this report" onClick={() => setShowInfo((v) => !v)}>
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Real usage data imported from your own Amex account (Masters → Amex Benefits) --
              tools/amex-benefits/ captures it straight from Amex's own data, the same thing your
              account's own Benefits page shows. Only as fresh as your last import. The annual fee is
              found by searching your real voucher narrations for "Amex"/"Platinum" plus "annual
              fee"/"membership fee" -- shown as "not found" rather than $0 when nothing matches.
              Protection/insurance claims combine real voucher matches with claims hand-reconciled
              against Amex's own downloaded statement, both reset to zero every calendar year (Amex's
              own reset cadence) -- a prior year's claim never counts against this year's cap. Uber
              Cash's usage is self-reported by you (Amex confirmed it never tracks this one), always
              shown separately and never assumed. The table below is sorted so benefits with a real
              dollar figure sit on top; click ⓘ next to any row for its full terms.
            </div>
          )}
        </span>
      </h3>
      {/* table-scroll -- the same established inner-scroll wrapper roughly a dozen other reports
          already use for this exact shape (wide report content inside .data-panel's own
          overflow:auto, see that class's own comment for why double-nesting the scroll like that
          breaks touch-drag). Fixed column/card widths below keep this report comfortably within a
          normal window in practice, but wrapping it here means nothing can ever be silently cut off
          outside the visible area the way it kept doing wrapped directly in .data-panel -- worst
          case, the content scrolls with a visible scrollbar instead of vanishing past the edge. */}
      <div className="table-scroll">
      <div style={{ marginBottom: 16 }}>
        {!benefits.length ? (
          <p style={{ opacity: 0.7 }}>
            No benefit data imported yet. Run the capture tool at <code>tools/amex-benefits/</code>,
            then import the <code>benefits.json</code> it produces from Masters → Amex Benefits.
          </p>
        ) : (
          <div className="equity-summary-row">
            <div className="equity-summary-card">
              <span>Annual fee{feeMatch ? ` (${fmtDate(feeMatch.date)})` : ""}</span>
              {feeMatch && onViewVoucher ? (
                <button type="button" className="columnar-cell-btn" style={{ fontSize: "inherit", fontWeight: "inherit" }} title="Open the matching voucher" onClick={() => onViewVoucher(feeMatch)}>
                  <strong>{fmt(matchAmount(feeMatch))}</strong>
                </button>
              ) : (
                <strong>{feeMatch ? fmt(matchAmount(feeMatch)) : "not found"}</strong>
              )}
            </div>
            <div className="equity-summary-card">
              <span>Used year to date</span>
              <strong style={{ color: "#16a34a" }}>{fmt(summary.totalUsed)}</strong>
            </div>
            <div className="equity-summary-card">
              <span>Annual potential</span>
              <strong>{fmt(summary.totalTarget)}</strong>
            </div>
            <div className="equity-summary-card">
              <span>Protection claims ({currentYear})</span>
              <strong style={{ color: totalCoverageClaims > 0 ? "#16a34a" : undefined }}>{fmt(totalCoverageClaims)}</strong>
            </div>
            {selfReportedTotal > 0 && (
              <div className="equity-summary-card">
                <span>Uber Cash (self-reported)</span>
                <strong style={{ color: "#2563eb" }}>{fmt(selfReportedTotal)}</strong>
              </div>
            )}
            {netSoFarWithClaims != null && (
              <div className="equity-summary-card">
                <span>Net so far</span>
                <strong style={{ color: netSoFarWithClaims >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(netSoFarWithClaims)}</strong>
              </div>
            )}
            <div className="equity-summary-card">
              <span>Achieved / in progress</span>
              <strong>
                {summary.achievedCount} / {summary.achievedCount + summary.inProgressCount}
              </strong>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        // table-layout:fixed + EVERY column given a fixed width + the table's own width:auto
        // (overriding .fx-ledger-table's shared width:100%) -- confirmed live this is the only
        // combination that never requires horizontal scrolling to see the last column, at any
        // window size: letting even one column "flex" to fill 100% forces the table's rendered
        // width to match whatever the surrounding panel happens to be, which can exceed the
        // actual visible browser window (the panel's own width isn't bounded by the viewport the
        // same way a plain narrow page is), pushing the rightmost column out of view. A fixed
        // total width that comfortably fits a normal window, even if it leaves blank space on a
        // very wide screen, is the only way to guarantee every column stays visible.
        <table className="fx-ledger-table" style={{ tableLayout: "fixed", width: "auto" }}>
          <thead>
            <tr>
              <th style={{ width: 260 }}>Benefit</th>
              <th style={{ width: 140 }}>Status</th>
              <th style={{ width: 130 }} className="right">Annual value</th>
              <th style={{ width: 190 }} className="right">Used / claimed</th>
              <th style={{ width: 110 }} className="right">Remaining</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              if (r.kind === "credit") {
                const b = r.benefit;
                const used = r.usedAmount;
                const achieved = b.status === "ACHIEVED" || (b.annualTargetAmount > 0 && used >= b.annualTargetAmount);
                const pct = b.annualTargetAmount > 0 ? Math.min(100, Math.round((used / b.annualTargetAmount) * 100)) : 0;
                const statementOverride = used > b.yearToDateAmount;
                return (
                  <tr key={r.key}>
                    <td className="fx-narration">{r.name}</td>
                    <td style={{ fontSize: 12 }}>
                      <div style={{ color: achieved ? "#16a34a" : undefined, fontWeight: achieved ? 700 : undefined }}>{achieved ? "✓ Achieved" : "In progress"}</div>
                      <div style={{ background: "#edf0f4", borderRadius: 4, height: 6, overflow: "hidden", width: "100%", marginTop: 2 }}>
                        <div style={{ width: `${pct}%`, background: achieved ? "#16a34a" : "#2563eb", height: "100%" }} />
                      </div>
                    </td>
                    <td className="right">{fmt(b.annualTargetAmount)}</td>
                    <td className="right" style={{ whiteSpace: "normal" }}>
                      {fmt(used)}
                      {statementOverride && <div style={{ fontSize: 10, color: "#2563eb" }}>from statement</div>}
                    </td>
                    <td className="right">{fmt(Math.max(0, b.annualTargetAmount - used))}</td>
                    <td>
                      <InfoIcon id={r.key} open={rowInfo} setOpen={setRowInfo}>
                        {b.trackerDuration || "—"}, resets {b.periodEndDate ? fmtDate(b.periodEndDate) : "—"}
                        <br />
                        This cycle: {fmt(b.spentAmount)} / {fmt(b.targetAmount)}
                        {statementOverride && (
                          <>
                            <br />
                            Amex's own live tracker shows {fmt(b.yearToDateAmount)} used -- {fmt(used)} is confirmed from your real statement instead.
                          </>
                        )}
                      </InfoIcon>
                    </td>
                  </tr>
                );
              }
              if (r.kind === "protection") {
                const b = r.benefit;
                const limitBits: string[] = [];
                if (b.perClaimLimit != null) limitBits.push(`${fmt(b.perClaimLimit)}/claim`);
                if (b.deductible != null) limitBits.push(`${fmt(b.deductible)} deductible`);
                if (b.claimsPerPeriod != null) limitBits.push(`max ${b.claimsPerPeriod} claims`);
                if (b.monthlyCost != null) limitBits.push(`${fmt(b.monthlyCost)}/mo after trial`);
                return (
                  <tr key={r.key}>
                    <td className="fx-narration">{r.name}</td>
                    <td style={{ fontSize: 12, color: r.claims.length ? "#16a34a" : undefined, fontWeight: r.claims.length ? 700 : undefined }}>
                      {r.claims.length ? `${r.claims.length} claim${r.claims.length === 1 ? "" : "s"}` : "Not claimed"}
                    </td>
                    <td className="right">{b.periodLimit != null ? fmt(b.periodLimit) : <span style={{ opacity: 0.4 }}>—</span>}</td>
                    <td className="right" style={{ fontSize: 12, whiteSpace: "normal" }}>
                      {r.claims.length ? (
                        <>
                          <div style={{ fontWeight: 700 }}>{fmt(r.usedAmount)}</div>
                          {r.claims.map((c, i) =>
                            c.voucher && onViewVoucher ? (
                              <button
                                key={i}
                                type="button"
                                className="columnar-cell-btn"
                                style={{ display: "block", fontSize: 11, marginLeft: "auto", color: "#2563eb", textDecoration: "underline" }}
                                title={`Open the matching voucher: ${c.voucher.narration}`}
                                onClick={() => onViewVoucher(c.voucher!)}
                              >
                                {fmtDate(c.date)}: {fmt(c.amount)}
                              </button>
                            ) : (
                              <div key={i} style={{ fontSize: 11, opacity: 0.75 }} title="Confirmed from your Amex statement, no matching voucher to open">
                                {fmtDate(c.date)}: {fmt(c.amount)} (statement)
                              </div>
                            )
                          )}
                        </>
                      ) : (
                        <span style={{ opacity: 0.4 }}>$0.00</span>
                      )}
                    </td>
                    <td className="right">{b.periodLimit != null ? fmt(Math.max(0, b.periodLimit - r.usedAmount)) : <span style={{ opacity: 0.4 }}>—</span>}</td>
                    <td>
                      <InfoIcon id={r.key} open={rowInfo} setOpen={setRowInfo}>
                        {b.summary}
                        {limitBits.length > 0 && (
                          <>
                            <br />
                            {limitBits.join(" · ")}
                          </>
                        )}
                        {b.periodLabel && (
                          <>
                            <br />
                            Limit period: {b.periodLabel}
                          </>
                        )}
                      </InfoIcon>
                    </td>
                  </tr>
                );
              }
              const b = r.benefit;
              const supportsSelfReport = b.benefitKey === "uber-rides-with-platinum";
              return (
                <tr key={r.key}>
                  <td className="fx-narration">{r.name}</td>
                  <td style={{ fontSize: 12, color: b.selfReportedFullyUsed ? "#2563eb" : undefined, fontWeight: b.selfReportedFullyUsed ? 700 : undefined }}>
                    {b.selfReportedFullyUsed ? "Self-reported" : "Not tracked"}
                  </td>
                  <td className="right">{b.periodLimit != null ? fmt(b.periodLimit) : <span style={{ opacity: 0.4 }}>—</span>}</td>
                  <td className="right" style={{ fontSize: 12 }}>
                    {supportsSelfReport ? (
                      <label style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, cursor: onSave ? "pointer" : "default" }}>
                        <input type="checkbox" checked={!!b.selfReportedFullyUsed} disabled={!onSave} onChange={() => toggleSelfReported(b)} />
                        {b.selfReportedFullyUsed ? <strong style={{ color: "#2563eb" }}>{fmt(r.usedAmount)}</strong> : <span style={{ opacity: 0.4 }}>$0.00</span>}
                      </label>
                    ) : (
                      <span style={{ opacity: 0.4 }}>$0.00</span>
                    )}
                  </td>
                  <td className="right">{b.periodLimit != null ? fmt(Math.max(0, b.periodLimit - r.usedAmount)) : <span style={{ opacity: 0.4 }}>—</span>}</td>
                  <td>
                    <InfoIcon id={r.key} open={rowInfo} setOpen={setRowInfo}>
                      {b.summary}
                      <br />
                      Not tracked by Amex -- credited straight to Uber, bypassing Amex's own tracking. "{supportsSelfReport ? "I use this every month" : ""}" is your own statement, not Amex-verified.
                    </InfoIcon>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: "2px solid #d0d5dd" }}>
              <td>Total</td>
              <td></td>
              <td className="right">{fmt(totalAnnualValueAndLimits)}</td>
              <td className="right">{fmt(totalUsedClaimedReported)}</td>
              <td className="right">{fmt(totalRemaining)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      )}
      </div>
    </div>
  );
}
