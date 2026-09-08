"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FloatingWindow } from "@/components/FloatingWindow";
import { accountFormSchema, type AccountFormValues } from "@/lib/account-form-schema";
import type { RecurringTemplate, AuditEntry, FixedAsset, Ledger } from "@/lib/vault-types";
import { appendAuditEntry, diffFields, summarize } from "@/lib/audit";
import { fmtDate } from "@/lib/format-date";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  guessAssetClass,
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  ASSET_CLASS_SUGGESTIONS,
  UNCLASSIFIED_LABEL,
  ASSET_CLASS_PREFIXES,
  defaultUsefulLifeForClass,
  suggestNextAssetTag,
} from "@/lib/fixed-assets";
import { getOrCreateAssetAccount, findLegacyCostMismatches, repairLegacyAssetCosts } from "@/lib/fixed-assets-ledger";
import { AssetTagPicker } from "@/components/AssetTagPicker";

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
  company?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  currency: string;
  accounts: MasterAccount[];
  groups?: MasterGroup[];
  currencies?: string[];
  voucherTypes?: string[];
  fiscalYearStartMonth?: number;
  closedPeriods?: string[];
  transactions?: Array<{ date: string; deleted?: boolean; entries: Array<{ accountId: number }> }>;
  recurringTemplates?: RecurringTemplate[];
  auditLog?: AuditEntry[];
  fixedAssets?: FixedAsset[];
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
  onTagAsset,
}: {
  data: MasterLedger;
  onSave: (next: MasterLedger, message: string) => void;
  // Lets a caller deep-link straight into a sub-tab (e.g. the Dashboard's period-open badge
  // jumping to Periods) instead of always landing on Ledgers -- read once on mount, since
  // MastersPanel itself unmounts/remounts whenever the user navigates away from and back to
  // the Masters tab (see the `tab === "masters" &&` conditional render in VaultApp.tsx).
  initialSection?: "ledgers" | "groups" | "periods" | "recurring" | "fixedassets" | "settings";
  // Applies a Fixed Asset # to every voucher already posted on an untagged asset's own ledger --
  // routed through a dedicated prop (not the generic onSave above) because it needs to exempt
  // those (possibly closed-period) vouchers from the closed-period check, the same way
  // FixedAssetRegister's "Tag all vouchers" action does. See bulkTagAsset in VaultApp.tsx.
  onTagAsset?: (asset: FixedAsset, tag: string) => Promise<void> | void;
}) {
  const [section, setSection] = useState<"ledgers" | "groups" | "periods" | "recurring" | "fixedassets" | "settings">(initialSection ?? "ledgers"),
    [accountId, setAccountId] = useState<number | null>(null),
    [groupName, setGroupName] = useState<string | null>(null),
    [recurringTemplateId, setRecurringTemplateId] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    // Fixed Assets master data (name/class/useful life/salvage) -- Cost/Fixed Asset #/purchase
    // date stay read-only here since they're derived facts from the real ledger/tag, not
    // hand-typed master fields; see components/reports/FixedAssetRegister.tsx for the report
    // view (Dispose/Run Depreciation/drill-down) this data feeds.
    [showAddAsset, setShowAddAsset] = useState(false),
    [assetName, setAssetName] = useState(""),
    [assetClassInput, setAssetClassInput] = useState(""),
    [assetTagInput, setAssetTagInput] = useState(""),
    [editingAssetNameId, setEditingAssetNameId] = useState<string | null>(null),
    [editingAssetNameValue, setEditingAssetNameValue] = useState(""),
    [editingAssetClassId, setEditingAssetClassId] = useState<string | null>(null),
    [editingAssetClassValue, setEditingAssetClassValue] = useState(""),
    [editingAssetLifeId, setEditingAssetLifeId] = useState<string | null>(null),
    [editingAssetLifeValue, setEditingAssetLifeValue] = useState(""),
    [editingAssetSalvageValue, setEditingAssetSalvageValue] = useState(""),
    [deletingAssetId, setDeletingAssetId] = useState<string | null>(null),
    [taggingAssetId, setTaggingAssetId] = useState<string | null>(null),
    [taggingValue, setTaggingValue] = useState(""),
    [tagging, setTagging] = useState(false);

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
    // `active` defaults to undefined on legacy accounts but the form always writes an explicit
    // boolean -- normalize both sides to the app's own "active !== false" convention first, or
    // every edit of a never-toggled account would show a spurious "active changed" diff.
    const changes = existing
      ? diffFields({ ...existing, active: existing.active !== false }, { ...account, active: account.active !== false }, ["name", "parent", "currency", "openingBalance", "active"])
      : [];
    const next = appendAuditEntry(
      {
        ...data,
        accounts: existing
          ? data.accounts.map((a) => (a.id === existing.id ? account : a))
          : [...data.accounts, account],
      },
      {
        entity: "account",
        entityId: String(account.id),
        action: existing ? "edited" : "created",
        summary: summarize(changes, existing ? undefined : `Ledger created: ${name}`),
        changes: changes.length ? changes : undefined,
      }
    );
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
    const changes = existingGroup
      ? diffFields({ ...existingGroup, active: existingGroup.active !== false }, { ...group, active: group.active !== false }, ["name", "parent", "nature", "active"])
      : [];
    const next = appendAuditEntry(
      { ...data, accounts, groups: [...custom, group] },
      {
        entity: "group",
        entityId: name,
        action: existingGroup ? "edited" : "created",
        summary: summarize(changes, existingGroup ? undefined : `Group created: ${name}`),
        changes: changes.length ? changes : undefined,
      }
    );
    onSave(next, `${old ? "Updated" : "Created"} group ${name}.`);
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
    const next = appendAuditEntry<MasterLedger>(
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
      { entity: "account", entityId: String(a.id), action: "deleted", summary: `Ledger deleted: ${a.name}` }
    );
    onSave(next, linked ? `Ledger ${a.name} is pending deletion from Tally.` : `Ledger ${a.name} deleted.`);
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
    const next = appendAuditEntry<MasterLedger>(
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
      { entity: "group", entityId: g.name, action: "deleted", summary: `Group deleted: ${g.name}` }
    );
    onSave(
      next,
      linked ? `Group ${g.name} is pending deletion from Tally.` : `Group ${g.name} deleted.`
    );
  };
  // MasterLedger is a deliberately-narrowed view of the real Ledger the caller actually passed in
  // (see VaultApp.tsx's `next as Ledger` cast on this component's own onSave) -- these specific
  // lib/fixed-assets*.ts helpers need the full Ledger shape (transactions with real Entry fields,
  // not MasterLedger's trimmed-down transaction summary), so the same cast is used here rather
  // than duplicating their logic against a narrower type.
  const assetLedger = data as unknown as Ledger;
  const fixedAssetsList = (data.fixedAssets ?? [])
    .slice()
    .sort((a, b) => (a.sourceTag || "").localeCompare(b.sourceTag || "", undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const legacyCostMismatches = findLegacyCostMismatches(assetLedger);
  const unclassifiedAssetCount = fixedAssetsList.filter((a) => !a.assetClass).length;

  // Suggested tag for the asset currently being added, based on its (possibly still-typed) Class
  // -- purely a placeholder/starting point; the user can override or clear it (a blank tag stays
  // a legacy asset, taggable later via the per-row "Tag" action below).
  const newAssetSuggestedTag = (() => {
    const cls = assetClassInput.trim() || guessAssetClass(assetName.trim()) || UNCLASSIFIED_LABEL;
    const prefix = ASSET_CLASS_PREFIXES[cls] || ASSET_CLASS_PREFIXES[UNCLASSIFIED_LABEL];
    const existingTags = fixedAssetsList.map((a) => a.sourceTag).filter((t): t is string => !!t);
    return suggestNextAssetTag(existingTags, prefix);
  })();

  // New asset creation is deliberately reduced to Name / Class / Fixed Asset # -- Useful Life and
  // Salvage are a property of the Class (defaultUsefulLifeForClass), not hand-typed per asset, and
  // Cost/Purchase Date are a derived fact of the real ledger once a real voucher gets tagged to it
  // (or via the "Tag" action below for an already-posted purchase), never something to guess up
  // front. This creates a $0 shell ledger/master ready to receive that real posting.
  function addAsset() {
    const name = assetName.trim();
    if (!name) return;
    const cls = assetClassInput.trim() || guessAssetClass(name) || UNCLASSIFIED_LABEL;
    const tag = assetTagInput.trim();
    const today = new Date().toISOString().slice(0, 10);
    const { data: withAcct, account } = getOrCreateAssetAccount(assetLedger, name, 0, today);
    const asset: FixedAsset = {
      id: crypto.randomUUID(),
      name,
      accountId: account.id,
      assetClass: cls,
      purchaseDate: today,
      cost: 0,
      salvageValue: 0,
      usefulLifeMonths: defaultUsefulLifeForClass(cls),
      ...(tag ? { sourceAccountId: account.id, sourceTag: tag } : {}),
    };
    const next: MasterLedger = { ...withAcct, fixedAssets: [...(withAcct.fixedAssets ?? []), asset] };
    onSave(next, `Fixed asset ${asset.name} added${tag ? ` (${tag})` : ""}.`);
    setShowAddAsset(false);
    setAssetName("");
    setAssetClassInput("");
    setAssetTagInput("");
  }

  function openTagAsset(a: FixedAsset) {
    const cls = a.assetClass || UNCLASSIFIED_LABEL;
    const prefix = ASSET_CLASS_PREFIXES[cls] || ASSET_CLASS_PREFIXES[UNCLASSIFIED_LABEL];
    const existingTags = fixedAssetsList.map((x) => x.sourceTag).filter((t): t is string => !!t);
    setTaggingValue(suggestNextAssetTag(existingTags, prefix));
    setTaggingAssetId(a.id);
  }

  async function confirmTagAsset(a: FixedAsset) {
    const tag = taggingValue.trim();
    if (!tag || !onTagAsset) return;
    setTagging(true);
    try {
      await onTagAsset(a, tag);
      setTaggingAssetId(null);
    } finally {
      setTagging(false);
    }
  }

  function autoClassifyAssets() {
    const updated = fixedAssetsList.map((a) => (a.assetClass ? a : { ...a, assetClass: guessAssetClass(a.name) || a.assetClass }));
    if (updated.every((a, i) => a.assetClass === fixedAssetsList[i].assetClass)) return;
    onSave({ ...data, fixedAssets: updated }, `${updated.filter((a, i) => a.assetClass !== fixedAssetsList[i].assetClass).length} asset(s) auto-classified.`);
  }

  function repairAssetCosts() {
    if (!legacyCostMismatches.length) return;
    const next = repairLegacyAssetCosts(assetLedger);
    onSave(next as unknown as MasterLedger, `${legacyCostMismatches.length} ledger total(s) corrected.`);
  }

  function saveAssetName(asset: FixedAsset) {
    const trimmed = editingAssetNameValue.trim();
    const ledgerName = data.accounts.find((acc) => acc.id === asset.accountId)?.name || asset.name;
    const updated = fixedAssetsList.map((a) => (a.id === asset.id ? { ...a, name: trimmed || ledgerName } : a));
    onSave({ ...data, fixedAssets: updated }, `Renamed to "${trimmed || ledgerName}".`);
    setEditingAssetNameId(null);
  }

  function saveAssetClass(assetId: string) {
    const updated = fixedAssetsList.map((a) => (a.id === assetId ? { ...a, assetClass: editingAssetClassValue.trim() || undefined } : a));
    onSave({ ...data, fixedAssets: updated }, "Group / Class updated.");
    setEditingAssetClassId(null);
  }

  function saveAssetLife(assetId: string) {
    const life = Number(editingAssetLifeValue);
    const salvage = Number(editingAssetSalvageValue) || 0;
    if (!life || life <= 0) return;
    const updated = fixedAssetsList.map((a) => (a.id === assetId ? { ...a, usefulLifeMonths: life, salvageValue: salvage } : a));
    onSave({ ...data, fixedAssets: updated }, "Useful life / salvage updated.");
    setEditingAssetLifeId(null);
  }

  function deleteAsset(assetId: string) {
    const updated = fixedAssetsList.filter((a) => a.id !== assetId);
    onSave({ ...data, fixedAssets: updated }, "Fixed asset deleted.");
    setDeletingAssetId(null);
  }

  const saveRecurringTemplate = (form: FormData) => {
    const label = normalize(String(form.get("label") || "")),
      frequency = String(form.get("frequency") || "monthly") as RecurringTemplate["frequency"],
      dayOfMonth = form.get("dayOfMonth") ? Number(form.get("dayOfMonth")) : undefined,
      voucherType = String(form.get("voucherType") || "Payment"),
      narrationTemplate = normalize(String(form.get("narrationTemplate") || `{month} ${label}`)),
      active = form.get("active") === "on",
      debitAccountId = Number(form.get("debitAccountId")),
      creditAccountId = Number(form.get("creditAccountId")),
      amount = Math.abs(Number(form.get("amount") || 0)),
      institutionPattern = normalize(String(form.get("institutionPattern") || "")),
      amountTolerance = Number(form.get("amountTolerance") || 5);
    if (!label || !debitAccountId || !creditAccountId || !amount) return;
    const existing = (data.recurringTemplates || []).find((t) => t.id === recurringTemplateId);
    const template: RecurringTemplate = {
      id: existing?.id || crypto.randomUUID(),
      label,
      active,
      frequency,
      dayOfMonth,
      voucherType,
      narrationTemplate,
      entries: [
        { accountId: debitAccountId, amount: -amount },
        { accountId: creditAccountId, amount },
      ],
      plaidMatch: institutionPattern ? { institutionPattern, amountTolerance } : undefined,
      postings: existing?.postings || [],
    };
    const custom = (data.recurringTemplates || []).filter((t) => t.id !== template.id);
    onSave(
      { ...data, recurringTemplates: [...custom, template] },
      `${existing ? "Updated" : "Created"} recurring template ${label}.`
    );
    setRecurringTemplateId(null);
  };
  const deleteRecurringTemplate = (t: RecurringTemplate) => {
    if (!confirm(`Delete recurring template ${t.label}? Vouchers already posted from it are unaffected.`)) return;
    onSave(
      { ...data, recurringTemplates: (data.recurringTemplates || []).filter((x) => x.id !== t.id) },
      `Recurring template ${t.label} deleted.`
    );
  };
  const account = data.accounts.find((a) => a.id === accountId),
    group = groups.find((g) => g.name === groupName),
    recurringTemplate = (data.recurringTemplates || []).find((t) => t.id === recurringTemplateId),
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
          className={section === "recurring" ? "selected" : ""}
          onClick={() => setSection("recurring")}
        >
          Recurring Templates
        </button>
        <button
          className={section === "fixedassets" ? "selected" : ""}
          onClick={() => setSection("fixedassets")}
        >
          Fixed Assets
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
      {section === "recurring" && (
        <>
          <div className="master-toolbar">
            <span>{(data.recurringTemplates || []).length} recurring template(s)</span>
            <button className="primary" onClick={() => setRecurringTemplateId("")}>
              + New Recurring Template
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Frequency</th>
                <th>Amount</th>
                <th>Plaid Match</th>
                <th>Status</th>
                <th>Postings</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {(data.recurringTemplates || [])
                .slice()
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((t) => (
                  <tr key={t.id}>
                    <td>{t.label}</td>
                    <td>{t.frequency === "yearly" ? "Yearly" : "Monthly"}</td>
                    <td className="right">{Math.abs(t.entries.find((e) => e.amount < 0)?.amount ?? 0).toFixed(2)}</td>
                    <td>{t.plaidMatch ? t.plaidMatch.institutionPattern : "Manual only"}</td>
                    <td>
                      <span className={`master-status ${t.active ? "synced" : "pending"}`}>
                        {t.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>{t.postings.length}</td>
                    <td>
                      <div className="master-actions">
                        <button className="master-edit" onClick={() => setRecurringTemplateId(t.id)}>
                          Edit
                        </button>
                        <button className="master-delete" onClick={() => deleteRecurringTemplate(t)}>
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
      {section === "fixedassets" && (
        <>
          <p className="field-hint" style={{ margin: "0 0 10px" }}>
            Name, Group/Class, Useful Life, and Salvage are editable master data. Cost is read-only here — it's a derived fact of
            the real ledger balance, not something to hand-type. An untagged asset can be given a Fixed Asset # here (🏷 Tag) —
            applies it to every voucher already posted on its own ledger, existing or new. See Reports → Registers → Fixed Asset
            Register for depreciation, disposal, and drill-down.
          </p>
          <div className="master-toolbar">
            <button type="button" className="tr-refresh-btn" onClick={() => setShowAddAsset((v) => !v)}>
              {showAddAsset ? "Cancel" : "+ Add Asset"}
            </button>
            {unclassifiedAssetCount > 0 && (
              <button type="button" className="tr-refresh-btn" onClick={autoClassifyAssets}>
                🪄 Auto-classify {unclassifiedAssetCount}
              </button>
            )}
            {legacyCostMismatches.length > 0 && (
              <button
                type="button"
                onClick={repairAssetCosts}
                title={`Fix ${legacyCostMismatches.length} incorrect ledger total(s): ${legacyCostMismatches
                  .map((m) => `${m.name} ${m.currentCost.toFixed(2)} → ${m.correctCost.toFixed(2)}`)
                  .join("; ")}`}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 4px", fontSize: 13, color: "#dc2626" }}
              >
                🔧 ({legacyCostMismatches.length})
              </button>
            )}
          </div>
          <datalist id="master-asset-class-suggestions">
            {ASSET_CLASS_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {showAddAsset && (
            <div className="report-line" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <input placeholder="Asset name / description" value={assetName} onChange={(e) => setAssetName(e.target.value)} style={{ width: 200 }} />
              <input
                list="master-asset-class-suggestions"
                placeholder="Group / Class"
                value={assetClassInput}
                onChange={(e) => setAssetClassInput(e.target.value)}
                style={{ width: 170 }}
              />
              <input
                placeholder={newAssetSuggestedTag}
                title="Fixed Asset # (optional) -- leave blank to tag it later, once you know it"
                value={assetTagInput}
                onChange={(e) => setAssetTagInput(e.target.value)}
                style={{ width: 100 }}
              />
              <button type="button" className="tr-refresh-btn" onClick={addAsset}>
                Save Asset
              </button>
            </div>
          )}
          {showAddAsset && (
            <p className="field-hint" style={{ margin: "0 0 10px" }}>
              Useful life ({defaultUsefulLifeForClass(assetClassInput.trim() || guessAssetClass(assetName.trim()) || UNCLASSIFIED_LABEL)} mo) and
              salvage (0) come from the Group/Class and can be adjusted per asset afterward. Cost is set automatically once a real
              purchase voucher is tagged to this asset.
            </p>
          )}
          {fixedAssetsList.length === 0 ? (
            <p style={{ opacity: 0.7 }}>No fixed assets yet. Add one above, or tag a voucher line to create one automatically.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Fixed Asset #</th>
                  <th>Group / Class</th>
                  <th>Useful Life</th>
                  <th>Salvage</th>
                  <th className="right">Cost</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fixedAssetsList.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {editingAssetNameId === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            autoFocus
                            value={editingAssetNameValue}
                            onChange={(e) => setEditingAssetNameValue(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && saveAssetName(a)}
                            style={{ width: 160 }}
                          />
                          <button className="master-edit" onClick={() => saveAssetName(a)}>
                            Save
                          </button>
                          <button className="master-delete" onClick={() => setEditingAssetNameId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="ledger-link"
                          onClick={() => {
                            setEditingAssetNameId(a.id);
                            setEditingAssetNameValue(a.name);
                          }}
                        >
                          {a.name}
                        </button>
                      )}
                    </td>
                    <td>
                      {taggingAssetId === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <AssetTagPicker
                            fixedAssets={fixedAssetsList}
                            accountId={a.accountId}
                            value={taggingValue}
                            onChange={setTaggingValue}
                            suggestedNewTag={taggingValue}
                          />
                          <button className="master-edit" disabled={tagging || !taggingValue.trim()} onClick={() => confirmTagAsset(a)}>
                            Apply
                          </button>
                          <button className="master-delete" onClick={() => setTaggingAssetId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : a.sourceTag ? (
                        a.sourceTag
                      ) : onTagAsset ? (
                        <button
                          type="button"
                          className="master-edit"
                          title="Apply a Fixed Asset # to every voucher already posted on this asset's own ledger"
                          onClick={() => openTagAsset(a)}
                        >
                          🏷 Tag
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {editingAssetClassId === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            list="master-asset-class-suggestions"
                            autoFocus
                            value={editingAssetClassValue}
                            onChange={(e) => setEditingAssetClassValue(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && saveAssetClass(a.id)}
                            style={{ width: 140 }}
                          />
                          <button className="master-edit" onClick={() => saveAssetClass(a.id)}>
                            Save
                          </button>
                          <button className="master-delete" onClick={() => setEditingAssetClassId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="ledger-link"
                          onClick={() => {
                            setEditingAssetClassId(a.id);
                            setEditingAssetClassValue(a.assetClass || "");
                          }}
                        >
                          {a.assetClass || UNCLASSIFIED_LABEL}
                        </button>
                      )}
                    </td>
                    <td colSpan={editingAssetLifeId === a.id ? 2 : 1}>
                      {editingAssetLifeId === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            autoFocus
                            type="number"
                            value={editingAssetLifeValue}
                            onChange={(e) => setEditingAssetLifeValue(e.target.value)}
                            style={{ width: 60 }}
                          />
                          mo, salvage
                          <input
                            type="number"
                            value={editingAssetSalvageValue}
                            onChange={(e) => setEditingAssetSalvageValue(e.target.value)}
                            style={{ width: 70 }}
                          />
                          <button className="master-edit" onClick={() => saveAssetLife(a.id)}>
                            Save
                          </button>
                          <button className="master-delete" onClick={() => setEditingAssetLifeId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="ledger-link"
                          onClick={() => {
                            setEditingAssetLifeId(a.id);
                            setEditingAssetLifeValue(String(a.usefulLifeMonths));
                            setEditingAssetSalvageValue(String(a.salvageValue));
                          }}
                        >
                          {a.usefulLifeMonths} mo
                        </button>
                      )}
                    </td>
                    {editingAssetLifeId !== a.id && <td>{a.salvageValue}</td>}
                    <td className="right">{a.cost.toFixed(2)}</td>
                    <td>{a.disposed ? `Disposed ${fmtDate(a.disposed.date)}` : "Active"}</td>
                    <td>
                      {!a.disposed && !a.lastDepreciatedThrough && (
                        deletingAssetId === a.id ? (
                          <span style={{ display: "flex", gap: 4 }}>
                            <button className="master-delete" onClick={() => deleteAsset(a.id)}>
                              Confirm
                            </button>
                            <button className="master-edit" onClick={() => setDeletingAssetId(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button className="master-delete" onClick={() => setDeletingAssetId(a.id)}>
                            Delete
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
              fiscalYearStartMonth = Number(f.get("fiscalMonth") || 4),
              company = String(f.get("company") || "").trim(),
              companyAddress = String(f.get("companyAddress") || "").trim(),
              companyPhone = String(f.get("companyPhone") || "").trim(),
              companyEmail = String(f.get("companyEmail") || "").trim();
            onSave(
              {
                ...data,
                currencies,
                voucherTypes,
                fiscalYearStartMonth,
                ...(company ? { company } : {}),
                companyAddress,
                companyPhone,
                companyEmail,
              },
              "Other masters updated."
            );
          }}
        >
          <h3>Company profile</h3>
          <label>
            Company / entity name
            <input name="company" defaultValue={data.company} autoComplete="off" />
          </label>
          <label>
            Address
            <textarea
              name="companyAddress"
              rows={2}
              defaultValue={data.companyAddress || ""}
              placeholder="Street, City, State, ZIP"
              autoComplete="off"
            />
          </label>
          <label>
            Phone
            <input name="companyPhone" defaultValue={data.companyPhone || ""} placeholder="(555) 555-5555" autoComplete="off" />
          </label>
          <label>
            Email
            <input type="email" name="companyEmail" defaultValue={data.companyEmail || ""} placeholder="you@example.com" autoComplete="off" />
          </label>

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
      {recurringTemplateId !== null && (
        <FloatingWindow
          title={`${recurringTemplate ? "Edit" : "Create"} Recurring Template`}
          onClose={() => setRecurringTemplateId(null)}
        >
          <form
            className="master-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveRecurringTemplate(new FormData(e.currentTarget));
            }}
          >
            <label>
              Label
              <input name="label" defaultValue={recurringTemplate?.label} placeholder="e.g. Rent, Netflix, Car EMI" required autoFocus />
            </label>
            <label>
              Frequency
              <select name="frequency" defaultValue={recurringTemplate?.frequency || "monthly"}>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label>
              Usually due on (day of month, optional)
              <input name="dayOfMonth" type="number" min={1} max={31} defaultValue={recurringTemplate?.dayOfMonth} />
            </label>
            <label>
              Voucher type
              <select name="voucherType" defaultValue={recurringTemplate?.voucherType || "Payment"}>
                {["Payment", "Receipt", "Journal", "Contra"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              Narration ({"{month}"}/{"{year}"} are filled in when posted)
              <input name="narrationTemplate" defaultValue={recurringTemplate?.narrationTemplate} placeholder="e.g. {month} rent" />
            </label>
            <label>
              Debit account
              <select name="debitAccountId" defaultValue={recurringTemplate?.entries.find((e) => e.amount < 0)?.accountId || ""}>
                <option value="" disabled>
                  Select ledger
                </option>
                {data.accounts.filter((a) => a.active !== false).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Credit account
              <select name="creditAccountId" defaultValue={recurringTemplate?.entries.find((e) => e.amount > 0)?.accountId || ""}>
                <option value="" disabled>
                  Select ledger
                </option>
                {data.accounts.filter((a) => a.active !== false).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={Math.abs(recurringTemplate?.entries.find((e) => e.amount < 0)?.amount ?? 0) || undefined}
                required
              />
            </label>
            <label className="check-label">
              <input name="active" type="checkbox" defaultChecked={recurringTemplate?.active !== false} /> Active
            </label>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0" }}>
              Optional: auto-detect this template in Plaid Import when a matching bank transaction arrives. Leave blank to only post it manually.
            </p>
            <label>
              Plaid institution pattern (optional)
              <input name="institutionPattern" defaultValue={recurringTemplate?.plaidMatch?.institutionPattern} placeholder="e.g. Bank of America" />
            </label>
            <label>
              Plaid amount tolerance ($)
              <input name="amountTolerance" type="number" step="0.01" min="0" defaultValue={recurringTemplate?.plaidMatch?.amountTolerance ?? 5} />
            </label>
            <div>
              <button type="button" onClick={() => setRecurringTemplateId(null)}>
                Cancel
              </button>
              <button className="primary">Save template</button>
            </div>
          </form>
        </FloatingWindow>
      )}
    </div>
  );
}
