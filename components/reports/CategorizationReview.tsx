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
export function CategorizationReview({ data, onViewVoucher }: { data: Ledger; onViewVoucher: (t: Tx) => void }) {
  const [kindFilter, setKindFilter] = useState<"" | CategorizationFlagKind>("");
  const [showInfo, setShowInfo] = useState(false);

  const flags = useMemo(() => auditNarrationCategorization(data), [data]);
  const accountName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const txByGuid = useMemo(() => new Map(data.transactions.map((t) => [t.guid, t])), [data.transactions]);

  const nameFor = (id: number | undefined): string | null => {
    if (id === undefined) return null;
    if (id === HOUSEHOLD_FAMILY_ID) return "House Hold Exps (any month)";
    return accountName.get(id) ?? "Unknown";
  };

  const filtered = kindFilter ? flags.filter((f) => f.kind === kindFilter) : flags;
  const conflictingCount = flags.filter((f) => f.kind === "conflicting").length;
  const thinCount = flags.filter((f) => f.kind === "thin").length;

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
              are never flagged, since a coincidental word match there isn't a categorization bug.
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
      </div>

      {flags.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No weak or contradicted auto-categorizations found. This only looks at vouchers imported from Plaid, so manual
          entries are never included.
        </p>
      ) : (
        filtered.map((f) => {
          const tx = txByGuid.get(f.guid);
          return (
            <div className="report-line" key={f.guid}>
              <span>
                <strong style={{ color: KIND_COLOR[f.kind] }}>{KIND_LABEL[f.kind]}</strong>{" "}
                <span style={{ opacity: 0.6, fontSize: 11 }}>({fmtDate(f.date)} · {f.voucherType} #{f.voucherNumber})</span>
                <br />
                {tx ? (
                  <button type="button" className="columnar-cell-btn" onClick={() => onViewVoucher(tx)}>
                    {f.narration || "(no narration)"}
                  </button>
                ) : (
                  f.narration || "(no narration)"
                )}
                <br />
                <span style={{ fontSize: 12, opacity: 0.8 }}>
                  Currently: <strong>{nameFor(f.debitId)}</strong>
                  {f.ownVotes > 0 && ` (${f.ownVotes} similar voucher${f.ownVotes !== 1 ? "s" : ""} agree)`}
                  {f.kind === "conflicting" && (
                    <>
                      {" — "}suggested: <strong style={{ color: "#16a34a" }}>{nameFor(f.suggestedDebitId)}</strong>
                      {` (${f.suggestedVotes} similar voucher${f.suggestedVotes !== 1 ? "s" : ""})`}
                    </>
                  )}
                </span>
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
