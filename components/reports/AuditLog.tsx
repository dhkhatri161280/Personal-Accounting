"use client";
import { useState } from "react";
import type { AuditEntry, Ledger, Tx } from "@/lib/vault-types";

const ACTION_COLOR: Record<AuditEntry["action"], string> = {
  created: "#16a34a",
  edited: "#1d4ed8",
  deleted: "#dc2626",
  restored: "#7c3aed",
};

export function AuditLog({ data, onViewVoucher }: { data: Ledger; onViewVoucher: (t: Tx) => void }) {
  const [entityFilter, setEntityFilter] = useState<"" | AuditEntry["entity"]>("");
  const [search, setSearch] = useState("");

  const entries = (data.auditLog ?? [])
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((e) => !entityFilter || e.entity === entityFilter)
    .filter((e) => !search || `${e.summary} ${e.entityId}`.toLowerCase().includes(search.toLowerCase()));

  const txByGuid = new Map(data.transactions.map((t) => [t.guid, t]));

  return (
    <div className="data-panel">
      <h3>Audit Log</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        A running record of who changed what, going forward from when this was added — every voucher create/edit/delete/restore
        and every Masters ledger/group save or delete appends an entry here with a before/after summary. It doesn't retroactively
        cover changes made before this feature shipped, and Tally-side sync activity isn't tracked (only edits made in this app).
      </p>
      <div className="master-toolbar">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search summary" />
        <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value as typeof entityFilter)}>
          <option value="">All entities</option>
          <option value="voucher">Vouchers</option>
          <option value="account">Ledger Accounts</option>
          <option value="group">Account Groups</option>
        </select>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
      </div>
      {entries.length === 0 ? (
        <p style={{ opacity: 0.7 }}>
          No changes recorded yet — nothing has been created, edited, or deleted since this feature was added. Try editing a
          voucher or a Masters ledger/group and check back here.
        </p>
      ) : (
        entries.map((e) => {
          const tx = e.entity === "voucher" ? txByGuid.get(e.entityId) : undefined;
          return (
            <div className="report-line" key={e.id}>
              <span>
                <strong style={{ color: ACTION_COLOR[e.action], textTransform: "capitalize" }}>{e.action}</strong>{" "}
                <span style={{ opacity: 0.6, fontSize: 11, textTransform: "capitalize" }}>({e.entity})</span>
                <br />
                {tx ? (
                  <button type="button" className="columnar-cell-btn" onClick={() => onViewVoucher(tx)}>
                    {e.summary}
                  </button>
                ) : (
                  <small>{e.summary}</small>
                )}
              </span>
              <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
                {new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
