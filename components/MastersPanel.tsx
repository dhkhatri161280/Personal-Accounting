"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FloatingWindow } from "@/components/FloatingWindow";
import { accountFormSchema, type AccountFormValues } from "@/lib/account-form-schema";

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
  closedPeriods?: string[];
  transactions?: Array<{ date: string; deleted?: boolean; entries: Array<{ accountId: number }> }>;
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

// Standard ERP-style period control: each calendar month can be closed/reopened independently
// (not a single rolling cutoff) -- see closedPeriods on Ledger (lib/vault-types.ts) and
// findClosedPeriodViolations (lib/vault-accounting.ts), which is what actually blocks a save
// against a closed period. This panel is just the toggle UI; the enforcement lives centrally in
// save() so every create/edit/delete path is covered uniformly.
function PeriodControlPanel({
  fiscalYearStartMonth,
  fys,
  selectedFYs,
  setSelectedFYs,
  fyMenuOpen,
  setFyMenuOpen,
  fyMenuRef,
  closedPeriods,
  onToggle,
}: {
  fiscalYearStartMonth: number;
  fys: number[];
  selectedFYs: Set<number>;
  setSelectedFYs: (next: Set<number>) => void;
  fyMenuOpen: boolean;
  setFyMenuOpen: (fn: (o: boolean) => boolean) => void;
  fyMenuRef: { current: HTMLDivElement | null };
  closedPeriods: string[];
  onToggle: (next: string[], message: string) => void;
}) {
  const monthLabel = (period: string) => {
    const [y, m] = period.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  };
  const periodsInFY = (fy: number): string[] =>
    Array.from({ length: 12 }, (_, i) => {
      const offset = fiscalYearStartMonth - 1 + i;
      const m = (offset % 12) + 1;
      const y = fy + Math.floor(offset / 12);
      return `${y}-${String(m).padStart(2, "0")}`;
    });

  const closedSet = new Set(closedPeriods);

  // Chronological list of every period shown, oldest first -- backs the "close through" cutoff
  // control below (the common "we've closed the books through August" workflow). This stays
  // global (every FY, not just the ones currently expanded below) since "close everything
  // through a date" is a whole-book action, not tied to what's on screen.
  const allPeriodsAsc = useMemo(
    () => [...fys].sort((a, b) => a - b).flatMap(periodsInFY),
    [fys, fiscalYearStartMonth]
  );
  const [cutoff, setCutoff] = useState(allPeriodsAsc[0] || "");

  // Arbitrary multi-select across whichever periods are currently on screen (any FY, any mix of
  // months) -- separate from the per-chip single click and the whole-FY "Close all" buttons,
  // for picking a custom set like "these 3 non-adjacent months" in one bulk action.
  const [selectedPeriods, setSelectedPeriods] = useState<Set<string>>(new Set());
  function togglePeriodSelection(period: string) {
    setSelectedPeriods((prev) => {
      const next = new Set(prev);
      next.has(period) ? next.delete(period) : next.add(period);
      return next;
    });
  }
  function bulkCloseSelected() {
    const toClose = [...selectedPeriods].filter((p) => !closedSet.has(p));
    if (!toClose.length) return;
    setBatch(toClose, true, `${toClose.length} period(s) closed.`);
    setSelectedPeriods(new Set());
  }
  function bulkOpenSelected() {
    const toOpen = [...selectedPeriods].filter((p) => closedSet.has(p));
    if (!toOpen.length) return;
    setBatch(toOpen, false, `${toOpen.length} period(s) reopened.`);
    setSelectedPeriods(new Set());
  }

  function toggle(period: string, isClosed: boolean) {
    const next = isClosed ? closedPeriods.filter((p) => p !== period) : [...closedPeriods, period];
    onToggle(
      next,
      isClosed
        ? `${monthLabel(period)} reopened.`
        : `${monthLabel(period)} closed — vouchers dated in this period can no longer be created, edited, or deleted.`
    );
  }

  function setBatch(periods: string[], close: boolean, message: string) {
    const set = new Set(closedPeriods);
    for (const p of periods) close ? set.add(p) : set.delete(p);
    onToggle([...set], message);
  }

  function closeThrough(cutoffPeriod: string) {
    const toClose = allPeriodsAsc.filter((p) => p <= cutoffPeriod && !closedSet.has(p));
    if (!toClose.length) return;
    setBatch(toClose, true, `Closed ${toClose.length} period(s) through ${monthLabel(cutoffPeriod)}.`);
  }

  return (
    <div className="period-control-panel">
      <p className="field-hint period-control-hint">
        Close any period independently — any combination can stay open or closed at once. Closing
        a period only blocks new, edited, or deleted vouchers dated within it; viewing and reports
        are never affected.
      </p>
      {allPeriodsAsc.length > 0 && (
        <div className="period-cutoff-bar">
          <label>
            Close everything through
            <select value={cutoff} onChange={(e) => setCutoff(e.target.value)}>
              {allPeriodsAsc.map((p) => (
                <option key={p} value={p}>
                  {monthLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={() => closeThrough(cutoff)}>
            Close through this period
          </button>
          <div className="period-fy-picker" ref={fyMenuRef}>
            <button type="button" className="period-fy-picker-trigger" onClick={() => setFyMenuOpen((o) => !o)}>
              {selectedFYs.size === 0
                ? "Select fiscal year(s)"
                : selectedFYs.size === 1
                  ? `FY ${[...selectedFYs][0]}`
                  : `${selectedFYs.size} fiscal years selected`}
              {" "}▾
            </button>
            {fyMenuOpen && (
              <div className="period-fy-menu">
                <label className="period-fy-menu-item period-fy-menu-all">
                  <input
                    type="checkbox"
                    checked={selectedFYs.size === fys.length}
                    onChange={() => setSelectedFYs(selectedFYs.size === fys.length ? new Set() : new Set(fys))}
                  />
                  <span>Select all</span>
                </label>
                <div className="period-fy-menu-divider" />
                {fys.map((fy) => (
                  <label className="period-fy-menu-item" key={fy}>
                    <input
                      type="checkbox"
                      checked={selectedFYs.has(fy)}
                      onChange={() => {
                        const next = new Set(selectedFYs);
                        next.has(fy) ? next.delete(fy) : next.add(fy);
                        setSelectedFYs(next);
                      }}
                    />
                    <span>FY {fy}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {selectedPeriods.size > 0 && (
        <div className="period-bulk-bar">
          <span>{selectedPeriods.size} period(s) selected</span>
          <button type="button" className="primary" onClick={bulkCloseSelected}>
            Close selected
          </button>
          <button type="button" onClick={bulkOpenSelected}>
            Open selected
          </button>
          <button type="button" onClick={() => setSelectedPeriods(new Set())}>
            Clear
          </button>
        </div>
      )}
      {fys.filter((fy) => selectedFYs.has(fy)).map((fy) => {
        const periods = periodsInFY(fy);
        const allClosed = periods.every((p) => closedSet.has(p));
        const noneClosed = periods.every((p) => !closedSet.has(p));
        return (
          <div className="period-fy-group" key={fy}>
            <div className="period-fy-head">
              <h4>
                FY {fy} ({monthLabel(periods[0])} – {monthLabel(periods[11])})
              </h4>
              <div className="period-fy-actions">
                <button
                  type="button"
                  disabled={allClosed}
                  onClick={() => setBatch(periods, true, `FY ${fy} closed (12 period(s)).`)}
                >
                  Close all
                </button>
                <button
                  type="button"
                  disabled={noneClosed}
                  onClick={() => setBatch(periods, false, `FY ${fy} reopened (12 period(s)).`)}
                >
                  Open all
                </button>
              </div>
            </div>
            {[0, 1, 2, 3].map((q) => (
              <div className="period-quarter-row" key={q}>
                <span className="period-quarter-label">Q{q + 1}</span>
                <div className="period-grid period-grid-quarter">
                  {periods.slice(q * 3, q * 3 + 3).map((period) => {
                    const isClosed = closedSet.has(period);
                    return (
                      <div key={period} className={`period-chip ${isClosed ? "period-closed" : "period-open"}`}>
                        <input
                          type="checkbox"
                          className="period-chip-check"
                          checked={selectedPeriods.has(period)}
                          onChange={() => togglePeriodSelection(period)}
                          aria-label={`Select ${monthLabel(period)}`}
                        />
                        <button
                          type="button"
                          className="period-chip-btn"
                          onClick={() => toggle(period, isClosed)}
                        >
                          <span className="period-chip-label">{monthLabel(period)}</span>
                          <span className="period-chip-status">{isClosed ? "Closed" : "Open"}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AccountForm({
  account,
  accountId,
  groups,
  data,
  onSave,
  onCancel,
}: {
  account?: MasterAccount;
  accountId: number | null;
  groups: MasterGroup[];
  data: MasterLedger;
  onSave: (values: AccountFormValues) => void;
  onCancel: () => void;
}) {
  const existingNames = data.accounts.filter((a) => a.id !== accountId).map((a) => a.name);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema(existingNames)),
    defaultValues: {
      name: account?.name || "",
      parent: account?.parent || groups[0]?.name || "",
      currency: account?.currency || data.currency,
      opening: Math.abs(account?.openingBalance || 0),
      side: (account?.openingBalance || 0) <= 0 ? "Dr" : "Cr",
      active: account?.active !== false,
    },
  });
  return (
    <form className="master-form" onSubmit={handleSubmit(onSave)}>
      <label>
        Ledger name
        <input {...register("name")} autoFocus />
        {errors.name && <span className="field-error">{errors.name.message}</span>}
      </label>
      <label>
        Account group
        <select {...register("parent")}>
          {groups
            .filter((g) => g.active !== false)
            .map((g) => (
              <option key={g.name}>{g.name}</option>
            ))}
        </select>
      </label>
      <label>
        Currency
        <select {...register("currency")}>
          {[...new Set([data.currency, ...(data.currencies || [])])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <div className="opening-fields">
        <label>
          Opening balance
          <input {...register("opening", { valueAsNumber: true })} type="number" step="0.01" min="0" />
          {errors.opening && <span className="field-error">{errors.opening.message}</span>}
        </label>
        <label>
          Balance side
          <select {...register("side")}>
            <option>Dr</option>
            <option>Cr</option>
          </select>
        </label>
      </div>
      <label className="check-label">
        <input {...register("active")} type="checkbox" /> Active ledger
      </label>
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary">Save ledger</button>
      </div>
    </form>
  );
}

export function MastersPanel({
  data,
  onSave,
  initialSection,
}: {
  data: MasterLedger;
  onSave: (next: MasterLedger, message: string) => void;
  // Lets a caller deep-link straight into a sub-tab (e.g. the Dashboard's period-open badge
  // jumping to Periods) instead of always landing on Ledgers -- read once on mount, since
  // MastersPanel itself unmounts/remounts whenever the user navigates away from and back to
  // the Masters tab (see the `tab === "masters" &&` conditional render in VaultApp.tsx).
  initialSection?: "ledgers" | "groups" | "periods" | "settings";
}) {
  const [section, setSection] = useState<"ledgers" | "groups" | "periods" | "settings">(initialSection ?? "ledgers"),
    [accountId, setAccountId] = useState<number | null>(null),
    [groupName, setGroupName] = useState<string | null>(null),
    [search, setSearch] = useState("");

  // Fiscal years present in the book (for the Periods tab's FY picker) -- lifted up here rather
  // than kept inside PeriodControlPanel so the picker can render in this same tab row instead of
  // a whole extra row of its own below it.
  const fiscalYearStartMonth = data.fiscalYearStartMonth || 4;
  const fys = useMemo(() => {
    const fyOf = (date: string) => {
      const [y, m] = date.slice(0, 7).split("-").map(Number);
      return m >= fiscalYearStartMonth ? y : y - 1;
    };
    const present = new Set<number>();
    for (const t of data.transactions || []) {
      if (t.deleted) continue;
      present.add(fyOf(t.date));
    }
    const now = new Date();
    present.add(fyOf(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`));
    return [...present].sort((a, b) => b - a);
  }, [data.transactions, fiscalYearStartMonth]);
  const [selectedFYs, setSelectedFYs] = useState<Set<number>>(() => new Set(fys.length ? [fys[0]] : []));
  const [fyMenuOpen, setFyMenuOpen] = useState(false);
  const fyMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fyMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (fyMenuRef.current && !fyMenuRef.current.contains(e.target as Node)) setFyMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [fyMenuOpen]);

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
  const saveAccount = (values: AccountFormValues) => {
    const name = normalize(values.name),
      parent = values.parent,
      currency = values.currency,
      amount = Math.abs(values.opening),
      side = values.side,
      active = values.active;
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
          className={section === "periods" ? "selected" : ""}
          onClick={() => setSection("periods")}
        >
          Periods
        </button>
        <button
          className={section === "settings" ? "selected" : ""}
          onClick={() => setSection("settings")}
        >
          Company Settings
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
      {section === "periods" && (
        <PeriodControlPanel
          fiscalYearStartMonth={fiscalYearStartMonth}
          fys={fys}
          selectedFYs={selectedFYs}
          setSelectedFYs={setSelectedFYs}
          fyMenuOpen={fyMenuOpen}
          setFyMenuOpen={setFyMenuOpen}
          fyMenuRef={fyMenuRef}
          closedPeriods={data.closedPeriods || []}
          onToggle={(next, message) => onSave({ ...data, closedPeriods: next }, message)}
        />
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
        <FloatingWindow title={`${account ? "Edit" : "Create"} Ledger Account`} onClose={() => setAccountId(null)}>
          <AccountForm
            account={account}
            accountId={accountId}
            groups={groups}
            data={data}
            onSave={saveAccount}
            onCancel={() => setAccountId(null)}
          />
        </FloatingWindow>
      )}
      {groupName !== null && (
        <FloatingWindow title={`${group ? "Edit" : "Create"} Account Group`} onClose={() => setGroupName(null)}>
          <form
            className="master-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveGroup(new FormData(e.currentTarget));
            }}
          >
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
        </FloatingWindow>
      )}
    </div>
  );
}
