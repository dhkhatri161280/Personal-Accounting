"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FloatingWindow } from "@/components/FloatingWindow";
import { accountFormSchema, type AccountFormValues } from "@/lib/account-form-schema";
import type { RecurringTemplate, PayrollDirectDepositSplit, AuditEntry, FixedAsset, Ledger, VaultDocument, CostcoReceipt } from "@/lib/vault-types";
import { mergeCostcoReceipts, parseCostcoReceiptsUpload } from "@/lib/costco-receipts";
import { getAccessToken, apiFetch } from "@/lib/api-fetch";
import { trimPdfToFit } from "@/lib/trim-pdf";
import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/document-limits";
import { appendAuditEntry, diffFields, summarize } from "@/lib/audit";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { frequencyLabel, lastPaidDate } from "@/lib/recurring";
import { detectRecurringCandidates, templateFromCandidate, diagnoseLedger, type RecurringCandidate, type DiagnosticEntry } from "@/lib/recurring-detect";
import {
  monthlyDepreciation,
  accumulatedDepreciation,
  bookValue,
  guessAssetClass,
  assetClassFromTag,
  ACCUMULATED_DEPRECIATION_ACCOUNT_NAME,
  ASSET_CLASS_SUGGESTIONS,
  UNCLASSIFIED_LABEL,
  ASSET_CLASS_PREFIXES,
  defaultUsefulLifeForClass,
  suggestNextAssetTag,
} from "@/lib/fixed-assets";
import { getOrCreateAssetAccount, findLegacyCostMismatches, repairLegacyAssetCosts, tagExistingAsset } from "@/lib/fixed-assets-ledger";
import { accountNature, isProfitAndLossAccountName } from "@/lib/vault-accounting";
import { AssetTagPicker } from "@/components/AssetTagPicker";
import { useUiPrefs } from "@/hooks/useUiPrefs";

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
  address?: string;
  email?: string;
  bankAccountNumber?: string;
  bankIfscOrRouting?: string;
  bankSwiftCode?: string;
  bankBranch?: string;
  bankCity?: string;
  bankState?: string;
  bankPostalCode?: string;
  bankCountry?: string;
  fbarTreatment?: "include" | "exclude" | "manual";
  fbarManualValuesInr?: Record<string, number>;
};
export type MasterLedger = {
  company?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  costcoMembershipRenewalMonthDay?: string;
  costcoActualReward?: { amount: number; asOfDate: string };
  currency: string;
  accounts: MasterAccount[];
  groups?: MasterGroup[];
  currencies?: string[];
  voucherTypes?: string[];
  fiscalYearStartMonth?: number;
  closedPeriods?: string[];
  transactions?: Array<{
    date: string;
    deleted?: boolean;
    cancelled?: boolean;
    entries: Array<{ accountId: number; amount: number }>;
    // Present on the real Ledger this is always structurally assigned from (see VaultApp.tsx's
    // <MastersPanel data={data} ... /> -- `data` there is a full Ledger, this type is just this
    // panel's own narrower view of it) -- widened here so the recurring-bill detector (which
    // needs them) doesn't have to cast.
    narration?: string;
    type?: string;
    guid?: string;
  }>;
  recurringTemplates?: RecurringTemplate[];
  dismissedRecurringCandidates?: string[];
  payrollDirectDeposit?: PayrollDirectDepositSplit[];
  auditLog?: AuditEntry[];
  fixedAssets?: FixedAsset[];
  documents?: VaultDocument[];
  costcoReceipts?: CostcoReceipt[];
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
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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

  // Guards every path that CLOSES a period (never reopening) against closing a period that
  // hasn't happened yet -- confirmed live: closing "March 2027" back in October 2026 (7 months
  // early) silently auto-posted that fiscal year's closing voucher (buildFiscalYearCloseVoucher,
  // triggered from VaultApp.tsx's onSave watching for a newly-closed "-03" period) well before
  // the year actually ended, corrupting the Dashboard's Capital Closing card (its "current year
  // result" figure zeroes out once the app believes the year is already closed) until someone
  // noticed and reversed it. Nothing else in the period-close path checks today's real date.
  const currentMonth = todayLocalIso().slice(0, 7);
  function confirmFutureClose(periods: string[]): boolean {
    const future = periods.filter((p) => p > currentMonth);
    if (!future.length) return true;
    const label = future.length === 1 ? monthLabel(future[0]) : `${future.length} periods (${future.map(monthLabel).join(", ")})`;
    return window.confirm(
      `${label} ${future.length === 1 ? "hasn't" : "haven't"} happened yet -- today is ${monthLabel(currentMonth)}. Closing a future period (especially a fiscal year's March) auto-posts that year's closing voucher early, which throws off the Dashboard and reports until it's undone. Close anyway?`
    );
  }

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
    if (!isClosed && !confirmFutureClose([period])) return;
    const next = isClosed ? closedPeriods.filter((p) => p !== period) : [...closedPeriods, period];
    onToggle(
      next,
      isClosed
        ? `${monthLabel(period)} reopened.`
        : `${monthLabel(period)} closed — vouchers dated in this period can no longer be created, edited, or deleted.`
    );
  }

  function setBatch(periods: string[], close: boolean, message: string) {
    if (close && !confirmFutureClose(periods)) return;
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
      address: account?.address || "",
      email: account?.email || "",
      bankAccountNumber: account?.bankAccountNumber || "",
      bankIfscOrRouting: account?.bankIfscOrRouting || "",
      bankSwiftCode: account?.bankSwiftCode || "",
      bankBranch: account?.bankBranch || "",
      bankCity: account?.bankCity || "",
      bankState: account?.bankState || "",
      bankPostalCode: account?.bankPostalCode || "",
      bankCountry: account?.bankCountry || "",
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
          <input {...register("opening", { valueAsNumber: true })} type="number" step="0.01" min="0" className="master-amount-input" />
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
      {/* Optional -- lets the Balance Confirmation Letter pull this ledger's address straight
         from Masters instead of retyping it per letter; a per-letter edit there doesn't write
         back here. Not required for ledgers that don't need one (e.g. internal/expense accounts).
         Street line only -- City/State/Postal/Country are their own fields below (not parsed out
         of this one) since FinCEN Form 114 Part II needs them as separate boxes. */}
      <label>
        Address / street (optional)
        <textarea rows={2} {...register("address")} placeholder="Street address" />
      </label>
      <div className="opening-fields">
        <label>
          City (optional)
          <input {...register("bankCity")} />
        </label>
        <label>
          State / region (optional)
          <input {...register("bankState")} />
        </label>
      </div>
      <div className="opening-fields">
        <label>
          Postal code (optional)
          <input {...register("bankPostalCode")} />
        </label>
        <label>
          Country (optional)
          <input {...register("bankCountry")} placeholder="Defaults to India on the FBAR export" />
        </label>
      </div>
      <label>
        Email (optional)
        <input {...register("email")} type="email" placeholder="name@example.com" />
        {errors.email && <span className="field-error">{errors.email.message}</span>}
      </label>
      {/* Bank/card reference details -- not required for every ledger, but the actual fields
         FinCEN Form 114 Part III asks for per foreign account (Financial Institution name via the
         ledger name itself, Account Number, Mailing Address via the field above), plus IFSC/
         routing and SWIFT for everyday banking reference. Shown for every account (not just
         Bank-nature ones) rather than hidden behind the group picker, so it's never missing just
         because an account was filed under an unexpected group. */}
      <label>
        Account number (optional)
        <input {...register("bankAccountNumber")} placeholder="Last 4 digits, or full number" />
      </label>
      <label>
        IFSC / Routing number (optional)
        <input {...register("bankIfscOrRouting")} placeholder="e.g. SBIN0001234 or a US routing number" />
      </label>
      <label>
        SWIFT / BIC code (optional)
        <input {...register("bankSwiftCode")} placeholder="e.g. SBININBB123" />
      </label>
      <label>
        Branch (optional)
        <input {...register("bankBranch")} placeholder="Branch name/location" />
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
  book,
  onSave,
  initialSection,
  onTagAsset,
  privacyMode: privacyModeProp,
}: {
  data: MasterLedger;
  // Needed only for the Documents section's R2 upload/view/delete calls (book-scoped key
  // prefix, same as voucher attachments) -- every other section works off `data` alone.
  book: "us" | "india";
  // May optionally return the underlying save's success/failure -- the global header toast
  // already shows a status message on every save, but it's a small fixed-position pill in the
  // top-right corner that's easy to miss on a long form (confirmed: a user scrolled down to the
  // bottom of a long Settings form never saw it). The Settings form below awaits this to show its
  // own inline, impossible-to-miss confirmation/error right next to the button they just clicked,
  // without changing the toast itself (used the same way by every other Masters section here).
  onSave: (next: MasterLedger, message: string) => void | Promise<boolean>;
  // Lets a caller deep-link straight into a sub-tab (e.g. the Dashboard's period-open badge
  // jumping to Periods) instead of always landing on Ledgers -- read once on mount, since
  // MastersPanel itself unmounts/remounts whenever the user navigates away from and back to
  // the Masters tab (see the `tab === "masters" &&` conditional render in VaultApp.tsx).
  initialSection?: "ledgers" | "groups" | "periods" | "recurring" | "directdeposit" | "fixedassets" | "documents" | "costcoreceipts" | "settings";
  // Applies a Fixed Asset # to every voucher already posted on an untagged asset's own ledger --
  // routed through a dedicated prop (not the generic onSave above) because it needs to exempt
  // those (possibly closed-period) vouchers from the closed-period check, the same way
  // FixedAssetRegister's "Tag all vouchers" action does. See bulkTagAsset in VaultApp.tsx.
  onTagAsset?: (asset: FixedAsset, tag: string) => Promise<void> | void;
  // Optional -- when the caller already holds privacyMode (VaultApp does, for its header toggle
  // and root .privacy-mode CSS class), pass it here instead of letting this component fall back
  // to its own useUiPrefs() call below. Each useUiPrefs() call keeps fully independent state
  // (see hooks/useUiPrefs.ts), synced from localStorage only at mount -- toggling Privacy from
  // the header while already on Masters > Documents wouldn't otherwise be seen here until the
  // next remount (MastersPanel is only forced to remount when `mastersSection` itself changes,
  // via VaultApp's `key={mastersSection}`, not when privacyMode changes). Falls back to the
  // local hook so a standalone render (e.g. a QA route) still works without this prop.
  privacyMode?: boolean;
}) {
  const [section, setSection] = useState<"ledgers" | "groups" | "periods" | "recurring" | "directdeposit" | "fixedassets" | "documents" | "costcoreceipts" | "settings">(initialSection ?? "ledgers"),
    // Inline confirmation/error for the Settings form's own Save button -- see that form's
    // onSubmit and onSave's doc comment above for why this exists alongside the global toast.
    [settingsSaveState, setSettingsSaveState] = useState<"saving" | "saved" | "error" | null>(null),
    [accountId, setAccountId] = useState<number | null>(null),
    [groupName, setGroupName] = useState<string | null>(null),
    [recurringTemplateId, setRecurringTemplateId] = useState<string | null>(null),
    [recurringCandidates, setRecurringCandidates] = useState<RecurringCandidate[] | null>(null),
    [selectedCandidateKeys, setSelectedCandidateKeys] = useState<Set<string>>(new Set()),
    [showDismissedCandidates, setShowDismissedCandidates] = useState(false),
    [diagnoseQuery, setDiagnoseQuery] = useState(""),
    [diagnosticResults, setDiagnosticResults] = useState<DiagnosticEntry[] | null>(null),
    [directDepositId, setDirectDepositId] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    // Fixed Assets master data (name/class/useful life/salvage) -- Cost/Fixed Asset #/purchase
    // date stay read-only here since they're derived facts from the real ledger/tag, not
    // hand-typed master fields; see components/reports/FixedAssetRegister.tsx for the report
    // view (Dispose/Run Depreciation/drill-down) this data feeds.
    [showAddAsset, setShowAddAsset] = useState(false),
    [showAssetInfo, setShowAssetInfo] = useState(false),
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
    [editingAssetInServiceId, setEditingAssetInServiceId] = useState<string | null>(null),
    [editingAssetInServiceValue, setEditingAssetInServiceValue] = useState(""),
    [deletingAssetId, setDeletingAssetId] = useState<string | null>(null),
    [taggingAssetId, setTaggingAssetId] = useState<string | null>(null),
    [taggingValue, setTaggingValue] = useState(""),
    [tagging, setTagging] = useState(false),
    [showBalanceInfo, setShowBalanceInfo] = useState(false),
    // Documents master data (pay stubs, RSU grant agreements, offer letters, ...) -- see
    // VaultDocument in lib/vault-types.ts. File bytes go straight to R2; only this small form
    // state and the resulting metadata ever touch this component's state/the vault blob.
    [showAddDocument, setShowAddDocument] = useState(false),
    [documentSearch, setDocumentSearch] = useState(""),
    [docCategory, setDocCategory] = useState<VaultDocument["category"]>("Pay Stub"),
    [docLabel, setDocLabel] = useState(""),
    [docDate, setDocDate] = useState(""),
    [uploadingDocument, setUploadingDocument] = useState(false),
    [documentUploadError, setDocumentUploadError] = useState(""),
    [editingDocumentId, setEditingDocumentId] = useState<string | null>(null),
    [editingDocumentLabel, setEditingDocumentLabel] = useState(""),
    [editingDocumentCategory, setEditingDocumentCategory] = useState<VaultDocument["category"]>("Pay Stub"),
    [editingDocumentDate, setEditingDocumentDate] = useState(""),
    [uploadingCostcoReceipts, setUploadingCostcoReceipts] = useState(false),
    [costcoReceiptsError, setCostcoReceiptsError] = useState("");
  const { privacyMode: privacyModeLocal } = useUiPrefs();
  const privacyMode = privacyModeProp ?? privacyModeLocal;

  // Documents holds real PII (pay stubs, offer letters, grant agreements) -- unlike every other
  // Masters tab, blurring dollar figures isn't enough to protect it, so it's fully inaccessible
  // in Privacy mode: the tab button below is hidden, and if a stale deep link (command palette,
  // "View Documents" from a report) lands here while privacy is already on, bounce back to
  // Ledger Accounts rather than briefly rendering the file list.
  useEffect(() => {
    if (privacyMode && section === "documents") setSection("ledgers");
  }, [privacyMode, section]);

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

  // Current/Closing column: Balance Sheet ledgers (Asset/Liability/Capital/Bank/Cash/Investment,
  // and "Profit & Loss A/c" itself) show the real life-to-date closing balance (opening + every
  // posted entry to date) -- they carry forward, so anything less than the full history would be
  // wrong. Income/Expense ledgers are nominal accounts that reset to zero at the start of each
  // fiscal year in Tally-style books (they roll into Profit & Loss / Capital, not their own
  // balance) -- showing their life-to-date total would double-count prior years' activity, so
  // only the CURRENT fiscal year's movement counts, with no opening balance carried in. Same
  // nature classification and nominal-ledger rule already used for VaultApp's own Balance Sheet
  // (isNominalLedgerRow) and ReconReport, applied here so Masters agrees with those reports.
  const masterGroups = useMemo(
    () => new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g])),
    [data.groups]
  );
  const currentFyStart = useMemo(() => {
    const currentFY = fys[0];
    if (currentFY == null) return null;
    return `${currentFY}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`;
  }, [fys, fiscalYearStartMonth]);
  const closingBalances = useMemo(() => {
    const today = todayLocalIso();
    const map = new Map<number, number>(); // raw signed value: negative = Dr, positive = Cr (same convention as openingBalance)
    for (const a of data.accounts) {
      const nature = accountNature(a, masterGroups);
      const isNominal = !isProfitAndLossAccountName(a.name) && (nature === "Income" || nature === "Expense");
      let raw = isNominal ? 0 : a.openingBalance || 0;
      for (const t of data.transactions || []) {
        if (t.deleted || t.cancelled) continue;
        if (t.date > today) continue;
        if (isNominal && currentFyStart && t.date < currentFyStart) continue;
        for (const e of t.entries) if (e.accountId === a.id) raw += e.amount;
      }
      map.set(a.id, raw);
    }
    return map;
  }, [data.accounts, data.transactions, masterGroups, currentFyStart]);
  const saveAccount = (values: AccountFormValues) => {
    const name = normalize(values.name),
      parent = values.parent,
      currency = values.currency,
      amount = Math.abs(values.opening),
      side = values.side,
      active = values.active,
      address = values.address?.trim() || undefined,
      email = values.email?.trim() || undefined,
      bankAccountNumber = values.bankAccountNumber?.trim() || undefined,
      bankIfscOrRouting = values.bankIfscOrRouting?.trim() || undefined,
      bankSwiftCode = values.bankSwiftCode?.trim() || undefined,
      bankBranch = values.bankBranch?.trim() || undefined,
      bankCity = values.bankCity?.trim() || undefined,
      bankState = values.bankState?.trim() || undefined,
      bankPostalCode = values.bankPostalCode?.trim() || undefined,
      bankCountry = values.bankCountry?.trim() || undefined;
    const existing = data.accounts.find((a) => a.id === accountId),
      account: MasterAccount = {
        id: existing?.id || Math.max(0, ...data.accounts.map((a) => a.id)) + 1,
        name,
        parent,
        category: groups.find((g) => g.name === parent)?.nature || "Asset",
        currency,
        openingBalance: side === "Dr" ? -amount : amount,
        active,
        address,
        email,
        bankAccountNumber,
        bankIfscOrRouting,
        bankSwiftCode,
        bankBranch,
        bankCity,
        bankState,
        bankPostalCode,
        bankCountry,
        masterSyncStatus: "pending",
        masterOriginalName: existing?.masterOriginalName || existing?.name,
        tallyGuid: existing?.tallyGuid,
        masterFingerprint: "app-change-" + Date.now(),
        // This form never edits FBAR treatment -- preserve whatever was already set via the FBAR
        // Worksheet (components/reports/FbarReport.tsx), or it would silently vanish the next
        // time this account's name/currency/etc. gets edited here.
        fbarTreatment: existing?.fbarTreatment,
        fbarManualValuesInr: existing?.fbarManualValuesInr,
      };
    // `active` defaults to undefined on legacy accounts but the form always writes an explicit
    // boolean -- normalize both sides to the app's own "active !== false" convention first, or
    // every edit of a never-toggled account would show a spurious "active changed" diff.
    const changes = existing
      ? diffFields(
          { ...existing, active: existing.active !== false },
          { ...account, active: account.active !== false },
          ["name", "parent", "currency", "openingBalance", "active", "address", "email"]
        )
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
  //
  // If a tag is typed in THIS SAME form and the name matched an already-existing ledger (one with
  // real prior vouchers, e.g. created outside this flow), route it through tagExistingAsset just
  // like the standalone "🏷 Tag" action below -- otherwise this silently left cost at $0 and never
  // tagged the ledger's actual entries at all, so a pre-existing asset (especially one already
  // disposed by hand before ever being registered) never showed up in the Register.
  function addAsset() {
    const name = assetName.trim();
    if (!name) return;
    const cls = assetClassInput.trim() || guessAssetClass(name) || UNCLASSIFIED_LABEL;
    const tag = assetTagInput.trim();
    const today = todayLocalIso();
    const { data: withAcct, account } = getOrCreateAssetAccount(assetLedger, name, 0, today);
    const shell: FixedAsset = {
      id: crypto.randomUUID(),
      name,
      accountId: account.id,
      assetClass: cls,
      purchaseDate: today,
      cost: 0,
      salvageValue: 0,
      usefulLifeMonths: defaultUsefulLifeForClass(cls),
    };
    const withShell = { ...withAcct, fixedAssets: [...(withAcct.fixedAssets ?? []), shell] };
    const next = (tag ? tagExistingAsset(withShell as unknown as Ledger, shell, tag) : withShell) as unknown as MasterLedger;
    const asset = (next.fixedAssets ?? []).find((a) => a.id === shell.id) ?? shell;
    onSave(next, `Fixed asset ${asset.name} added${tag ? ` (${tag})` : ""}.`);
    setShowAddAsset(false);
    setAssetName("");
    setAssetClassInput("");
    setAssetTagInput("");
  }

  function openTagAsset(a: FixedAsset) {
    // Already-tagged asset (e.g. one line tagged by hand already) -- reuse that SAME tag so
    // "Apply" extends it to this ledger's remaining untagged lines, instead of suggesting a
    // brand-new one (only right for adopting a genuinely untagged asset into tagging for the
    // first time).
    if (a.sourceTag) {
      setTaggingValue(a.sourceTag);
      setTaggingAssetId(a.id);
      return;
    }
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
    // The tag's own prefix (e.g. "ELE-003") already declares its class -- same precedence as
    // createTaggedAsset/tagExistingAsset use when a tag is first applied -- so it's tried ahead
    // of guessing from the asset's own name, which only catches specific keywords (e.g. "TV",
    // "refrigerator") and misses a generic name like "Other Misc Item" or "Kitchen Appliance".
    const updated = fixedAssetsList.map((a) =>
      a.assetClass ? a : { ...a, assetClass: (a.sourceTag && assetClassFromTag(a.sourceTag)) || guessAssetClass(a.name) || a.assetClass }
    );
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

  // In Service Date: when depreciation should actually start accruing, separate from Purchase
  // Date (which for a tagged asset always re-derives as the earliest tagged transaction's date --
  // e.g. an earnest-money deposit -- and would silently revert any direct edit on the next
  // re-sync). Blank clears the override back to "same as Purchase Date".
  function saveAssetInServiceDate(assetId: string) {
    const value = editingAssetInServiceValue.trim();
    const updated = fixedAssetsList.map((a) =>
      a.id === assetId ? { ...a, inServiceDate: value || undefined } : a
    );
    onSave({ ...data, fixedAssets: updated }, value ? "In Service Date updated." : "In Service Date cleared.");
    setEditingAssetInServiceId(null);
  }

  function deleteAsset(assetId: string) {
    const updated = fixedAssetsList.filter((a) => a.id !== assetId);
    onSave({ ...data, fixedAssets: updated }, "Fixed asset deleted.");
    setDeletingAssetId(null);
  }

  const saveRecurringTemplate = (form: FormData) => {
    const label = normalize(String(form.get("label") || "")),
      frequency = String(form.get("frequency") || "monthly") as RecurringTemplate["frequency"],
      intervalMonths = frequency === "custom" ? Math.max(1, Number(form.get("intervalMonths") || 1)) : undefined,
      anchorMonth = frequency === "monthly"
        ? undefined
        : normalize(String(form.get("anchorMonth") || "")) || undefined,
      dayOfMonth = form.get("dayOfMonth") ? Number(form.get("dayOfMonth")) : undefined,
      voucherType = String(form.get("voucherType") || "Payment"),
      narrationTemplate = normalize(String(form.get("narrationTemplate") || `{month} ${label}`)),
      active = form.get("active") === "on",
      debitAccountId = Number(form.get("debitAccountId")),
      creditAccountId = Number(form.get("creditAccountId")),
      amount = Math.abs(Number(form.get("amount") || 0)),
      institutionPattern = normalize(String(form.get("institutionPattern") || "")),
      // Clamped to the expected amount itself -- a tolerance wider than that would match
      // transactions near $0 (or even negative-vs-expected-sign mismatches), which is never a
      // legitimate "same recurring bill, slightly different amount" case. This is the one auto
      // Plaid-match rule with no merchant-text check at all (a user-configured institution
      // pattern + amount is trusted outright, same as payroll), so an unreasonably loose
      // tolerance is the one way it could misfire -- this bounds that without requiring the user
      // to add a merchant pattern of their own.
      amountTolerance = Math.min(Number(form.get("amountTolerance") || 5), amount);
    if (!label || !debitAccountId || !creditAccountId || !amount) return;
    const existing = (data.recurringTemplates || []).find((t) => t.id === recurringTemplateId);
    const template: RecurringTemplate = {
      id: existing?.id || crypto.randomUUID(),
      label,
      active,
      frequency,
      intervalMonths,
      anchorMonth,
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
  // "Scan for recurring bills" -- scans the last 60 months of the Day Book for a regularly
  // repeating 2-leg voucher pattern (see lib/recurring-detect.ts) and proposes it as a template,
  // instead of the user having to remember and hand-type every bill. Nothing is created until the
  // user reviews and confirms -- a coincidental repeat (two unrelated similar-amount charges)
  // could otherwise get proposed as a bogus "recurring" bill with no human check.
  const scanForRecurringBills = () => {
    const candidates = detectRecurringCandidates(
      data.transactions || [],
      data.accounts,
      data.recurringTemplates || [],
      new Set(data.dismissedRecurringCandidates || []),
      60,
      todayLocalIso()
    );
    setRecurringCandidates(candidates);
    setSelectedCandidateKeys(new Set());
  };
  // Persists the dismissal (not just a local filter) so a future scan doesn't keep re-proposing
  // the same pattern the user already said isn't a real recurring bill -- e.g. a one-off pair of
  // similar-amount charges that happened to land on a plausible-looking interval.
  const dismissCandidates = (candidates: RecurringCandidate[]) => {
    if (!candidates.length) return;
    const keys = candidates.map((c) => c.key);
    onSave(
      { ...data, dismissedRecurringCandidates: [...new Set([...(data.dismissedRecurringCandidates || []), ...keys])] },
      candidates.length === 1 ? `Dismissed "${candidates[0].suggestedLabel}" — won't suggest it again.` : `Dismissed ${candidates.length} suggestions.`
    );
    const dismissedSet = new Set(keys);
    setRecurringCandidates((prev) => (prev ? prev.filter((c) => !dismissedSet.has(c.key)) : prev));
    setSelectedCandidateKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  };
  // Shows what's currently dismissed, with a Restore action -- dismissing was previously a
  // one-way, invisible action (no way to see or undo it), which is risky: a wrong click (or a
  // broad "Dismiss selected" with the wrong rows checked) would silently and permanently suppress
  // a real bill from ever being suggested again, with no way to tell it had even happened. Re-runs
  // the detector with an EMPTY dismissed set (so dismissed candidates aren't excluded) and filters
  // down to just the ones actually on the dismissed list, since that list only stores opaque keys,
  // not labels.
  const dismissedCandidates = showDismissedCandidates
    ? detectRecurringCandidates(data.transactions || [], data.accounts, data.recurringTemplates || [], new Set(), 60, todayLocalIso()).filter(
        (c) => (data.dismissedRecurringCandidates || []).includes(c.key)
      )
    : [];
  const restoreCandidate = (key: string, label: string) => {
    onSave(
      { ...data, dismissedRecurringCandidates: (data.dismissedRecurringCandidates || []).filter((k) => k !== key) },
      `Restored "${label}" — it'll be suggested again next scan.`
    );
  };
  // Answers "why isn't X showing up as a recurring bill" directly, since there's no way to
  // inspect the live encrypted vault from outside the app -- traces the exact same logic the
  // scan uses, but explains every group's verdict instead of silently dropping the ones that
  // don't qualify.
  const runDiagnosis = () => {
    setDiagnosticResults(
      diagnoseLedger(
        data.transactions || [],
        data.accounts,
        data.recurringTemplates || [],
        new Set(data.dismissedRecurringCandidates || []),
        60,
        todayLocalIso(),
        diagnoseQuery
      )
    );
  };
  // Direct Deposit -- editable replacement for the hardcoded split constants that used to live
  // in PlaidImport.tsx's payroll composer (lib/payroll-direct-deposit.ts now reads this instead),
  // modeled on the employer payroll portal's own account/amount/status table.
  const directDepositSplit = (data.payrollDirectDeposit || []).find((s) => s.id === directDepositId);
  const saveDirectDepositSplit = (form: FormData) => {
    const accountId = Number(form.get("accountId") || 0),
      amountType = String(form.get("amountType") || "fixed") as PayrollDirectDepositSplit["amountType"],
      amount = amountType === "fixed" ? Math.abs(Number(form.get("amount") || 0)) : undefined,
      active = form.get("active") === "on";
    if (!accountId || (amountType === "fixed" && !amount)) return;
    const existing = (data.payrollDirectDeposit || []).find((s) => s.id === directDepositId);
    const split: PayrollDirectDepositSplit = { id: existing?.id || crypto.randomUUID(), accountId, amountType, amount, active };
    const others = (data.payrollDirectDeposit || []).filter((s) => s.id !== split.id);
    onSave({ ...data, payrollDirectDeposit: [...others, split] }, `${existing ? "Updated" : "Added"} direct deposit split.`);
    setDirectDepositId(null);
  };
  const deleteDirectDepositSplit = (s: PayrollDirectDepositSplit) => {
    const name = data.accounts.find((a) => a.id === s.accountId)?.name || "this account";
    if (!confirm(`Remove the direct deposit split to ${name}?`)) return;
    onSave(
      { ...data, payrollDirectDeposit: (data.payrollDirectDeposit || []).filter((x) => x.id !== s.id) },
      "Direct deposit split removed."
    );
  };
  // Reads receipts.json (produced by tools/costco-receipts/parse.mjs) client-side -- no R2
  // attachment involved, unlike uploadDocuments above, since this is small structured JSON meant
  // to live inline in the encrypted vault blob (like payrollDirectDeposit) rather than a binary
  // file. mergeCostcoReceipts dedupes against whatever's already on file by each receipt's own
  // key, so re-importing the same file (or a newer capture that re-covers older receipts) is safe.
  async function importCostcoReceipts(file: File) {
    setUploadingCostcoReceipts(true);
    setCostcoReceiptsError("");
    try {
      const text = await file.text();
      const parsed = parseCostcoReceiptsUpload(JSON.parse(text));
      const merged = mergeCostcoReceipts((data.costcoReceipts || []) as CostcoReceipt[], parsed);
      const added = merged.length - (data.costcoReceipts || []).length;
      onSave(
        { ...data, costcoReceipts: merged },
        `Imported ${parsed.length} receipt(s) -- ${added} new, ${parsed.length - added} already on file.`
      );
    } catch (err) {
      setCostcoReceiptsError(err instanceof Error ? err.message : "Couldn't read that file -- is it a valid receipts.json?");
    } finally {
      setUploadingCostcoReceipts(false);
    }
  }
  const deleteCostcoReceipt = (r: CostcoReceipt) => {
    if (!confirm(`Remove this receipt (${r.date}, ${r.warehouse}, $${r.total.toFixed(2)})?`)) return;
    onSave(
      { ...data, costcoReceipts: (data.costcoReceipts || []).filter((x) => x.key !== r.key) },
      "Receipt removed."
    );
  };
  const toggleCandidateSelected = (key: string) => {
    setSelectedCandidateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const createTemplatesFromCandidates = (candidates: RecurringCandidate[]) => {
    if (!candidates.length) return;
    const today = todayLocalIso();
    const newTemplates = candidates.map((c) => templateFromCandidate(c, today));
    onSave(
      { ...data, recurringTemplates: [...(data.recurringTemplates || []), ...newTemplates] },
      candidates.length === 1
        ? `Created recurring template ${candidates[0].suggestedLabel}.`
        : `Created ${candidates.length} recurring templates.`
    );
    const createdKeys = new Set(candidates.map((c) => c.key));
    setRecurringCandidates((prev) => (prev ? prev.filter((c) => !createdKeys.has(c.key)) : prev));
    setSelectedCandidateKeys((prev) => {
      const next = new Set(prev);
      for (const k of createdKeys) next.delete(k);
      return next;
    });
  };
  const documentsList = data.documents ?? [];
  const documentSearchQuery = documentSearch.trim().toLowerCase();
  const filteredDocumentsList = documentSearchQuery
    ? documentsList.filter((d) =>
        [d.label, d.category, d.filename].some((field) => field.toLowerCase().includes(documentSearchQuery))
      )
    : documentsList;

  // Uploads to R2 first (book-scoped `documents` folder, not a voucher's txGuid -- see
  // app/api/attachments/route.ts), then saves just the small VaultDocument metadata into the
  // vault, same split as voucher Attachments. Accepts a whole file selection at once (e.g. all
  // 13 pay stub/grant PDFs in one picker) so a batch doesn't need one round-trip per file.
  // The typed Label only makes sense for a SINGLE file -- with several selected at once, each
  // document is labeled from its own filename instead (Category/Date still apply to all of them,
  // since a whole batch is usually the same kind of document from the same source).
  async function uploadDocuments(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploadingDocument(true);
    setDocumentUploadError("");
    try {
      const newDocs: VaultDocument[] = [];
      const errors: string[] = [];
      const notes: string[] = [];
      // Reject anything obviously over the server's own MAX_SIZE (app/api/attachments/route.ts)
      // BEFORE spending a round-trip on it -- a large scanned PDF (a multi-page grant/offer
      // letter, say) can also get rejected even lower down, by Cloudflare's own edge, before our
      // handler ever runs; that comes back as a bare 413 with no body to explain it. Either way,
      // the actionable advice is the same, so both cases share one clear message instead of a
      // cryptic status code.
      const tooLarge = (size: number) => size > DOCUMENT_MAX_SIZE_BYTES;
      const oversizedMsg = (file: File) =>
        `${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)}MB, limit ~${DOCUMENT_MAX_SIZE_BYTES / 1024 / 1024}MB) -- try compressing it or trimming it to fewer pages, then upload again.`;
      for (let file of list) {
        if (tooLarge(file.size)) {
          // A large PDF (a multi-year stock plan doc with a scanned prospectus appendix, say)
          // almost always has the part that actually matters in its first few pages -- trim it
          // to fit automatically, client-side, instead of making the user do this by hand
          // outside the app every time (see lib/trim-pdf.ts). Only attempted for real PDFs; any
          // other oversized file type, or a PDF that still doesn't fit even at 1 page, falls
          // back to the same clear manual-fix message as before.
          const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
          const trimmed = isPdf ? await trimPdfToFit(file, DOCUMENT_MAX_SIZE_BYTES) : null;
          if (!trimmed) {
            errors.push(oversizedMsg(file));
            continue;
          }
          notes.push(
            `${file.name} was automatically trimmed from ${trimmed.originalPages} to ${trimmed.keptPages} page(s) to fit the ${DOCUMENT_MAX_SIZE_BYTES / 1024 / 1024}MB limit.`
          );
          file = trimmed.file;
        }
        const form = new FormData();
        form.append("file", file);
        form.append("book", book);
        form.append("folder", "documents");
        const r = await apiFetch("/api/attachments", { method: "POST", body: form });
        if (!r.ok) {
          errors.push(r.status === 413 ? oversizedMsg(file) : `${file.name} (${r.status})`);
          continue;
        }
        const meta = (await r.json()) as { key: string; filename: string; size: number; contentType: string; uploadedAt: string };
        newDocs.push({
          id: crypto.randomUUID(),
          category: docCategory,
          label: list.length === 1 ? docLabel.trim() || meta.filename : meta.filename.replace(/\.[^.]+$/, ""),
          date: docDate || undefined,
          ...meta,
        });
      }
      // Trim notes surface even when nothing ended up saved (e.g. the trim succeeded but the
      // upload itself then failed for an unrelated reason) -- never silently dropped.
      if (errors.length || (notes.length && !newDocs.length)) setDocumentUploadError([...errors, ...(newDocs.length ? [] : notes)].join(" "));
      if (newDocs.length) {
        const addedMsg = newDocs.length === 1 ? `Document "${newDocs[0].label}" added.` : `${newDocs.length} documents added.`;
        onSave({ ...data, documents: [...documentsList, ...newDocs] }, [addedMsg, ...notes].join(" "));
        setShowAddDocument(false);
        setDocLabel("");
        setDocDate("");
        setDocCategory("Pay Stub");
      }
    } finally {
      setUploadingDocument(false);
    }
  }

  async function deleteDocument(doc: VaultDocument) {
    if (!confirm(`Delete "${doc.label}"? This removes the file permanently.`)) return;
    try {
      await apiFetch(`/api/attachments?key=${encodeURIComponent(doc.key)}`, { method: "DELETE" });
    } catch {
      // Fall through and remove the reference anyway -- an orphaned R2 object is harmless.
    }
    onSave({ ...data, documents: documentsList.filter((d) => d.id !== doc.id) }, `Document "${doc.label}" deleted.`);
  }

  function saveDocumentEdits(doc: VaultDocument) {
    const next: VaultDocument = {
      ...doc,
      label: editingDocumentLabel.trim() || doc.label,
      category: editingDocumentCategory,
      date: editingDocumentDate || undefined,
    };
    onSave(
      { ...data, documents: documentsList.map((d) => (d.id === doc.id ? next : d)) },
      `Document "${next.label}" updated.`
    );
    setEditingDocumentId(null);
  }

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
          className={section === "directdeposit" ? "selected" : ""}
          onClick={() => setSection("directdeposit")}
        >
          Direct Deposit
        </button>
        <button
          className={section === "fixedassets" ? "selected" : ""}
          onClick={() => setSection("fixedassets")}
        >
          Fixed Assets
        </button>
        {!privacyMode && (
          <button
            className={section === "documents" ? "selected" : ""}
            onClick={() => setSection("documents")}
          >
            Documents
          </button>
        )}
        <button
          className={section === "costcoreceipts" ? "selected" : ""}
          onClick={() => setSection("costcoreceipts")}
        >
          Costco Receipts
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
                <th>
                  Current / Closing
                  <span
                    className="info-icon-wrap"
                    onMouseEnter={() => setShowBalanceInfo(true)}
                    onMouseLeave={() => setShowBalanceInfo(false)}
                  >
                    <button
                      type="button"
                      className="info-icon-btn"
                      aria-label="How this balance is computed"
                      onClick={() => setShowBalanceInfo((v) => !v)}
                    >
                      ⓘ
                    </button>
                    {showBalanceInfo && (
                      <div className="info-icon-popover">
                        Balance Sheet ledgers (assets, liabilities, capital, bank, cash, investments) show the real
                        closing balance -- opening plus every posted entry to date. Income and Expense ledgers reset
                        to zero each fiscal year in Tally-style books, so theirs shows only the current fiscal
                        year's movement, not life-to-date, matching the Balance Sheet's own rule.
                      </div>
                    )}
                  </span>
                </th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const bal = closingBalances.get(a.id) ?? 0;
                return (
                <tr key={a.id} className={a.masterDeletePending ? "master-deleting" : ""}>
                  <td>{a.name}</td>
                  <td>{a.parent}</td>
                  <td>{a.currency}</td>
                  <td className="right">
                    {Math.abs(a.openingBalance).toFixed(2)} {a.openingBalance <= 0 ? "Dr" : "Cr"}
                  </td>
                  <td className="right">
                    {Math.abs(bal).toFixed(2)} {bal <= 0 ? "Dr" : "Cr"}
                  </td>
                  <td>
                    {a.masterSyncStatus === "pending" ? (
                      <span className="master-status pending">
                        {a.masterDeletePending ? "Pending delete" : "Pending"}
                      </span>
                    ) : a.active === false ? (
                      <span className="master-status inactive">Inactive</span>
                    ) : (
                      <span className="master-status synced">Synced</span>
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
                );
              })}
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
                    ) : g.active === false ? (
                      <span className="master-status inactive">Inactive</span>
                    ) : (
                      <span className="master-status synced">Synced</span>
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
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button onClick={scanForRecurringBills}>Scan for recurring bills</button>
              {(data.dismissedRecurringCandidates || []).length > 0 && (
                <button onClick={() => setShowDismissedCandidates((v) => !v)}>
                  {showDismissedCandidates ? "Hide" : "Show"} dismissed ({(data.dismissedRecurringCandidates || []).length})
                </button>
              )}
              <button className="primary" onClick={() => setRecurringTemplateId("")}>
                + New Recurring Template
              </button>
            </div>
          </div>
          <div className="master-toolbar">
            <input
              placeholder='Diagnose a ledger — e.g. "Electric & Gas"'
              value={diagnoseQuery}
              onChange={(e) => setDiagnoseQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runDiagnosis()}
              style={{ flex: 1, maxWidth: 360 }}
            />
            <button onClick={runDiagnosis} disabled={!diagnoseQuery.trim()}>
              Diagnose
            </button>
          </div>
          {diagnosticResults && (
            <div className="data-panel" style={{ marginBottom: 16 }}>
              <strong style={{ fontSize: 13 }}>
                Why "{diagnoseQuery}" {diagnosticResults.length === 0 ? "found nothing" : "did or didn't surface"}:
              </strong>
              {diagnosticResults.length === 0 ? (
                <p style={{ fontSize: 13, opacity: 0.7, margin: "0.5rem 0 0" }}>
                  No ledger name contains "{diagnoseQuery}", or no 2-leg transaction through it exists in the last 60
                  months.
                </p>
              ) : (
                <table style={{ marginTop: "0.5rem" }}>
                  <thead>
                    <tr>
                      <th>Ledgers</th>
                      <th>Occurrences</th>
                      <th>Avg gap</th>
                      <th>Verdict</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnosticResults.map((d, i) => (
                      <tr key={i}>
                        <td>{d.debitAccountName && d.creditAccountName ? `${d.debitAccountName} / ${d.creditAccountName}` : "—"}</td>
                        <td>
                          {d.occurrences.length > 0
                            ? d.occurrences.map((o) => fmtDate(o.date)).join(", ")
                            : "—"}
                        </td>
                        <td>{d.avgGapDays != null ? `${d.avgGapDays.toFixed(1)}d (±${d.maxGapDeviation?.toFixed(1)})` : "—"}</td>
                        <td style={{ fontWeight: 600, color: d.verdict === "accepted" ? "#16a34a" : "#dc2626" }}>{d.verdict}</td>
                        <td style={{ fontSize: 12, opacity: 0.8 }}>{d.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {showDismissedCandidates && (
            <div className="data-panel" style={{ marginBottom: 16 }}>
              <strong style={{ fontSize: 13 }}>Dismissed suggestions — won't be re-proposed by a scan unless restored:</strong>
              {dismissedCandidates.length === 0 ? (
                <p style={{ fontSize: 13, opacity: 0.7, margin: "0.5rem 0 0" }}>
                  Nothing dismissed currently matches a detectable pattern (it may no longer repeat regularly, or the
                  underlying ledger changed).
                </p>
              ) : (
                <table style={{ marginTop: "0.5rem" }}>
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Ledgers</th>
                      <th>Seen</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dismissedCandidates.map((c) => (
                      <tr key={c.key}>
                        <td>{c.suggestedLabel}</td>
                        <td>
                          {c.debitAccountName} / {c.creditAccountName}
                        </td>
                        <td>
                          {c.occurrences.length}&times;, last {fmtDate(c.occurrences[c.occurrences.length - 1].date)}
                        </td>
                        <td>
                          <button className="master-edit" onClick={() => restoreCandidate(c.key, c.suggestedLabel)}>
                            Restore
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {recurringCandidates && (
            <div className="data-panel" style={{ marginBottom: 16 }}>
              {recurringCandidates.length === 0 ? (
                <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
                  No new recurring patterns found in the last 60 months — either everything regular is
                  already templated, or nothing in the Day Book repeats on a consistent interval yet.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 0.5rem" }}>
                    These are reminders only, not a posting rule — the real voucher still comes from wherever it
                    actually gets paid (Tally sync, Plaid, manual entry). "Create" just sets up the due-date check;
                    amount can vary cycle to cycle without affecting it.
                  </p>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <strong style={{ fontSize: 13 }}>
                      {recurringCandidates.length} possible recurring bill(s) found — review, create the real ones, dismiss the rest:
                    </strong>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        disabled={selectedCandidateKeys.size === 0}
                        onClick={() => dismissCandidates(recurringCandidates.filter((c) => selectedCandidateKeys.has(c.key)))}
                      >
                        Dismiss {selectedCandidateKeys.size || ""} selected
                      </button>
                      <button
                        className="primary"
                        disabled={selectedCandidateKeys.size === 0}
                        onClick={() => createTemplatesFromCandidates(recurringCandidates.filter((c) => selectedCandidateKeys.has(c.key)))}
                      >
                        Create {selectedCandidateKeys.size || ""} selected
                      </button>
                    </div>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={selectedCandidateKeys.size === recurringCandidates.length}
                            onChange={(e) =>
                              setSelectedCandidateKeys(e.target.checked ? new Set(recurringCandidates.map((c) => c.key)) : new Set())
                            }
                          />
                        </th>
                        <th>Label</th>
                        <th>Interval</th>
                        <th>Amount</th>
                        <th>Ledgers</th>
                        <th>Seen</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recurringCandidates.map((c) => (
                        <tr key={c.key}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedCandidateKeys.has(c.key)}
                              onChange={() => toggleCandidateSelected(c.key)}
                            />
                          </td>
                          <td>{c.suggestedLabel}</td>
                          <td>
                            {c.suggestedFrequency === "custom"
                              ? `Every ${c.suggestedIntervalMonths} month(s)`
                              : frequencyLabel({ frequency: c.suggestedFrequency } as RecurringTemplate)}
                          </td>
                          <td className="right">{c.avgAmount.toFixed(2)}</td>
                          <td>
                            {c.debitAccountName} / {c.creditAccountName}
                          </td>
                          <td>
                            {c.occurrences.length}&times;, last {fmtDate(c.occurrences[c.occurrences.length - 1].date)}
                          </td>
                          <td>
                            <div className="master-actions">
                              <button className="master-edit" onClick={() => createTemplatesFromCandidates([c])}>
                                Create
                              </button>
                              <button className="master-delete" onClick={() => dismissCandidates([c])}>
                                Dismiss
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Frequency</th>
                <th>Amount</th>
                <th>Plaid Match</th>
                <th>Status</th>
                <th>Last Paid</th>
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
                    <td>{frequencyLabel(t)}</td>
                    <td className="right">{Math.abs(t.entries.find((e) => e.amount < 0)?.amount ?? 0).toFixed(2)}</td>
                    <td>{t.plaidMatch ? t.plaidMatch.institutionPattern : "Manual only"}</td>
                    <td>
                      <span className={`master-status ${t.active ? "synced" : "pending"}`}>
                        {t.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>{(() => {
                      const paid = lastPaidDate(t, data.transactions || []);
                      return paid ? fmtDate(paid) : "—";
                    })()}</td>
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
      {section === "directdeposit" && (() => {
        const splits = data.payrollDirectDeposit || [];
        const activeRemainderCount = splits.filter((s) => s.active && s.amountType === "remainder").length;
        const bankAccounts = [...data.accounts]
          .filter((a) => a.active !== false && (a.category === "Bank" || a.category === "Cash"))
          .sort((a, b) => a.name.localeCompare(b.name));
        return (
          <>
            <div className="master-toolbar">
              <span>{splits.length} direct deposit split(s)</span>
              <button className="primary" onClick={() => setDirectDepositId("")}>
                + New Split
              </button>
            </div>
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 0.75rem" }}>
              How a paycheck's net deposit splits across bank accounts — mirrors your employer payroll
              portal's own setup. Each active "Fixed $" split is taken off the top; whatever's left goes
              to the one account marked "Remainder". Archive (uncheck Active) an account here the same
              way your portal archives it — nothing historical is affected, only future paychecks.
            </p>
            {activeRemainderCount > 1 && (
              <p style={{ fontSize: 12, color: "#b45309", margin: "0 0 0.75rem" }}>
                ⚠ {activeRemainderCount} active splits are marked "Remainder" — only the first one (by
                creation order) actually receives the leftover amount. Fix this so there's exactly one.
              </p>
            )}
            {splits.length === 0 ? (
              <p style={{ opacity: 0.7 }}>
                No direct deposit splits configured yet — new paychecks deposit in full to whichever
                account the Plaid transaction's own institution matches.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {splits.map((s) => {
                    const acct = data.accounts.find((a) => a.id === s.accountId);
                    return (
                      <tr key={s.id}>
                        <td>{acct?.name || `(deleted account ${s.accountId})`}</td>
                        <td className="right">{s.amountType === "remainder" ? "Remainder" : `$${(s.amount ?? 0).toFixed(2)}`}</td>
                        <td>
                          <span className={`master-status ${s.active ? "synced" : "pending"}`}>
                            {s.active ? "Active" : "Archived"}
                          </span>
                        </td>
                        <td>
                          <div className="master-actions">
                            <button className="master-edit" onClick={() => setDirectDepositId(s.id)}>
                              Edit
                            </button>
                            <button className="master-delete" onClick={() => deleteDirectDepositSplit(s)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {directDepositId !== null && (
              <FloatingWindow
                title={`${directDepositSplit ? "Edit" : "Add"} Direct Deposit Split`}
                onClose={() => setDirectDepositId(null)}
              >
                <form
                  className="master-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveDirectDepositSplit(new FormData(e.currentTarget));
                  }}
                >
                  <label>
                    Account
                    <select name="accountId" defaultValue={directDepositSplit?.accountId || ""} required>
                      <option value="" disabled>
                        Select bank/cash ledger
                      </option>
                      {bankAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Amount type
                    <select name="amountType" defaultValue={directDepositSplit?.amountType || "fixed"}>
                      <option value="fixed">Fixed $ amount</option>
                      <option value="remainder">Remainder (whatever's left)</option>
                    </select>
                  </label>
                  <label>
                    Amount (only used for Fixed $)
                    <input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      className="master-amount-input"
                      defaultValue={directDepositSplit?.amount || undefined}
                    />
                  </label>
                  <label className="check-label">
                    <input name="active" type="checkbox" defaultChecked={directDepositSplit?.active !== false} /> Active
                  </label>
                  <div>
                    <button type="button" onClick={() => setDirectDepositId(null)}>
                      Cancel
                    </button>
                    <button className="primary">Save split</button>
                  </div>
                </form>
              </FloatingWindow>
            )}
          </>
        );
      })()}
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
          <div className="master-toolbar">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="tr-refresh-btn" onClick={() => setShowAddAsset((v) => !v)}>
                {showAddAsset ? "Cancel" : "+ Add Asset"}
              </button>
              <span
                className="info-icon-wrap"
                onMouseEnter={() => setShowAssetInfo(true)}
                onMouseLeave={() => setShowAssetInfo(false)}
              >
                <button
                  type="button"
                  className="info-icon-btn"
                  aria-label="About this Fixed Assets master data"
                  onClick={() => setShowAssetInfo((v) => !v)}
                >
                  ⓘ
                </button>
                {showAssetInfo && (
                  <div className="info-icon-popover">
                    Name, Group/Class, Useful Life, and Salvage are editable master data. Cost is read-only here — it&apos;s a
                    derived fact of the real ledger balance, not something to hand-type. An untagged asset can be given a
                    Fixed Asset # here (🏷 Tag) — applies it to every voucher already posted on its own ledger, existing or
                    new. See Reports → Registers → Fixed Asset Register for depreciation, disposal, and drill-down.
                  </div>
                )}
              </span>
            </span>
            {unclassifiedAssetCount > 0 && (
              <button type="button" className="tr-refresh-btn" onClick={autoClassifyAssets}>
                🪄 Auto-classify {unclassifiedAssetCount}
              </button>
            )}
            {legacyCostMismatches.length > 0 && (
              <button
                type="button"
                onClick={repairAssetCosts}
                title={
                  privacyMode
                    ? `Fix ${legacyCostMismatches.length} incorrect ledger total(s)`
                    : `Fix ${legacyCostMismatches.length} incorrect ledger total(s): ${legacyCostMismatches
                        .map((m) => `${m.name} ${m.currentCost.toFixed(2)} → ${m.correctCost.toFixed(2)}`)
                        .join("; ")}`
                }
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
                  <th>In Service Date</th>
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
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <span>{a.sourceTag}</span>
                          {/* Only offered while this ledger still has an untagged sibling entry
                              to sweep up -- once everything's tagged this naturally disappears
                              instead of sitting on every fully-tagged asset as permanent clutter,
                              and reappears on its own if a new untagged voucher lands later. */}
                          {onTagAsset &&
                            assetLedger.transactions.some(
                              (t) => !t.deleted && !t.cancelled && t.entries.some((e) => e.accountId === a.accountId && !e.assetTag)
                            ) && (
                            <button
                              type="button"
                              className="master-edit"
                              title="Apply this same Fixed Asset # to every OTHER voucher on this ledger that isn't tagged yet"
                              onClick={() => openTagAsset(a)}
                            >
                              🏷 Tag remaining
                            </button>
                          )}
                        </div>
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
                    <td>
                      {editingAssetInServiceId === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input
                            autoFocus
                            type="date"
                            value={editingAssetInServiceValue}
                            onChange={(e) => setEditingAssetInServiceValue(e.target.value)}
                            style={{ width: 140 }}
                          />
                          <button className="master-edit" onClick={() => saveAssetInServiceDate(a.id)}>
                            Save
                          </button>
                          <button className="master-delete" onClick={() => setEditingAssetInServiceId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="ledger-link"
                          title={a.inServiceDate ? "Depreciation start override -- click to change or clear" : "Depreciation starts from Purchase Date -- click to override"}
                          onClick={() => {
                            setEditingAssetInServiceId(a.id);
                            setEditingAssetInServiceValue(a.inServiceDate || "");
                          }}
                        >
                          {a.inServiceDate ? fmtDate(a.inServiceDate) : fmtDate(a.purchaseDate)}
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
                            className="master-salvage-input"
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
                    {editingAssetLifeId !== a.id && <td className="right">{a.salvageValue}</td>}
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
      {section === "documents" && !privacyMode && (
        <>
          <div className="master-toolbar">
            <input
              value={documentSearch}
              onChange={(e) => setDocumentSearch(e.target.value)}
              placeholder="Search documents (label, category, filename)"
              style={{ width: 280 }}
            />
            <button type="button" className="tr-refresh-btn" onClick={() => setShowAddDocument((v) => !v)}>
              {showAddDocument ? "Cancel" : "+ Add Document"}
            </button>
          </div>
          {showAddDocument && (
            <div className="report-line" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <select value={docCategory} onChange={(e) => setDocCategory(e.target.value as VaultDocument["category"])}>
                <option value="Pay Stub">Pay Stub</option>
                <option value="Grant Agreement">Grant Agreement</option>
                <option value="Grant Award">Grant Award</option>
                <option value="Offer Letter">Offer Letter</option>
                <option value="Other">Other</option>
              </select>
              <input
                placeholder="Label (e.g. FY26 Focal Grant) -- only used for a single file"
                value={docLabel}
                onChange={(e) => setDocLabel(e.target.value)}
                style={{ width: 260 }}
              />
              <input type="date" title="Date this document is about (optional)" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
              <label className="tr-refresh-btn" style={{ display: "inline-block", cursor: "pointer" }}>
                {uploadingDocument ? "Uploading…" : "Choose file(s)…"}
                <input
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  disabled={uploadingDocument}
                  onChange={(e) => {
                    // Copy into a real array BEFORE clearing e.target.value below -- e.target.files
                    // is a LIVE FileList tied to the input's own selection state, and resetting
                    // value="" empties that same live list too (confirmed live: silently 0 files,
                    // no error, no request -- the upload never even started). The old single-file
                    // version read e.target.files?.[0] (a File, immune to this) instead of holding
                    // the FileList itself, which is why only the multi-file version broke.
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length) uploadDocuments(files);
                  }}
                />
              </label>
            </div>
          )}
          {showAddDocument && (
            <p className="field-hint" style={{ margin: "0 0 10px" }}>
              Selecting several files at once uploads them all under the same Category/Date, each labeled from its own filename.
              Each file must be under {DOCUMENT_MAX_SIZE_BYTES / 1024 / 1024}MB -- an oversized PDF is automatically trimmed to
              its first few pages to fit; other oversized files need manual compressing first.
            </p>
          )}
          {documentUploadError && <p className="equity-pdf-error">{documentUploadError}</p>}
          {documentsList.length === 0 ? (
            <p style={{ opacity: 0.7 }}>No documents yet. Add a pay stub, grant agreement, or offer letter above.</p>
          ) : filteredDocumentsList.length === 0 ? (
            <p style={{ opacity: 0.7 }}>No documents match &quot;{documentSearch}&quot;.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Category</th>
                  <th>Date</th>
                  <th className="right">Size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredDocumentsList
                  .slice()
                  .sort((a, b) => (b.date || b.uploadedAt).localeCompare(a.date || a.uploadedAt))
                  .map((d) =>
                    editingDocumentId === d.id ? (
                      <tr key={d.id}>
                        <td>
                          <input autoFocus value={editingDocumentLabel} onChange={(e) => setEditingDocumentLabel(e.target.value)} style={{ width: 180 }} />
                        </td>
                        <td>
                          <select value={editingDocumentCategory} onChange={(e) => setEditingDocumentCategory(e.target.value as VaultDocument["category"])}>
                            <option value="Pay Stub">Pay Stub</option>
                            <option value="Grant Agreement">Grant Agreement</option>
                            <option value="Grant Award">Grant Award</option>
                            <option value="Offer Letter">Offer Letter</option>
                            <option value="Other">Other</option>
                          </select>
                        </td>
                        <td>
                          <input type="date" value={editingDocumentDate} onChange={(e) => setEditingDocumentDate(e.target.value)} />
                        </td>
                        <td className="right">{(d.size / 1024).toFixed(0)} KB</td>
                        <td>
                          <button className="master-edit" onClick={() => saveDocumentEdits(d)}>
                            Save
                          </button>
                          <button className="master-delete" onClick={() => setEditingDocumentId(null)}>
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={d.id}>
                        <td>
                          <a
                            href={`/api/attachments?key=${encodeURIComponent(d.key)}&token=${encodeURIComponent(getAccessToken() || "")}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {d.label}
                          </a>
                        </td>
                        <td>{d.category}</td>
                        <td>{d.date ? fmtDate(d.date) : "—"}</td>
                        <td className="right">{(d.size / 1024).toFixed(0)} KB</td>
                        <td>
                          <button
                            className="master-edit"
                            onClick={() => {
                              setEditingDocumentId(d.id);
                              setEditingDocumentLabel(d.label);
                              setEditingDocumentCategory(d.category);
                              setEditingDocumentDate(d.date || "");
                            }}
                          >
                            Edit
                          </button>
                          <button className="master-delete" onClick={() => deleteDocument(d)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  )}
              </tbody>
            </table>
          )}
        </>
      )}
      {section === "costcoreceipts" && (() => {
        const receipts = [...(data.costcoReceipts || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
        const cardholders = [...new Set(receipts.map((r) => r.cardholder).filter(Boolean))].sort();
        return (
          <>
            <div className="master-toolbar">
              <span>
                {receipts.length} receipt{receipts.length === 1 ? "" : "s"} imported
                {cardholders.length ? ` — ${cardholders.join(", ")}` : ""}
              </span>
              <label className="tr-refresh-btn" style={{ display: "inline-block", cursor: "pointer" }}>
                {uploadingCostcoReceipts ? "Importing…" : "Import receipts.json…"}
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  disabled={uploadingCostcoReceipts}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) importCostcoReceipts(file);
                  }}
                />
              </label>
            </div>
            <p className="field-hint" style={{ margin: "0 0 0.75rem" }}>
              Real itemized Costco receipts, captured straight from Costco&apos;s own order-history API (see{" "}
              <code>tools/costco-receipts/</code> in the repo) -- not guessed from Day Book narration. This is
              the one source for both the Costco Executive 2% Reward calculation and the Price Match
              Watchlist on the Spend Report. Re-importing the same file is safe -- receipts are deduped by
              their own warehouse/register/transaction number.
            </p>
            {costcoReceiptsError && <p className="equity-pdf-error">{costcoReceiptsError}</p>}
            {receipts.length === 0 ? (
              <p style={{ opacity: 0.7 }}>
                No receipts imported yet. Run the capture tool at <code>tools/costco-receipts/</code>, then
                import the <code>.captures/receipts.json</code> it produces.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Cardholder</th>
                    <th>Warehouse</th>
                    <th>Type</th>
                    <th className="right">Total</th>
                    <th className="right">Items</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.key}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.cardholder || "—"}</td>
                      <td>{r.warehouse || "—"}</td>
                      <td>{r.receiptType || "—"}</td>
                      <td className="right">${r.total.toFixed(2)}</td>
                      <td className="right">{r.items.length}</td>
                      <td>
                        <button className="master-delete" onClick={() => deleteCostcoReceipt(r)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        );
      })()}
      {section === "settings" && (
        <form
          className="master-form settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSettingsSaveState("saving");
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
              companyEmail = String(f.get("companyEmail") || "").trim(),
              costcoMonth = String(f.get("costcoMembershipMonth") || "").trim(),
              costcoDay = String(f.get("costcoMembershipDay") || "").trim(),
              costcoActualRewardAmount = String(f.get("costcoActualRewardAmount") || "").trim(),
              costcoActualRewardDate = String(f.get("costcoActualRewardDate") || "").trim();
            const result = onSave(
              {
                ...data,
                currencies,
                voucherTypes,
                fiscalYearStartMonth,
                ...(company ? { company } : {}),
                companyAddress,
                companyPhone,
                companyEmail,
                costcoMembershipRenewalMonthDay: costcoMonth && costcoDay ? `${costcoMonth}-${costcoDay}` : undefined,
                costcoActualReward:
                  costcoActualRewardAmount && costcoActualRewardDate
                    ? { amount: Math.abs(Number(costcoActualRewardAmount)), asOfDate: costcoActualRewardDate }
                    : undefined,
              },
              "Other masters updated."
            );
            // The real save (components/VaultApp.tsx) is async and can genuinely fail (network,
            // stale-vault 412, expired session 428) -- awaiting it (when the caller returns a
            // promise) lets this show an accurate inline result instead of always claiming
            // success the instant the button is clicked.
            const ok = result instanceof Promise ? await result : true;
            setSettingsSaveState(ok ? "saved" : "error");
            setTimeout(() => setSettingsSaveState((s) => (s === "saved" ? null : s)), 4000);
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
          <label>
            Costco Executive Membership renewal (month/day)
            <span style={{ display: "flex", gap: 6 }}>
              <select name="costcoMembershipMonth" defaultValue={data.costcoMembershipRenewalMonthDay?.slice(0, 2) || ""}>
                <option value="">Month</option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={String(i + 1).padStart(2, "0")}>{name}</option>
                ))}
              </select>
              <select name="costcoMembershipDay" defaultValue={data.costcoMembershipRenewalMonthDay?.slice(3, 5) || ""}>
                <option value="">Day</option>
                {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => (
                  <option key={d} value={d}>{Number(d)}</option>
                ))}
              </select>
            </span>
            <span className="field-hint">
              Powers the Costco Executive 2% Reward estimate on the Spend report. Costco calculates that reward on a
              window ending ~3 months before this date each year, not the membership year itself. No year needed --
              under normal renewal this stays the same every year, so it's set once, not updated annually.
            </span>
          </label>
          <label>
            Actual 2% Reward (per Costco)
            <span style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                step="0.01"
                name="costcoActualRewardAmount"
                placeholder="73.29"
                defaultValue={data.costcoActualReward?.amount ?? ""}
                style={{ width: 100 }}
              />
              <input type="date" name="costcoActualRewardDate" defaultValue={data.costcoActualReward?.asOfDate || ""} max={todayLocalIso()} />
            </span>
            <span className="field-hint">
              Costco's own real number, straight from your account page (costco.com → Account → Membership
              Information shows "Estimated 2% Reward" directly) -- just type in whatever it says there. Shown
              as a reference next to the app's own estimate on Spend Report, never computed or overwritten by
              anything here.
            </span>
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
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="primary" disabled={settingsSaveState === "saving"}>
              {settingsSaveState === "saving" ? "Saving…" : "Save settings"}
            </button>
            {settingsSaveState === "saved" && (
              <span style={{ fontWeight: 600, color: "#166534" }}>✓ Saved</span>
            )}
            {settingsSaveState === "error" && (
              <span style={{ fontWeight: 600, color: "#991b1b" }}>Save failed -- see the message at the top of the page for details.</span>
            )}
          </span>
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
          {(() => {
          // Newly auto-provisioned accounts (e.g. a fresh fiscal year's House Hold Exps months)
          // land at the END of data.accounts, not next to their sibling months -- an unsorted
          // dropdown buries them far past where the user expects to find them. Sort once here,
          // same localeCompare convention already used for the other account pickers in this file.
          const sortedActiveAccounts = [...data.accounts].filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name));
          return (
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
                <option value="bimonthly">Every 2 months</option>
                <option value="quarterly">Quarterly</option>
                <option value="custom">Custom interval (months)</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label>
              Custom interval, in months (only for "Custom interval" above)
              <input name="intervalMonths" type="number" min={1} max={24} defaultValue={recurringTemplate?.intervalMonths ?? 4} />
            </label>
            <label>
              Anchor month, YYYY-MM (not used for Monthly) — for Yearly, the month it's actually due (e.g. December);
              for every-2-months/quarterly/custom, any month the bill was actually due, so the cycle lines up correctly
              <input name="anchorMonth" type="month" defaultValue={recurringTemplate?.anchorMonth} />
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
                {sortedActiveAccounts.map((a) => (
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
                {sortedActiveAccounts.map((a) => (
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
                className="master-amount-input"
                defaultValue={Math.abs(recurringTemplate?.entries.find((e) => e.amount < 0)?.amount ?? 0) || undefined}
                required
              />
            </label>
            <label className="check-label">
              <input name="active" type="checkbox" defaultChecked={recurringTemplate?.active !== false} /> Active
            </label>
            <details style={{ fontSize: 12, margin: "0.5rem 0" }}>
              <summary style={{ cursor: "pointer", listStyle: "none", color: "#6f7d92", fontWeight: 600 }}>ⓘ About the fields below</summary>
              <p style={{ opacity: 0.7, margin: "6px 0 0" }}>
                Optional: auto-detect this template in Plaid Import when a matching bank transaction arrives. Leave blank to only post it manually.
              </p>
            </details>
            <label>
              Plaid institution pattern (optional)
              <input name="institutionPattern" defaultValue={recurringTemplate?.plaidMatch?.institutionPattern} placeholder="e.g. Bank of America" />
            </label>
            <label>
              Plaid amount tolerance ($)
              <input name="amountTolerance" type="number" step="0.01" min="0" className="master-amount-input" defaultValue={recurringTemplate?.plaidMatch?.amountTolerance ?? 5} />
            </label>
            <div>
              <button type="button" onClick={() => setRecurringTemplateId(null)}>
                Cancel
              </button>
              <button className="primary">Save template</button>
            </div>
          </form>
          );
          })()}
        </FloatingWindow>
      )}
    </div>
  );
}
