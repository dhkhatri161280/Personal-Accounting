"use client";
import { useMemo, useState } from "react";

export type MasterGroup = {
  name: string;
  parent?: string;
  nature: "Asset" | "Liability" | "Capital" | "Income" | "Expense" | "Bank" | "Cash" | "Investment";
  active?: boolean;
  masterSyncStatus?: "pending" | "synced";
  masterOriginalName?: string;
  tallyGuid?: string;
  tallyMasterId?: number;
  masterFingerprint?: string;
  masterDeletePending?: boolean;
};
export type MasterAccount = {
  id: number;
  name: string;
  parent: string;
  category: string;
  currency: string;
  openingBalance: number;
  active?: boolean;
  masterSyncStatus?: "pending" | "synced";
  masterOriginalName?: string;
  tallyGuid?: string;
  tallyMasterId?: number;
  masterFingerprint?: string;
  masterDeletePending?: boolean;
};
export type MasterLedger = {
  currency: string;
  accounts: MasterAccount[];
  groups?: MasterGroup[];
  currencies?: string[];
  voucherTypes?: string[];
  fiscalYearStartMonth?: number;
  transactions?: Array<{ entries: Array<{ accountId: number }> }>;
};

const standard: MasterGroup[] = [
  { name: "Bank Accounts", nature: "Bank" },
  { name: "Cash-in-hand", nature: "Cash" },
  { name: "Capital Account", nature: "Capital" },
  { name: "Current Assets", nature: "Asset" },
  { name: "Current Liabilities", nature: "Liability" },
  { name: "Deposits (Asset)", nature: "Asset" },
  { name: "Direct Expenses", nature: "Expense" },
  { name: "Direct Incomes", nature: "Income" },
  { name: "Fixed Assets", nature: "Asset" },
  { name: "Indirect Expenses", nature: "Expense" },
  { name: "Indirect Incomes", nature: "Income" },
  { name: "Investments", nature: "Investment" },
  { name: "Loans & Advances (Asset)", nature: "Asset" },
  { name: "Loans (Liability)", nature: "Liability" },
  { name: "Purchase Accounts", nature: "Expense" },
  { name: "Sales Accounts", nature: "Income" },
  { name: "Stock-in-hand", nature: "Asset" },
  { name: "Sundry Creditors", nature: "Liability" },
  { name: "Sundry Debtors", nature: "Asset" },
];
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");

export function MastersPanel({
  data,
  onSave,
}: {
  data: MasterLedger;
  onSave: (next: MasterLedger, message: string) => void;
}) {
  const [section, setSection] = useState<"ledgers" | "groups" | "settings">("ledgers"),
    [accountId, setAccountId] = useState<number | null>(null),
    [groupName, setGroupName] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const map = new Map<string, MasterGroup>();
    for (const g of standard) map.set(g.name.toLowerCase(), g);
    for (const parent of data.accounts.map((a) => a.parent).filter(Boolean))
      if (!map.has(parent.toLowerCase()))
        map.set(parent.toLowerCase(), { name: parent, nature: "Asset" });
    for (const g of data.groups || []) map.set(g.name.toLowerCase(), g);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data.accounts, data.groups]);
  const accounts = data.accounts
    .filter((a) => !search || `${a.name} ${a.parent}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const saveAccount = (form: FormData) => {
    const name = normalize(String(form.get("name") || "")),
      parent = String(form.get("parent") || ""),
      currency = String(form.get("currency") || data.currency),
      amount = Math.abs(Number(form.get("opening") || 0)),
      side = String(form.get("side") || "Dr"),
      active = form.get("active") === "on";
    if (!name || !parent) return;
    const duplicate = data.accounts.some(
      (a) => a.id !== accountId && a.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      alert("A ledger with this name already exists.");
      return;
    }
    const existing = data.accounts.find((a) => a.id === accountId),
      account: MasterAccount = {
        id: existing?.id || Math.max(0, ...data.accounts.map((a) => a.id)) + 1,
        name,
        parent,
        category: groups.find((g) => g.name === parent)?.nature || "Asset",
        currency,
        openingBalance: side === "Dr" ? -amount : amount,
        active,
        masterSyncStatus: "pending",
        masterOriginalName: existing?.masterOriginalName || existing?.name,
        tallyGuid: existing?.tallyGuid,
        masterFingerprint: "app-change-" + Date.now(),
      };
    const next = {
      ...data,
      accounts: existing
        ? data.accounts.map((a) => (a.id === existing.id ? account : a))
        : [...data.accounts, account],
    };
    onSave(next, `${existing ? "Updated" : "Created"} ledger ${name}.`);
    setAccountId(null);
  };
  const saveGroup = (form: FormData) => {
    const name = normalize(String(form.get("name") || "")),
      parent = String(form.get("parent") || ""),
      nature = String(form.get("nature") || "Asset") as MasterGroup["nature"],
      active = form.get("active") === "on";
    if (!name) return;
    const old = groupName,
      duplicate = groups.some((g) => g.name !== old && g.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      alert("A group with this name already exists.");
      return;
    }
    const existingGroup = groups.find((g) => g.name === old),
      group: MasterGroup = {
        name,
        parent: parent || undefined,
        nature,
        active,
        masterSyncStatus: "pending",
        masterOriginalName: existingGroup?.masterOriginalName || existingGroup?.name,
        tallyGuid: existingGroup?.tallyGuid,
        tallyMasterId: existingGroup?.tallyMasterId,
        masterFingerprint: "app-change-" + Date.now(),
      },
      custom = (data.groups || []).filter((g) => g.name !== old);
    const accounts =
      old && old !== name
        ? data.accounts.map((a) => (a.parent === old ? { ...a, parent } : a))
        : data.accounts;
    onSave(
      { ...data, accounts, groups: [...custom, group] },
      `${old ? "Updated" : "Created"} group ${name}.`
    );
    setGroupName(null);
  };
  const copyAccount = (a: MasterAccount) => {
    let name = `${a.name} - Copy`,
      n = 2;
    while (data.accounts.some((x) => x.name.toLowerCase() === name.toLowerCase()))
      name = `${a.name} - Copy ${n++}`;
    const copy: MasterAccount = {
      ...a,
      id: Math.max(0, ...data.accounts.map((x) => x.id)) + 1,
      name,
      masterSyncStatus: "pending",
      masterOriginalName: undefined,
      tallyGuid: undefined,
      tallyMasterId: undefined,
      masterFingerprint: "app-change-" + Date.now(),
      masterDeletePending: false,
    };
    onSave(
      { ...data, accounts: [...data.accounts, copy] },
      `Copied ledger as ${name}. Edit it if required; it is pending Tally synchronization.`
    );
  };
  const deleteAccount = (a: MasterAccount) => {
    if (data.transactions?.some((t) => t.entries.some((e) => e.accountId === a.id))) {
      alert("This ledger has vouchers and cannot be deleted. Make it inactive instead.");
      return;
    }
    if (!confirm(`Delete ledger ${a.name} from the App and Tally?`)) return;
    const linked = !!(a.tallyGuid || a.tallyMasterId || a.masterFingerprint);
    onSave(
      {
        ...data,
        accounts: linked
          ? data.accounts.map((x) =>
              x.id === a.id
                ? { ...x, active: false, masterSyncStatus: "pending", masterDeletePending: true }
                : x
            )
          : data.accounts.filter((x) => x.id !== a.id),
      },
      linked ? `Ledger ${a.name} is pending deletion from Tally.` : `Ledger ${a.name} deleted.`
    );
  };
  const copyGroup = (g: MasterGroup) => {
    let name = `${g.name} - Copy`,
      n = 2;
    while (groups.some((x) => x.name.toLowerCase() === name.toLowerCase()))
      name = `${g.name} - Copy ${n++}`;
    const copy: MasterGroup = {
      ...g,
      name,
      masterSyncStatus: "pending",
      masterOriginalName: undefined,
      tallyGuid: undefined,
      tallyMasterId: undefined,
      masterFingerprint: "app-change-" + Date.now(),
      masterDeletePending: false,
    };
    onSave(
      { ...data, groups: [...(data.groups || []), copy] },
      `Copied group as ${name}. It is pending Tally synchronization.`
    );
  };
  const deleteGroup = (g: MasterGroup) => {
    if (usedGroups.has(g.name)) {
      alert("This group is used by ledger accounts and cannot be deleted.");
      return;
    }
    if (!confirm(`Delete group ${g.name} from the App and Tally?`)) return;
    const linked = !!(g.tallyGuid || g.tallyMasterId || g.masterFingerprint),
      custom = data.groups || [];
    onSave(
      {
        ...data,
        groups: linked
          ? custom.map((x) =>
              x.name === g.name
                ? { ...x, active: false, masterSyncStatus: "pending", masterDeletePending: true }
                : x
            )
          : custom.filter((x) => x.name !== g.name),
      },
      linked ? `Group ${g.name} is pending deletion from Tally.` : `Group ${g.name} deleted.`
    );
  };
  const account = data.accounts.find((a) => a.id === accountId),
    group = groups.find((g) => g.name === groupName),
    usedGroups = new Set(data.accounts.map((a) => a.parent));
  return (
    <div className="masters-panel">
      <div className="master-tabs">
        <button
          className={section === "ledgers" ? "selected" : ""}
          onClick={() => setSection("ledgers")}
        >
          Ledger Accounts
        </button>
        <button
          className={section === "groups" ? "selected" : ""}
          onClick={() => setSection("groups")}
        >
          Account Groups
        </button>
        <button
          className={section === "settings" ? "selected" : ""}
          onClick={() => setSection("settings")}
        >
          Other Masters
        </button>
      </div>
      {section === "ledgers" && (
        <>
          <div className="master-toolbar">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ledger or group"
            />
            <button className="primary" onClick={() => setAccountId(0)}>
              + New Ledger
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                <th>Currency</th>
                <th>Opening</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={a.masterDeletePending ? "master-deleting" : ""}>
                  <td>{a.name}</td>
                  <td>{a.parent}</td>
                  <td>{a.currency}</td>
                  <td className="right">
                    {Math.abs(a.openingBalance).toFixed(2)} {a.openingBalance <= 0 ? "Dr" : "Cr"}
                  </td>
                  <td>
                    {a.masterSyncStatus === "pending" ? (
                      <span className="master-status pending">
                        {a.masterDeletePending ? "Pending delete" : "Pending"}
                      </span>
                    ) : (
                      <span className="master-status synced">
                        {a.active === false ? "Inactive" : "Synced"}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="master-actions">
                      <button className="master-edit" onClick={() => setAccountId(a.id)}>
                        Edit
                      </button>
                      <button className="master-copy" onClick={() => copyAccount(a)}>
                        Copy
                      </button>
                      <button className="master-delete" onClick={() => deleteAccount(a)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {section === "groups" && (
        <>
          <div className="master-toolbar">
            <span>{groups.length} available groups</span>
            <button className="primary" onClick={() => setGroupName("")}>
              + New Group
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Parent Group</th>
                <th>Statement Nature</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.name} className={g.masterDeletePending ? "master-deleting" : ""}>
                  <td>{g.name}</td>
                  <td>{g.parent || "Primary"}</td>
                  <td>{g.nature}</td>
                  <td>
                    {g.masterSyncStatus === "pending" ? (
                      <span className="master-status pending">
                        {g.masterDeletePending ? "Pending delete" : "Pending"}
                      </span>
                    ) : (
                      <span className="master-status synced">
                        {g.active === false ? "Inactive" : "Synced"}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="master-actions">
                      <button className="master-edit" onClick={() => setGroupName(g.name)}>
                        Edit
                      </button>
                      <button className="master-copy" onClick={() => copyGroup(g)}>
                        Copy
                      </button>
                      <button
                        className="master-delete"
                        disabled={usedGroups.has(g.name)}
                        onClick={() => deleteGroup(g)}
                      >
                        Delete
                      </button>
                    </div>
                    {usedGroups.has(g.name) && <small className="used-master">In use</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {section === "settings" && (
        <form
          className="master-form settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              currencies = String(f.get("currencies") || "")
                .split(",")
                .map(normalize)
                .filter(Boolean),
              voucherTypes = String(f.get("voucherTypes") || "")
                .split(",")
                .map(normalize)
                .filter(Boolean),
              fiscalYearStartMonth = Number(f.get("fiscalMonth") || 4);
            onSave(
              { ...data, currencies, voucherTypes, fiscalYearStartMonth },
              "Other masters updated."
            );
          }}
        >
          <h3>Company accounting settings</h3>
          <label>
            Base currency
            <input value={data.currency} readOnly />
          </label>
          <label>
            Allowed currencies
            <input
              name="currencies"
              defaultValue={(data.currencies || [data.currency]).join(", ")}
              placeholder="USD, INR"
            />
          </label>
          <label>
            Voucher types
            <input
              name="voucherTypes"
              defaultValue={(data.voucherTypes || ["Payment", "Receipt", "Contra", "Journal"]).join(
                ", "
              )}
            />
          </label>
          <label>
            Fiscal year starts
            <select name="fiscalMonth" defaultValue={data.fiscalYearStartMonth || 4}>
              {Array.from({ length: 12 }, (_, i) => (
                <option value={i + 1} key={i}>
                  {new Date(2026, i, 1).toLocaleString("en-US", { month: "long" })}
                </option>
              ))}
            </select>
          </label>
          <button className="primary">Save settings</button>
        </form>
      )}
      {accountId !== null && (
        <div className="master-modal">
          <form
            className="master-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveAccount(new FormData(e.currentTarget));
            }}
          >
            <h3>{account ? "Edit" : "Create"} Ledger Account</h3>
            <label>
              Ledger name
              <input name="name" defaultValue={account?.name} required autoFocus />
            </label>
            <label>
              Account group
              <select name="parent" defaultValue={account?.parent || groups[0]?.name}>
                {groups
                  .filter((g) => g.active !== false)
                  .map((g) => (
                    <option key={g.name}>{g.name}</option>
                  ))}
              </select>
            </label>
            <label>
              Currency
              <select name="currency" defaultValue={account?.currency || data.currency}>
                {[...new Set([data.currency, ...(data.currencies || [])])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <div className="opening-fields">
              <label>
                Opening balance
                <input
                  name="opening"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={Math.abs(account?.openingBalance || 0)}
                />
              </label>
              <label>
                Balance side
                <select
                  name="side"
                  defaultValue={(account?.openingBalance || 0) <= 0 ? "Dr" : "Cr"}
                >
                  <option>Dr</option>
                  <option>Cr</option>
                </select>
              </label>
            </div>
            <label className="check-label">
              <input name="active" type="checkbox" defaultChecked={account?.active !== false} />{" "}
              Active ledger
            </label>
            <div>
              <button type="button" onClick={() => setAccountId(null)}>
                Cancel
              </button>
              <button className="primary">Save ledger</button>
            </div>
          </form>
        </div>
      )}
      {groupName !== null && (
        <div className="master-modal">
          <form
            className="master-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveGroup(new FormData(e.currentTarget));
            }}
          >
            <h3>{group ? "Edit" : "Create"} Account Group</h3>
            <label>
              Group name
              <input name="name" defaultValue={group?.name} required autoFocus />
            </label>
            <label>
              Parent group
              <select name="parent" defaultValue={group?.parent || ""}>
                <option value="">Primary</option>
                {groups
                  .filter((g) => g.name !== group?.name && g.active !== false)
                  .map((g) => (
                    <option key={g.name}>{g.name}</option>
                  ))}
              </select>
            </label>
            <label>
              Financial statement classification
              <select name="nature" defaultValue={group?.nature || "Asset"}>
                {[
                  "Asset",
                  "Liability",
                  "Capital",
                  "Income",
                  "Expense",
                  "Bank",
                  "Cash",
                  "Investment",
                ].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="check-label">
              <input name="active" type="checkbox" defaultChecked={group?.active !== false} />{" "}
              Active group
            </label>
            <div>
              <button type="button" onClick={() => setGroupName(null)}>
                Cancel
              </button>
              <button className="primary">Save group</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
