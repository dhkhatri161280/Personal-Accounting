"use client";
import { useState } from "react";
import type { FixedAsset, Ledger } from "@/lib/vault-types";
import { monthlyDepreciation, accumulatedDepreciation, bookValue, ACCUMULATED_DEPRECIATION_ACCOUNT_NAME } from "@/lib/fixed-assets";
import { getOrCreateAssetAccount, postDepreciation, disposeAsset } from "@/lib/fixed-assets-ledger";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

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
  const [cost, setCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("36");
  const [salvageValue, setSalvageValue] = useState("0");
  const [saving, setSaving] = useState(false);
  const [disposingId, setDisposingId] = useState<string | null>(null);
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [disposalProceeds, setDisposalProceeds] = useState("0");
  const [disposalCashAcct, setDisposalCashAcct] = useState<number | "">("");

  const assets = (data.fixedAssets ?? []).slice().sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  const todayStr = new Date().toISOString().slice(0, 10);

  const active = assets.filter((a) => !a.disposed);
  // postDepreciation is pure (returns a new object, never mutates `data`) -- calling it here just
  // to read `postedCount` for the button label is safe and cheap for a personal-scale register.
  const pendingCount = postDepreciation(data, todayStr).postedCount;

  async function addAsset() {
    const costNum = Number(cost);
    const lifeNum = Number(usefulLifeMonths);
    const salvageNum = Number(salvageValue) || 0;
    if (!name.trim() || !costNum || costNum <= 0 || !lifeNum || lifeNum <= 0) return;
    setSaving(true);
    try {
      const { data: withAcct, account } = getOrCreateAssetAccount(data, name.trim(), costNum, purchaseDate);
      const asset: FixedAsset = {
        id: crypto.randomUUID(),
        name: name.trim(),
        accountId: account.id,
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
      const { data: next } = postDepreciation(data, todayStr);
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

  async function exportAssets() {
    const header = ["Asset", "Purchase Date", "Cost", "Useful Life (mo)", "Monthly Dep.", "Accum. Dep.", "Book Value", "Status"];
    const body = assets.map((a) => [
      a.name,
      a.purchaseDate,
      a.cost,
      a.usefulLifeMonths,
      monthlyDepreciation(a),
      accumulatedDepreciation(a, todayStr),
      bookValue(a, todayStr),
      a.disposed ? `Disposed ${a.disposed.date}` : "Active",
    ]);
    await exportWorkbook("Fixed Asset Register.xlsx", [{ name: "Fixed Assets", rows: [header, ...body] }]);
  }

  return (
    <div className="data-panel">
      <h3>Fixed Asset Register</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Straight-line depreciation only. Each asset gets its own ledger account under "Fixed Assets". The Monthly/Accum./Book
        Value columns below are always live and up to date — no action needed to see them. "Run Depreciation" is a separate,
        optional step that <strong>posts real Journal vouchers</strong> (Dr Depreciation Expense / Cr Accumulated Depreciation)
        into the books for whichever months haven't been posted yet; skip it if you only want the numbers for reference.
      </p>
      <div className="master-toolbar">
        <button type="button" className="tr-refresh-btn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Asset"}
        </button>
        <button type="button" className="tr-refresh-btn" disabled={saving || pendingCount === 0} onClick={runDepreciation}>
          {saving ? "Posting…" : pendingCount === 0 ? "Depreciation up to date" : `Run Depreciation (${pendingCount} pending) — posts vouchers`}
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
              {assets.map((a) => {
                const monthly = monthlyDepreciation(a);
                const accum = accumulatedDepreciation(a, todayStr);
                const bv = bookValue(a, todayStr);
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.purchaseDate}</td>
                    <td className="right">{fmt(a.cost)}</td>
                    <td className="right">{a.usefulLifeMonths} mo</td>
                    <td className="right">{fmt(monthly)}</td>
                    <td className="right">{fmt(accum)}</td>
                    <td className="right">{fmt(bv)}</td>
                    <td>
                      {a.disposed ? (
                        <span style={{ opacity: 0.6, fontSize: 12 }}>Disposed {a.disposed.date}</span>
                      ) : (
                        <span style={{ color: "#16a34a", fontSize: 12 }}>Active</span>
                      )}
                    </td>
                    <td>
                      {!a.disposed &&
                        (disposingId === a.id ? (
                          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                            <input type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} style={{ width: 120 }} />
                            <input
                              placeholder="Proceeds"
                              type="number"
                              value={disposalProceeds}
                              onChange={(e) => setDisposalProceeds(e.target.value)}
                              style={{ width: 80 }}
                            />
                            <select value={disposalCashAcct} onChange={(e) => setDisposalCashAcct(e.target.value ? Number(e.target.value) : "")}>
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
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
