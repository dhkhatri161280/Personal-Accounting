"use client";
import { useMemo, useState } from "react";
import type { Ledger, Tx } from "@/lib/vault-types";
import { auditNarrationCategorization, type CategorizationFlag, type CategorizationFlagKind } from "@/lib/categorization-audit";
import { HOUSEHOLD_FAMILY_ID } from "@/lib/narration-match";
import { fmtDate } from "@/lib/format-date";

const KIND_LABEL: Record<CategorizationFlagKind, string> = {
  conflicting: "Likely wrong",
  thin: "Weak evidence",
};
const KIND_COLOR: Record<CategorizationFlagKind, string> = {
  conflicting: "#dc2626",
  thin: "#b45309",
};

// Retrospective audit for the auto-import categorization pipeline (see
// lib/categorization-audit.ts's own doc comment for the full methodology and the real
// DECCAN MORSEL / Vehicle Maintenance bug this was built to catch). Read-only: this surfaces
// candidates for review, it never changes anything -- the fix is editing the flagged voucher's
// ledger by hand, same as any other correction, which syncs to Tally normally on the next cycle.
export function CategorizationReview({
  data,
  onViewVoucher,
  onToggleDismissed,
}: {
  data: Ledger;
  onViewVoucher: (t: Tx) => void;
  // Reversible "I checked this one, it's actually fine, stop flagging it" per voucher -- toggling
  // the same guid again un-dismisses it. See VaultApp.tsx's toggleCategorizationDismissed.
  onToggleDismissed: (guid: string) => void;
}) {
  const [kindFilter, setKindFilter] = useState<"" | CategorizationFlagKind>("");
  const [showInfo, setShowInfo] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  // Which flag/side evidence lists are expanded -- keyed "<guid>:own" / "<guid>:suggested" so the
  // two sides of the same flag (and every other flag) toggle independently.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const allFlags = useMemo(() => auditNarrationCategorization(data), [data]);
  const dismissedGuids = useMemo(() => new Set(data.categorizationReviewDismissed ?? []), [data.categorizationReviewDismissed]);
  const flags = useMemo(() => allFlags.filter((f) => !dismissedGuids.has(f.guid)), [allFlags, dismissedGuids]);
  const dismissedFlags = useMemo(() => allFlags.filter((f) => dismissedGuids.has(f.guid)), [allFlags, dismissedGuids]);
  const accountName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const txByGuid = useMemo(() => new Map(data.transactions.map((t) => [t.guid, t])), [data.transactions]);

  const nameFor = (id: number | undefined): string | null => {
    if (id === undefined) return null;
    if (id === HOUSEHOLD_FAMILY_ID) return "House Hold Exps (any month)";
    return accountName.get(id) ?? "Unknown";
  };

  // Clickable "(N similar vouchers)" label that expands into the actual vouchers behind that
  // count, each openable -- this is what the "evidence" actually was, so a false positive caused
  // by a coincidentally-shared word (a person's name, an abbreviation) is visible and checkable
  // at a glance instead of a bare, unverifiable number.
  const EvidenceToggle = ({ flagGuid, side, count, guids }: { flagGuid: string; side: "own" | "suggested"; count: number; guids: string[] }) => {
    if (count === 0) return null;
    const key = `${flagGuid}:${side}`;
    const isOpen = expanded.has(key);
    return (
      <>
        {" "}
        <button type="button" className="columnar-cell-btn" style={{ fontSize: 12 }} onClick={() => toggleExpanded(key)}>
          ({count} similar voucher{count !== 1 ? "s" : ""}{side === "own" ? " agree" : ""}{isOpen ? " ▲" : " ▼"})
        </button>
        {isOpen && (
          <div style={{ margin: "4px 0 4px 16px", fontSize: 12, opacity: 0.85 }}>
            {guids.map((g) => {
              const evTx = txByGuid.get(g);
              if (!evTx) return null;
              return (
                <div key={g}>
                  <button type="button" className="columnar-cell-btn" onClick={() => onViewVoucher(evTx)}>
                    {fmtDate(evTx.date)} · {evTx.narration || "(no narration)"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  };

  const filtered = kindFilter ? flags.filter((f) => f.kind === kindFilter) : flags;
  const conflictingCount = flags.filter((f) => f.kind === "conflicting").length;
  const thinCount = flags.filter((f) => f.kind === "thin").length;

  // Shared row rendering for both the active list and the "Show dismissed" list below --
  // `dismissed` only changes the action button's label/behavior (Mark as correct vs. Un-dismiss).
  const FlagRow = ({ f, dismissed }: { f: CategorizationFlag; dismissed: boolean }) => {
    const tx = txByGuid.get(f.guid);
    return (
      <div className="report-line" key={f.guid}>
        <span>
          <strong style={{ color: KIND_COLOR[f.kind] }}>{KIND_LABEL[f.kind]}</strong>{" "}
          <span style={{ opacity: 0.6, fontSize: 11 }}>({fmtDate(f.date)} · {f.voucherType} #{f.voucherNumber})</span>
          <br />
          {tx ? (
            <button type="button" className="columnar-cell-btn" style={{ color: "#1d4ed8", textDecoration: "underline" }} onClick={() => onViewVoucher(tx)}>
              {f.narration || "(no narration)"}
            </button>
          ) : (
            f.narration || "(no narration)"
          )}
          <br />
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            Currently: <strong>{nameFor(f.debitId)}</strong>
            <EvidenceToggle flagGuid={f.guid} side="own" count={f.ownVotes} guids={f.ownEvidenceGuids} />
            {f.kind === "conflicting" && (
              <>
                {" — "}suggested: <strong style={{ color: "#16a34a" }}>{nameFor(f.suggestedDebitId)}</strong>
                <EvidenceToggle flagGuid={f.guid} side="suggested" count={f.suggestedVotes ?? 0} guids={f.suggestedEvidenceGuids ?? []} />
              </>
            )}
          </span>
          <br />
          <button
            type="button"
            className="tr-refresh-btn"
            style={{ marginTop: 4 }}
            title={dismissed ? "Put this back in the review list" : "I checked both ledgers -- this one's actually fine, stop flagging it"}
            onClick={() => onToggleDismissed(f.guid)}
          >
            {dismissed ? "Un-dismiss" : "Mark as correct — don't flag again"}
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Categorization Review
        <span
          className="info-icon-wrap"
          onMouseEnter={() => setShowInfo(true)}
          onMouseLeave={() => setShowInfo(false)}
        >
          <button
            type="button"
            className="info-icon-btn"
            aria-label="How this review works"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Scans every auto-imported voucher (from Plaid) and re-checks its ledger assignment against every OTHER
              voucher in the book that shares a narration word, the same way the live import's own auto-categorization
              does -- but with the voucher itself excluded from its own evidence. "Likely wrong" means a different ledger
              has more supporting vouchers than the one this got posted to; "Weak evidence" means the posting is backed by
              exactly one other voucher ledger-wide, with nothing else to compare it against -- the same single-coincidence
              pattern that mis-posts a restaurant charge onto a Vehicle Maintenance ledger because it happens to share one
              word with an unrelated prior voucher. This is read-only -- nothing is changed automatically; fix a flagged
              voucher the normal way (edit its ledger), which syncs to Tally like any other edit. Manually-entered vouchers
              are never flagged, since a coincidental word match there isn't a categorization bug. Click "(N similar
              vouchers)" to see and open exactly which vouchers are behind that count -- a false positive caused by a
              coincidentally-shared word (a person's name, an abbreviation) becomes obvious once you can see them. If
              you've checked one and it's genuinely fine as-is, "Mark as correct" hides it from future reviews
              (reversible, via "Show dismissed").
            </div>
          )}
        </span>
      </h3>

      <div className="master-toolbar">
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}>
          <option value="">All ({flags.length})</option>
          <option value="conflicting">Likely wrong ({conflictingCount})</option>
          <option value="thin">Weak evidence ({thinCount})</option>
        </select>
        {dismissedFlags.length > 0 && (
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
            Show dismissed ({dismissedFlags.length})
          </label>
        )}
      </div>

      {flags.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No weak or contradicted auto-categorizations found. This only looks at vouchers imported from Plaid, so manual
          entries are never included.
        </p>
      ) : (
        filtered.map((f) => <FlagRow key={f.guid} f={f} dismissed={false} />)
      )}

      {showDismissed && dismissedFlags.length > 0 && (
        <>
          <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
          <h4 style={{ margin: "0 0 8px", opacity: 0.7 }}>Dismissed — confirmed correct</h4>
          {dismissedFlags.map((f) => <FlagRow key={f.guid} f={f} dismissed={true} />)}
        </>
      )}
    </div>
  );
}
