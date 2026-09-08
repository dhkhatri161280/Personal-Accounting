"use client";
import { Fragment, useState } from "react";
import type { FixedAsset, Ledger } from "@/lib/vault-types";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  pendingDepreciationMonths,
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  ASSET_CLASS_SUGGESTIONS,
  UNCLASSIFIED_LABEL,
  UNTAGGED_ASSET_FILTER,
  ASSET_CLASS_PREFIXES,
  suggestNextAssetTag,
} from "@/lib/fixed-assets";
import { postDepreciation, postDepreciationConsolidated, disposeAsset } from "@/lib/fixed-assets-ledger";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { fmtDate } from "@/lib/format-date";

// Report/operational view over the Fixed Asset master data maintained in Masters > Fixed Assets
// (name, Fixed Asset #, Group/Class, Useful Life, Salvage -- all read-only here). This screen is
// where the actual depreciation posting, disposal, and drill-down happen, since those are
// periodic/transactional actions (post real Journal vouchers) rather than master-data edits.
export function FixedAssetRegister({
  data,
  fmt,
  onSave,
  onSelectAccount,
  onSelectTaggedAsset,
  onBulkTagAsset,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onSave: (next: Ledger) => Promise<boolean> | boolean;
  // Fallback used only when onSelectTaggedAsset isn't provided -- opens the plain, unfiltered
  // ledger drill-down popup used everywhere else in the app.
  onSelectAccount?: (id: number) => void;
  // Opens the same drill-down popup, but narrowed to only this asset's own entries -- pass the
  // asset's sourceTag for a tag-derived asset, or UNTAGGED_ASSET_FILTER (lib/fixed-assets.ts) for
  // one with none, so the untagged remainder excludes whatever's now tracked separately under a
  // sibling tag (see createTaggedAsset's cost carve-out in lib/fixed-assets-ledger.ts). Without
  // this, "what's included in that" would show the whole shared ledger, not just this asset's own
  // slice of it.
  onSelectTaggedAsset?: (accountId: number, tagOrUntaggedFilter: string) => void;
  // Applies one Fixed Asset # to every voucher on this asset's ledger in one go. Only offered for
  // an untagged asset that is the sole occupant of its ledger -- a shared ledger with multiple
  // distinct assets still needs per-voucher tagging, which is exactly why tagging exists.
  onBulkTagAsset?: (asset: FixedAsset, tag: string) => Promise<void> | void;
}) {
  const [saving, setSaving] = useState(false);
  const [disposingId, setDisposingId] = useState<string | null>(null);
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [disposalProceeds, setDisposalProceeds] = useState("0");
  const [disposalCashAcct, setDisposalCashAcct] = useState<number | "">("");
  // Collapsed by default, same "click the group header to reveal its members" pattern used
  // elsewhere in this app (NetWorthReport's Assets/Liabilities breakdown).
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [bulkTaggingId, setBulkTaggingId] = useState<string | null>(null);
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [bulkTagging, setBulkTagging] = useState(false);

  // Excludes a legacy (untagged) asset once its cost has been fully carved out down to $0 by its
  // tagged siblings (see reconcileLegacyAssetCost in lib/fixed-assets-ledger.ts) -- a genuinely
  // $0 record has nothing left to depreciate or report, so it's just noise here. The underlying
  // record isn't deleted (still visible/removable in Masters > Fixed Assets), only hidden from
  // this report.
  const assets = (data.fixedAssets ?? [])
    .filter((a) => Math.abs(a.cost) > 0.005)
    .slice()
    .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  const todayStr = new Date().toISOString().slice(0, 10);
  // User-chosen cutoff for a one-shot depreciation run (SAP/Oracle/Rillet-style "post through
  // date") -- defaults to today, but the user can pick any earlier date to post depreciation
  // only through a specific closed month instead of always catching all the way up to today.
  const [throughDate, setThroughDate] = useState(todayStr);
  // Default OFF: periodic (one voucher per pending asset-month, dated at that month's own
  // end -- the historically-correct posting). Turning this on switches to one consolidated
  // catch-up voucher per asset instead, dated `throughDate` itself -- needed when the backlog
  // spans already-closed periods that per-month vouchers can't be dated into.
  const [consolidate, setConsolidate] = useState(false);

  const active = assets.filter((a) => !a.disposed);
  // postDepreciation/postDepreciationConsolidated are pure (return a new object, never mutate
  // `data`) -- calling here just to read postedCount/pendingAmount for the button label is safe
  // and cheap for a personal-scale register.
  const pendingCount = consolidate
    ? postDepreciationConsolidated(data, throughDate, throughDate).postedCount
    : postDepreciation(data, throughDate).postedCount;
  const pendingAmount = active.reduce(
    (s, a) => s + pendingDepreciationMonths(a, throughDate).reduce((ss, m) => ss + m.amount, 0),
    0
  );

  async function runDepreciation() {
    setSaving(true);
    try {
      const { data: next } = consolidate
        ? postDepreciationConsolidated(data, throughDate, throughDate)
        : postDepreciation(data, throughDate);
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDispose(assetId: string) {
    if (disposalCashAcct === "") return;
    setSaving(true);
    try {
      const result = disposeAsset(data, assetId, disposalDate, Number(disposalProceeds) || 0, disposalCashAcct);
      if ("data" in result) {
        const ok = await onSave(result.data);
        if (ok) setDisposingId(null);
      }
    } finally {
      setSaving(false);
    }
  }

  function openBulkTag(a: FixedAsset) {
    const prefix = ASSET_CLASS_PREFIXES[a.assetClass || UNCLASSIFIED_LABEL] || ASSET_CLASS_PREFIXES[UNCLASSIFIED_LABEL];
    const existingTags = (data.fixedAssets ?? []).map((x) => x.sourceTag).filter((t): t is string => !!t);
    setBulkTagValue(suggestNextAssetTag(existingTags, prefix));
    setBulkTaggingId(a.id);
  }

  async function confirmBulkTag(a: FixedAsset) {
    const tag = bulkTagValue.trim();
    if (!tag || !onBulkTagAsset) return;
    setBulkTagging(true);
    try {
      await onBulkTagAsset(a, tag);
      setBulkTaggingId(null);
    } finally {
      setBulkTagging(false);
    }
  }

  const cashAccounts = data.accounts
    .filter((a) => a.active !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const accumDeprecGlBalance = (() => {
    const acct = data.accounts.find((a) => a.name === ACCUMULATED_DEPRECIATION_ACCOUNT_NAME);
    if (!acct) return null;
    const sum = data.transactions
      .filter((t) => !t.deleted && !t.cancelled)
      .reduce((s, t) => s + t.entries.filter((e) => e.accountId === acct.id).reduce((ss, e) => ss + e.amount, 0), 0);
    // Not the signed GL balance (-sum, since this is a contra-asset shown negative on the Balance
    // Sheet) -- this is a magnitude compared directly against computedAccumTotal below, which is
    // also a positive magnitude.
    return sum;
  })();
  const computedAccumTotal = active.reduce((s, a) => s + accumulatedDepreciation(a, todayStr), 0);

  const totals = assets.reduce(
    (s, a) => ({
      cost: s.cost + a.cost,
      monthly: s.monthly + monthlyDepreciation(a),
      accum: s.accum + accumulatedDepreciation(a, todayStr),
      bookValue: s.bookValue + bookValue(a, todayStr),
    }),
    { cost: 0, monthly: 0, accum: 0, bookValue: 0 }
  );

  // Grouped for display: known ASSET_CLASS_SUGGESTIONS first in that order, then any custom
  // class names alphabetically, then Unclassified always last.
  const classGroups = (() => {
    const map = new Map<string, FixedAsset[]>();
    for (const a of assets) {
      const key = a.assetClass || UNCLASSIFIED_LABEL;
      (map.get(key) ?? map.set(key, []).get(key)!).push(a);
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === UNCLASSIFIED_LABEL) return 1;
      if (b === UNCLASSIFIED_LABEL) return -1;
      const ai = ASSET_CLASS_SUGGESTIONS.indexOf(a), bi = ASSET_CLASS_SUGGESTIONS.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
  })();
  const toggleClass = (cls: string) =>
    setExpandedClasses((prev) => {
      const next = new Set(prev);
      next.has(cls) ? next.delete(cls) : next.add(cls);
      return next;
    });
  const allClassesExpanded = classGroups.length > 0 && classGroups.every(([cls]) => expandedClasses.has(cls));
  const toggleAllClasses = () => setExpandedClasses(allClassesExpanded ? new Set() : new Set(classGroups.map(([cls]) => cls)));

  async function exportAssets() {
    const header = ["Asset", "Fixed Asset #", "Group / Class", "Purchase Date", "Cost", "Useful Life (mo)", "Monthly Dep.", "Accum. Dep.", "Book Value", "Status"];
    const body = assets.map((a) => [
      a.name,
      a.sourceTag || "",
      a.assetClass || "",
      fmtDate(a.purchaseDate),
      a.cost,
      a.usefulLifeMonths,
      monthlyDepreciation(a),
      accumulatedDepreciation(a, todayStr),
      bookValue(a, todayStr),
      a.disposed ? `Disposed ${fmtDate(a.disposed.date)}` : "Active",
    ]);
    const totalsRow = ["Total", "", "", "", totals.cost, "", totals.monthly, totals.accum, totals.bookValue, ""];
    await exportWorkbook("Fixed Asset Register.xlsx", [{ name: "Fixed Assets", rows: [header, ...body, totalsRow] }]);
  }

  return (
    <div className="data-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Fixed Asset Register</h3>
        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: "pointer", listStyle: "none", color: "#6f7d92", fontWeight: 600 }}>ⓘ How depreciation posting works</summary>
          <p style={{ opacity: 0.75, margin: "6px 0 0", maxWidth: 640 }}>
            Straight-line only. Each asset gets its own ledger account under "Fixed Assets". The Monthly/Accum./Book Value
            columns are always live — no action needed. "Run Depreciation" is a separate, optional step that{" "}
            <strong>posts real Journal vouchers</strong> (Dr Depreciation Expense / Cr Accumulated Depreciation) through the date
            you choose. By default it's one voucher per pending asset-month, dated at that month's own end. If your backlog spans
            periods you've already closed and reported, check "Consolidate" to post one true-up voucher per asset instead, dated
            on your chosen date — the same way SAP/Oracle/Rillet handle a large catch-up run. Name/Group/Class/Useful Life are
            managed in Masters &gt; Fixed Assets — tag a voucher line's "Fixed Asset #" and its master record is created there
            automatically, no separate sync step needed.
          </p>
        </details>
      </div>
      <div className="master-toolbar" style={{ marginTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#53627a" }}>
          Post through
          <input type="date" value={throughDate} max={todayStr} onChange={(e) => setThroughDate(e.target.value)} style={{ padding: "5px 7px" }} />
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#53627a", whiteSpace: "nowrap" }}
          title={`Posts one true-up voucher per asset, dated ${throughDate}, instead of one per pending asset-month`}
        >
          <input type="checkbox" checked={consolidate} onChange={(e) => setConsolidate(e.target.checked)} />
          Consolidate into 1 voucher/asset
        </label>
        <button type="button" className="tr-refresh-btn" disabled={saving || pendingCount === 0} onClick={runDepreciation}>
          {saving
            ? "Posting…"
            : pendingCount === 0
              ? "Depreciation up to date"
              : `Run Depreciation (${pendingCount} voucher${pendingCount === 1 ? "" : "s"}, ${fmt(pendingAmount)})`}
        </button>
        {accumDeprecGlBalance !== null && Math.abs(accumDeprecGlBalance - computedAccumTotal) > 0.5 && (
          <span
            style={{ fontSize: 11, color: "#dc2626", cursor: "help" }}
            title={`GL Accumulated Depreciation (${fmt(accumDeprecGlBalance)}) doesn't match computed (${fmt(computedAccumTotal)}) — check for manual entries against that account.`}
          >
            ⚠ GL mismatch
          </span>
        )}
        <ExportButton onExport={exportAssets} />
      </div>

      {assets.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No fixed assets yet. Add one in Masters &gt; Fixed Assets, or tag a voucher line to create one automatically.</p>
      ) : (
        <div className="columnar-report-scroll">
          <table className="columnar-report-table budget-table">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    onClick={toggleAllClasses}
                    title={allClassesExpanded ? "Collapse all groups" : "Expand all groups"}
                    aria-label={allClassesExpanded ? "Collapse all groups" : "Expand all groups"}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: "0 6px 0 0", fontSize: 13, lineHeight: 1, verticalAlign: "middle" }}
                  >
                    {allClassesExpanded ? "⊟" : "⊞"}
                  </button>
                  Asset
                </th>
                <th>Fixed Asset #</th>
                <th>Group / Class</th>
                <th>Purchase Date</th>
                <th className="right">Cost</th>
                <th className="right">Useful Life</th>
                <th className="right">Monthly Dep.</th>
                <th className="right">Accum. Dep.</th>
                <th className="right">Book Value</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {classGroups.map(([cls, groupAssets]) => {
                const open = expandedClasses.has(cls);
                const groupTotals = groupAssets.reduce(
                  (s, a) => ({
                    cost: s.cost + a.cost,
                    monthly: s.monthly + monthlyDepreciation(a),
                    accum: s.accum + accumulatedDepreciation(a, todayStr),
                    bookValue: s.bookValue + bookValue(a, todayStr),
                  }),
                  { cost: 0, monthly: 0, accum: 0, bookValue: 0 }
                );
                return (
                  <Fragment key={cls}>
                    <tr className="ledger-subtotal-row" style={{ cursor: "pointer" }} onClick={() => toggleClass(cls)}>
                      <td colSpan={3}>
                        {open ? "▾" : "▸"} {cls} ({groupAssets.length})
                      </td>
                      <td></td>
                      <td className="right">{fmt(groupTotals.cost)}</td>
                      <td></td>
                      <td className="right">{fmt(groupTotals.monthly)}</td>
                      <td className="right">{fmt(groupTotals.accum)}</td>
                      <td className="right">{fmt(groupTotals.bookValue)}</td>
                      <td></td>
                      <td></td>
                    </tr>
                    {open &&
                      groupAssets.map((a) => {
                        const monthly = monthlyDepreciation(a);
                        const accum = accumulatedDepreciation(a, todayStr);
                        const bv = bookValue(a, todayStr);
                        // Bulk-tagging is only safe when this asset is the sole occupant of its
                        // ledger -- a shared ledger with several distinct assets is exactly why
                        // per-voucher tagging exists, and bulk-applying one tag there would
                        // reintroduce the ambiguity tagging was built to remove.
                        const soleOccupant = assets.filter((x) => x.accountId === a.accountId).length === 1;
                        const canBulkTag = !a.sourceTag && soleOccupant && !!onBulkTagAsset;
                        return (
                          <tr key={a.id}>
                            <td>
                              {onSelectTaggedAsset ? (
                                <button
                                  type="button"
                                  className="ledger-link"
                                  onClick={() => onSelectTaggedAsset(a.accountId, a.sourceTag || UNTAGGED_ASSET_FILTER)}
                                >
                                  {a.name}
                                </button>
                              ) : onSelectAccount ? (
                                <button type="button" className="ledger-link" onClick={() => onSelectAccount(a.accountId)}>
                                  {a.name}
                                </button>
                              ) : (
                                a.name
                              )}
                            </td>
                            <td>
                              {bulkTaggingId === a.id ? (
                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                  <input
                                    value={bulkTagValue}
                                    onChange={(e) => setBulkTagValue(e.target.value)}
                                    placeholder="FUR-006"
                                    style={{ width: 80 }}
                                  />
                                  <button
                                    type="button"
                                    className="tr-refresh-btn"
                                    disabled={bulkTagging || !bulkTagValue.trim()}
                                    onClick={() => confirmBulkTag(a)}
                                  >
                                    Apply
                                  </button>
                                  <button type="button" className="tr-refresh-btn" onClick={() => setBulkTaggingId(null)}>
                                    Cancel
                                  </button>
                                </div>
                              ) : a.sourceTag ? (
                                a.sourceTag
                              ) : canBulkTag ? (
                                <button
                                  type="button"
                                  className="tr-refresh-btn"
                                  title="Apply one Fixed Asset # to every voucher already posted on this asset's ledger"
                                  onClick={() => openBulkTag(a)}
                                >
                                  🏷 Tag all vouchers
                                </button>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>{a.assetClass || "—"}</td>
                            <td>{fmtDate(a.purchaseDate)}</td>
                            <td className="right">{fmt(a.cost)}</td>
                            <td className="right">{a.usefulLifeMonths} mo</td>
                            <td className="right">{fmt(monthly)}</td>
                            <td className="right">{fmt(accum)}</td>
                            <td className="right">{fmt(bv)}</td>
                            <td>
                              {a.disposed ? (
                                <span style={{ opacity: 0.6, fontSize: 12 }}>Disposed {fmtDate(a.disposed.date)}</span>
                              ) : (
                                <span style={{ color: "#16a34a", fontSize: 12 }}>Active</span>
                              )}
                            </td>
                            <td>
                              {!a.disposed &&
                                (disposingId === a.id ? (
                                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                                    <input
                                      type="date"
                                      value={disposalDate}
                                      onChange={(e) => setDisposalDate(e.target.value)}
                                      style={{ width: 120 }}
                                    />
                                    <input
                                      placeholder="Proceeds"
                                      type="number"
                                      value={disposalProceeds}
                                      onChange={(e) => setDisposalProceeds(e.target.value)}
                                      style={{ width: 80 }}
                                    />
                                    <select
                                      value={disposalCashAcct}
                                      onChange={(e) => setDisposalCashAcct(e.target.value ? Number(e.target.value) : "")}
                                    >
                                      <option value="">Deposit to…</option>
                                      {cashAccounts.map((acc) => (
                                        <option key={acc.id} value={acc.id}>
                                          {acc.name}
                                        </option>
                                      ))}
                                    </select>
                                    <button type="button" className="tr-refresh-btn" disabled={saving} onClick={() => confirmDispose(a.id)}>
                                      Confirm
                                    </button>
                                    <button type="button" className="tr-refresh-btn" onClick={() => setDisposingId(null)}>
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button type="button" className="tr-refresh-btn" onClick={() => setDisposingId(a.id)}>
                                    Dispose
                                  </button>
                                ))}
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th></th>
                <th></th>
                <th></th>
                <th className="right">{fmt(totals.cost)}</th>
                <th></th>
                <th className="right">{fmt(totals.monthly)}</th>
                <th className="right">{fmt(totals.accum)}</th>
                <th className="right">{fmt(totals.bookValue)}</th>
                <th></th>
                <th></th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
