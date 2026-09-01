import type { Ledger, Tx, VoucherLineDraft } from "@/lib/vault-types";

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
  closedPeriods: string[] | undefined
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
