import type { Account, Ledger, Tx, VoucherLineDraft } from "@/lib/vault-types";

export const blankVoucherLines = (): VoucherLineDraft[] => [
  { id: crypto.randomUUID(), side: "debit", accountId: "", amount: "" },
  { id: crypto.randomUUID(), side: "credit", accountId: "", amount: "" },
];

export const draftLinesFromTx = (tx: Tx | null): VoucherLineDraft[] =>
  tx?.entries?.length
    ? tx.entries.map((e) => ({
        id: crypto.randomUUID(),
        side: e.amount < 0 ? ("debit" as const) : ("credit" as const),
        accountId: String(e.accountId),
        amount: String(Math.abs(e.amount)),
      }))
    : blankVoucherLines();

export const centsOf = (value: number | string): number => Math.round(Number(value || 0) * 100);

// Returns `count` unique, unused transaction ids (existing max + 1, 2, 3, ...).
// Never use `data.transactions.length + 1` inside a batch .map() — every item in the
// batch reads the same length and ends up with the identical id, silently creating
// two rows that both display as e.g. "#9352" (they collide again on the very next save
// too, since `length` didn't grow). Always call this once per batch, not per row.
export const nextTransactionIds = (transactions: Tx[], count: number): number[] => {
  const base = Math.max(0, ...transactions.map((t) => Number(t.id) || 0));
  return Array.from({ length: count }, (_, i) => base + 1 + i);
};

export const fiscalYearOf = (date: string): number => {
  const y = Number(date.slice(0, 4)),
    m = Number(date.slice(5, 7));
  return m >= 4 ? y : y - 1;
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Fiscal year `fy` runs Apr `fy` through Mar `fy + 1` (see fiscalYearOf above). Returns the
// 12 "House Hold Exps - Mon YY" account names for that FY, in calendar order.
export const houseHoldAccountNamesForFiscalYear = (fy: number): string[] =>
  Array.from({ length: 12 }, (_, i) => {
    const calMonth = 4 + i; // 4..15 → Apr..Mar
    const calYear = calMonth > 12 ? fy + 1 : fy;
    const mm = calMonth > 12 ? calMonth - 12 : calMonth;
    return `House Hold Exps - ${MONTH_ABBR[mm - 1]} ${String(calYear).slice(-2)}`;
  });

// Auto-provisions a fiscal year's monthly House Hold Exps accounts -- this is how "create
// next FY's accounts when I actually start the new year, without asking me" is satisfied
// without a separate manual step or a scheduled job. Two call sites feed `extraFiscalYears`:
//   1. openVault(), passing fiscalYearOf(today) -- so the accounts exist BEFORE the user ever
//      opens the voucher form, since a voucher can't select an account that doesn't exist yet
//      (an account created only off an already-saved voucher's own date is one save too late).
//   2. save(), with no extra years -- a cheap safety net that also backfills any FY implied by
//      transaction dates alone (e.g. a backdated/imported voucher into a FY that predates
//      "today", which openVault's today-based check alone wouldn't catch).
// Idempotent (only appends names that don't already exist) and additive-only (never edits or
// removes an existing account). Copies parent/category/currency from an existing House Hold
// Exps account as the template; if that family doesn't exist at all yet, there's nothing to
// model new accounts on, so it no-ops. Returns the SAME ledger reference when nothing needs
// to be added.
export const ensureHouseHoldAccountsForFiscalYears = (ledger: Ledger, extraFiscalYears: number[] = []): Ledger => {
  const template = ledger.accounts.find((a) => /^house hold exps/i.test(a.name));
  if (!template) return ledger;

  const existingNames = new Set(ledger.accounts.map((a) => a.name.toLowerCase()));
  const fiscalYears = new Set<number>(extraFiscalYears);
  for (const t of ledger.transactions) {
    if (t.deleted) continue;
    fiscalYears.add(fiscalYearOf(t.date));
  }

  const missing: string[] = [];
  for (const fy of fiscalYears) {
    for (const name of houseHoldAccountNamesForFiscalYear(fy)) {
      if (!existingNames.has(name.toLowerCase())) missing.push(name);
    }
  }
  if (!missing.length) return ledger;

  let nextId = Math.max(0, ...ledger.accounts.map((a) => a.id)) + 1;
  const newAccounts: Account[] = missing.map((name) => ({
    id: nextId++,
    name,
    parent: template.parent,
    category: template.category,
    currency: template.currency,
    openingBalance: 0,
    active: true,
    masterSyncStatus: "pending",
    masterFingerprint: "app-change-" + Date.now(),
  }));
  return { ...ledger, accounts: [...ledger.accounts, ...newAccounts] };
};

// The "Profit & Loss A/c" ledger is never posted to directly for its own balance -- Tally (and
// this app's reports) compute it live as the current fiscal year's net Income - Expense. It IS,
// however, one leg of the year-end closing voucher below. Matches the identical pattern already
// used in components/reports/ReconReport.tsx (kept separate there to avoid touching working
// recon code in this change).
export const isProfitAndLossAccountName = (name: string): boolean =>
  /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(name);

// Authoritative nature classifier -- mirrors natureFor() in VaultApp.tsx and natureForRecon()
// in ReconReport.tsx exactly. The account's own `category` field can go stale (set once at
// master-sync link time); the group name (`parent`) plus any user-configured MasterGroup
// override is the live source of truth everywhere else in this app.
export function accountNature(a: { parent: string }, masterGroups: Map<string, { nature: string }>): string {
  const group = (a.parent || "").toLowerCase(), configured = masterGroups.get(group);
  if (group.includes("(asset)")) return "Asset";
  if (configured) return configured.nature;
  if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
  if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
  if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
  if (/^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(group)) return "Liability";
  if (group === "bank accounts") return "Bank";
  if (group === "cash-in-hand") return "Cash";
  if (group === "investments") return "Investment";
  return "Asset";
}

export type FiscalYearCloseResult =
  | { status: "created"; tx: Tx }
  | { status: "no-op" } // already closed, or zero net P&L for the year -- nothing to post
  | { status: "error"; message: string };

// Builds (but does not save) the year-end closing voucher for fiscal year `fy` (Apr `fy` -
// Mar `fy + 1`): a Journal dated the FY's last day, Dr the Capital account / Cr "Profit & Loss
// A/c" for a surplus (or the reverse for a deficit) -- mirrors exactly how the user's own Tally
// book posts this (confirmed against a real example: Dr "Dignesh Khatri" / Cr "Profit & Loss
// A/c", $132,389.75, for FY2025's surplus). Refuses to guess when the two ledgers aren't
// unambiguous (returns an "error" result instead of posting against the wrong account), and is
// idempotent -- if a matching voucher already exists for this FY (e.g. entered manually in
// Tally and already synced in), or the year's net P&L is zero, it's a no-op.
export function buildFiscalYearCloseVoucher(ledger: Ledger, fy: number): FiscalYearCloseResult {
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;

  const masterGroups = new Map((ledger.groups || []).map((g) => [g.name.toLowerCase(), g]));
  const nature = (a: Account) => accountNature(a, masterGroups);
  const activeAccounts = ledger.accounts.filter((a) => a.active !== false);

  const plAccounts = activeAccounts.filter((a) => isProfitAndLossAccountName(a.name));
  const capitalAccounts = activeAccounts.filter((a) => nature(a) === "Capital" && !isProfitAndLossAccountName(a.name));
  if (plAccounts.length !== 1) {
    return { status: "error", message: `expected exactly 1 active "Profit & Loss A/c" ledger, found ${plAccounts.length}` };
  }
  if (capitalAccounts.length !== 1) {
    return { status: "error", message: `expected exactly 1 active Capital account (excluding Profit & Loss A/c), found ${capitalAccounts.length}` };
  }
  const plAccount = plAccounts[0], capitalAccount = capitalAccounts[0];

  const alreadyClosed = ledger.transactions.some(
    (t) =>
      !t.deleted &&
      !t.cancelled &&
      t.date === fyEnd &&
      t.type.toLowerCase() === "journal" &&
      t.entries.some((e) => e.accountId === plAccount.id) &&
      t.entries.some((e) => e.accountId === capitalAccount.id)
  );
  if (alreadyClosed) return { status: "no-op" };

  const nominalIds = new Set(
    activeAccounts
      .filter((a) => ["Income", "Expense"].includes(nature(a)) && !isProfitAndLossAccountName(a.name))
      .map((a) => a.id)
  );
  let netPL = 0;
  for (const t of ledger.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < fyStart || t.date > fyEnd) continue;
    for (const e of t.entries) if (nominalIds.has(e.accountId)) netPL += e.amount;
  }
  if (centsOf(netPL) === 0) return { status: "no-op" };

  const tx: Tx = {
    id: nextTransactionIds(ledger.transactions, 1)[0],
    guid: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    syncStatus: "pending",
    date: fyEnd,
    number: nextVoucherNumber(ledger, "Journal", fyEnd),
    type: "Journal",
    narration: "",
    historical: false,
    entries: [
      { accountId: plAccount.id, accountName: plAccount.name, amount: netPL },
      { accountId: capitalAccount.id, accountName: capitalAccount.name, amount: -netPL },
    ],
  };
  return { status: "created", tx };
}

export const nextVoucherNumber = (
  data: Ledger,
  type: string,
  date: string,
  excludeGuid?: string
): string => {
  const fy = fiscalYearOf(date),
    wanted = type.toLowerCase();
  // Count vouchers of same type+FY dated on or before the target date — new voucher slots in after them.
  const preceding = data.transactions.filter(
    (t) =>
      !t.deleted &&
      !t.cancelled &&
      t.guid !== excludeGuid &&
      t.type.toLowerCase() === wanted &&
      fiscalYearOf(t.date) === fy &&
      t.date <= date
  );
  return String(preceding.length + 1);
};

// Resequence all voucher numbers to match Tally's rule: ascending date order within each type+FY.
// Mutates data.transactions in place; returns true if any number changed.
export function recomputeVoucherNumbers(data: Ledger): boolean {
  let changed = false;
  const byGroup = new Map<string, Tx[]>();
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    const group = `${t.type.toLowerCase()}|${fiscalYearOf(t.date)}`;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(t);
  }
  for (const [group, txList] of byGroup.entries()) {
    // Primary: date asc. Tie-breaker: existing number asc (preserves relative order for same-date). Secondary: id asc.
    txList.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (Number(a.number) || 0) - (Number(b.number) || 0) ||
        a.id - b.id
    );
    const before = txList.slice(-3).map((t) => `${t.date}:#${t.number}`).join(", ");
    txList.forEach((t, i) => {
      const n = String(i + 1);
      if (t.number !== n) {
        t.number = n;
        changed = true;
      }
    });
    const after = txList.slice(-3).map((t) => `${t.date}:#${t.number}`).join(", ");
    if (before !== after) console.log(`[recompute] ${group}: ...${before} → ...${after}`);
  }
  console.log(`[recompute] done, changed=${changed}`);
  return changed;
}

/** @deprecated Use recomputeVoucherNumbers instead */
export const repairLocalDuplicateNumbers = recomputeVoucherNumbers;

export function cleanText(value: string): string {
  return (value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&apos;|&#39;|&#x27;/gi, String.fromCharCode(39))
    .replace(/&quot;|&#34;|&#x22;/gi, String.fromCharCode(34))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function isDebitNatureAccount(account: {
  parent?: string;
  category?: string;
  name?: string;
}): boolean {
  const parent = cleanText(account.parent || "").toLowerCase(),
    category = cleanText(account.category || "").toLowerCase(),
    name = cleanText(account.name || "").toLowerCase(),
    classification = `${parent} ${category}`;
  if (name.includes("credit card")) return false;
  if (/capital|liabilit|sundry creditors|payable/.test(classification)) return false;
  return /asset|bank accounts|cash-in-hand|cash|deposit|investment|fixed assets|loans & advances \(asset\)|ppf/.test(
    `${classification} ${name}`
  );
}

export function displayLedgerBalance(
  _account: { parent?: string; category?: string; name?: string },
  value: number
): number {
  return -(value || 0);
}

// Same opening + debit - credit math as VaultApp's `calc`, collapsed to one account and one
// as-of date instead of a report period range -- used to show a ledger's running balance right
// in the voucher entry form (Tally-style "current balance" next to the ledger picker), reflecting
// everything already posted up to and including that date. Excludes deleted/cancelled vouchers,
// same as every other balance calculation in this app.
export function ledgerBalanceAsOf(data: Ledger, accountId: number, asOfDate: string): number {
  const account = data.accounts.find((a) => a.id === accountId);
  let raw = account?.openingBalance || 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    if (!asOfDate || t.date > asOfDate) continue;
    for (const e of t.entries) {
      if (e.accountId === accountId) raw += e.amount;
    }
  }
  return -raw;
}

export const periodKeyOf = (date: string): string => date.slice(0, 7); // "YYYY-MM"

// Upfront check used to block Edit/Delete before the form even opens (not just at save time) --
// so a closed-period voucher's Edit/Delete controls stop working the moment the period closes,
// rather than letting the user go through the whole form only to get rejected at the end.
export const isPeriodClosed = (closedPeriods: string[] | undefined, date: string): boolean =>
  !!closedPeriods?.includes(periodKeyOf(date));

// Standard ERP period-close enforcement: blocks a save from creating, editing, or deleting any
// voucher dated in a closed period. Any combination of periods can be closed independently (not
// just a rolling cutoff) -- see PeriodControlPanel in MastersPanel.tsx. Compares the full
// incoming transaction list against what's currently saved (by guid, the one stable identity
// across an edit -- see `add()` in VaultApp.tsx) rather than trusting the caller to say what
// changed, so this catches every save path uniformly (manual entry, Trash restore/purge, Plaid/
// Schwab/Teller import, bulk report posting) without needing each one to individually know about
// the lock. Returns null when nothing in a closed period actually changed -- most saves never
// touch a closed period at all and should never be slowed down or blocked by this check.
export function findClosedPeriodViolations(
  current: Tx[],
  next: Tx[],
  closedPeriods: string[] | undefined,
  exempt?: Set<string>
): { count: number; examplePeriod: string } | null {
  if (!closedPeriods?.length) return null;
  const closed = new Set(closedPeriods);
  const currentByGuid = new Map(current.map((t) => [t.guid, t]));
  const nextByGuid = new Map(next.map((t) => [t.guid, t]));
  let count = 0;
  let examplePeriod = "";
  const flag = (period: string) => {
    count++;
    if (!examplePeriod || period < examplePeriod) examplePeriod = period;
  };
  for (const [guid, t] of nextByGuid) {
    if (exempt?.has(guid)) continue;
    const before = currentByGuid.get(guid);
    const period = periodKeyOf(t.date);
    if (!before) {
      // New voucher.
      if (closed.has(period)) flag(period);
    } else if (JSON.stringify(before) !== JSON.stringify(t)) {
      // Edited -- flagged if it's moving INTO, OUT OF, or staying within a closed period.
      const beforePeriod = periodKeyOf(before.date);
      if (closed.has(beforePeriod) || closed.has(period)) flag(closed.has(period) ? period : beforePeriod);
    }
  }
  for (const [guid, t] of currentByGuid) {
    if (!nextByGuid.has(guid) && closed.has(periodKeyOf(t.date))) flag(periodKeyOf(t.date)); // hard delete
  }
  return count > 0 ? { count, examplePeriod } : null;
}

export const cleanVoucherDisplay = (value: unknown): string =>
  String(value ?? "")
    .replace(/Ã\S*/g, " ")
    .replace(/[Â�]/g, " ")
    .replace(/[–—•·]/g, " | ")
    .replace(/\s+\|\s+\|\s+/g, " | ")
    .replace(/\s+/g, " ")
    .trim();

export const formatVoucherDisplayDate = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const loose = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (loose) return `${loose[1].padStart(2, "0")}-${loose[2].padStart(2, "0")}-${loose[3]}`;
  return cleanVoucherDisplay(raw);
};

export const voucherSideLedgerNames = (
  tx: {
    entries?: {
      amount?: number;
      accountName?: string;
      ledgerName?: string;
      ledger?: string;
      name?: string;
    }[];
  },
  side: "dr" | "cr"
): string => {
  const entries = Array.isArray(tx?.entries) ? tx.entries : [];
  return entries
    .filter((entry) =>
      side === "dr" ? Number(entry?.amount ?? 0) < -0.004 : Number(entry?.amount ?? 0) > 0.004
    )
    .map((entry) =>
      cleanVoucherDisplay(
        entry?.accountName ?? entry?.ledgerName ?? entry?.ledger ?? entry?.name ?? ""
      )
    )
    .filter(Boolean)
    .join(" / ");
};
