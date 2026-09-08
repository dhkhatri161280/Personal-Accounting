"use client";
import { Fragment, useState } from "react";
import type { FixedAsset, Ledger } from "@/lib/vault-types";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  pendingDepreciationMonths,
  guessAssetClass,
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  ASSET_CLASS_SUGGESTIONS,
  UNCLASSIFIED_LABEL,
} from "@/lib/fixed-assets";
import { getOrCreateAssetAccount, postDepreciation, postDepreciationConsolidated, disposeAsset } from "@/lib/fixed-assets-ledger";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { fmtDate } from "@/lib/format-date";

export function FixedAssetRegister({
  data,
  fmt,
  onSave,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onSave: (next: Ledger) => Promise<boolean> | boolean;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState("");
  const [cost, setCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("36");
  const [salvageValue, setSalvageValue] = useState("0");
  const [saving, setSaving] = useState(false);
  const [disposingId, setDisposingId] = useState<string | null>(null);
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [disposalProceeds, setDisposalProceeds] = useState("0");
  const [disposalCashAcct, setDisposalCashAcct] = useState<number | "">("");
  // Collapsed by default, same "click the group header to reveal its members" pattern used
  // elsewhere in this app (NetWorthReport's Assets/Liabilities breakdown).
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);

  const assets = (data.fixedAssets ?? []).slice().sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
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

  async function addAsset() {
    const costNum = Number(cost);
    const lifeNum = Number(usefulLifeMonths);
    const salvageNum = Number(salvageValue) || 0;
    if (!name.trim() || !costNum || costNum <= 0 || !lifeNum || lifeNum <= 0) return;
    setSaving(true);
    try {
      const { data: withAcct, account } = getOrCreateAssetAccount(data, name.trim(), costNum, purchaseDate);
      // Falls back to a guessed class from the name if the user left the field blank -- still
      // just a default, freely overridable by typing something else before saving.
      const resolvedClass = assetClass.trim() || guessAssetClass(name.trim());
      const asset: FixedAsset = {
        id: crypto.randomUUID(),
        name: name.trim(),
        accountId: account.id,
        ...(resolvedClass ? { assetClass: resolvedClass } : {}),
        purchaseDate,
        cost: costNum,
        salvageValue: salvageNum,
        usefulLifeMonths: lifeNum,
      };
      const next: Ledger = { ...withAcct, fixedAssets: [...(withAcct.fixedAssets ?? []), asset] };
      const ok = await onSave(next);
      if (ok) {
        setShowAdd(false);
        setName("");
        setAssetClass("");
        setCost("");
        setSalvageValue("0");
        setUsefulLifeMonths("36");
      }
    } finally {
      setSaving(false);
    }
  }

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

  // Fills in Group/Class for every asset that doesn't have one yet, guessed from its name --
  // never overwrites an existing (even manually-corrected) class. No-op if nothing is guessable.
  async function autoClassify() {
    const updated = (data.fixedAssets ?? []).map((a) => (a.assetClass ? a : { ...a, assetClass: guessAssetClass(a.name) || a.assetClass }));
    if (updated.every((a, i) => a.assetClass === (data.fixedAssets ?? [])[i].assetClass)) return;
    setClassifying(true);
    try {
      await onSave({ ...data, fixedAssets: updated });
    } finally {
      setClassifying(false);
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

  const unclassifiedCount = assets.filter((a) => !a.assetClass).length;

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

  async function exportAssets() {
    const header = ["Asset", "Group / Class", "Purchase Date", "Cost", "Useful Life (mo)", "Monthly Dep.", "Accum. Dep.", "Book Value", "Status"];
    const body = assets.map((a) => [
      a.name,
      a.assetClass || "",
      fmtDate(a.purchaseDate),
      a.cost,
      a.usefulLifeMonths,
      monthlyDepreciation(a),
      accumulatedDepreciation(a, todayStr),
      bookValue(a, todayStr),
      a.disposed ? `Disposed ${fmtDate(a.disposed.date)}` : "Active",
    ]);
    const totalsRow = ["Total", "", "", totals.cost, "", totals.monthly, totals.accum, totals.bookValue, ""];
    await exportWorkbook("Fixed Asset Register.xlsx", [{ name: "Fixed Assets", rows: [header, ...body, totalsRow] }]);
  }

  return (
    <div className="data-panel">
      <h3>Fixed Asset Register</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Straight-line depreciation only. Each asset gets its own ledger account under "Fixed Assets". The Monthly/Accum./Book
        Value columns below are always live and up to date — no action needed to see them. "Run Depreciation" is a separate,
        optional step that <strong>posts real Journal vouchers</strong> (Dr Depreciation Expense / Cr Accumulated Depreciation)
        for whichever months haven't been posted yet, through the date you choose. By default it posts one voucher per pending
        asset-month, dated at that month's own end (correct if those periods are still open). If your backlog spans periods
        you've already closed and reported, check "Consolidate" below to post one true-up voucher per asset instead, dated on
        your chosen date, for the full catch-up amount — the same way SAP/Oracle/Rillet handle a large catch-up run.
      </p>
      <div className="master-toolbar">
        <button type="button" className="tr-refresh-btn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Asset"}
        </button>
        {unclassifiedCount > 0 && (
          <button type="button" className="tr-refresh-btn" disabled={classifying} onClick={autoClassify}>
            {classifying ? "Classifying…" : `🪄 Auto-classify ${unclassifiedCount} asset${unclassifiedCount === 1 ? "" : "s"}`}
          </button>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, fontWeight: 700, color: "#53627a" }}>
          Post through
          <input type="date" value={throughDate} max={todayStr} onChange={(e) => setThroughDate(e.target.value)} style={{ padding: "6px 8px" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#53627a" }}>
          <input type="checkbox" checked={consolidate} onChange={(e) => setConsolidate(e.target.checked)} />
          Consolidate into 1 voucher per asset (dated {throughDate})
        </label>
        <button type="button" className="tr-refresh-btn" disabled={saving || pendingCount === 0} onClick={runDepreciation}>
          {saving
            ? "Posting…"
            : pendingCount === 0
              ? "Depreciation up to date"
              : `Run Depreciation (${pendingCount} voucher${pendingCount === 1 ? "" : "s"}, ${fmt(pendingAmount)}) — posts vouchers`}
        </button>
        {accumDeprecGlBalance !== null && Math.abs(accumDeprecGlBalance - computedAccumTotal) > 0.5 && (
          <span style={{ fontSize: 11, color: "#dc2626" }}>
            GL Accumulated Depreciation ({fmt(accumDeprecGlBalance)}) doesn't match computed ({fmt(computedAccumTotal)}) — check for
            manual entries against that account.
          </span>
        )}
        <ExportButton onExport={exportAssets} />
      </div>

      {showAdd && (
        <div className="report-line" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Asset name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            list="asset-class-suggestions"
            placeholder="Group / Class (optional)"
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value)}
            style={{ width: 170 }}
          />
          <datalist id="asset-class-suggestions">
            {ASSET_CLASS_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input placeholder="Cost" type="number" value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: 100 }} />
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          <input
            placeholder="Useful life (months)"
            type="number"
            value={usefulLifeMonths}
            onChange={(e) => setUsefulLifeMonths(e.target.value)}
            style={{ width: 140 }}
          />
          <input
            placeholder="Salvage value"
            type="number"
            value={salvageValue}
            onChange={(e) => setSalvageValue(e.target.value)}
            style={{ width: 110 }}
          />
          <button type="button" className="tr-refresh-btn" disabled={saving} onClick={addAsset}>
            {saving ? "Saving…" : "Save Asset"}
          </button>
        </div>
      )}

      {assets.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No fixed assets yet. Add one above to start tracking depreciation.</p>
      ) : (
        <div className="columnar-report-scroll">
          <table className="columnar-report-table budget-table">
            <thead>
              <tr>
                <th>Asset</th>
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
                      <td colSpan={2}>
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
                        return (
                          <tr key={a.id}>
                            <td>{a.name}</td>
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
