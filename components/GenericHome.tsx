"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { TransactionTable, type VoucherRow } from "@/components/TransactionTable";
import { validateVoucher } from "@/lib/voucher-validation.js";

type Mode = "standalone" | "tally";
type Tab = "dashboard" | "voucher" | "daybook" | "ledgers" | "masters" | "reports" | "connector";
type Report = "trial" | "income" | "balance" | "cashflow" | "cash";
type VoucherType = "Payment" | "Receipt" | "Contra" | "Journal";
type BalanceSide = "Dr" | "Cr";
type Nature =
  "Asset" | "Liability" | "Capital" | "Income" | "Expense" | "Bank" | "Cash" | "Investment";

type Group = { name: string; nature: Nature };
type Ledger = {
  id: number;
  name: string;
  group: string;
  openingRaw: number;
  active: boolean;
  sync: "ready" | "pending";
};
type Entry = { accountId: number; amount: number };
type Voucher = {
  guid: string;
  date: string;
  type: VoucherType;
  number: string;
  narration: string;
  entries: Entry[];
  source: "app" | "tally";
  sync: "ready" | "pending";
};
type Book = {
  id: string;
  name: string;
  address: string;
  currency: string;
  fiscalMonth: number;
  ownerName: string;
  ownerEmail: string;
  mode: Mode;
  tallyCompany: string;
  tallyBackupPath: string;
  passcodeHash: string;
  pairingCode: string;
  ledgers: Ledger[];
  vouchers: Voucher[];
};
type LedgerRow = {
  ledger: Ledger;
  nature: Nature;
  openingRaw: number;
  periodDr: number;
  periodCr: number;
  closingRaw: number;
};
type SetupDraft = {
  ownerName: string;
  ownerEmail: string;
  passcode: string;
  confirmPasscode: string;
  name: string;
  address: string;
  currency: string;
  fiscalMonth: number;
  mode: Mode;
  tallyCompany: string;
  tallyBackupPath: string;
};
type VoucherLine = { id: string; ledger: string; debit: string; credit: string };
type VoucherDraft = {
  date: string;
  type: VoucherType;
  narration: string;
  lines: VoucherLine[];
  createMissing: boolean;
};
type LedgerModal = { lineId?: string; suggestedName?: string; side?: BalanceSide } | null;

const STORAGE_KEY = "fintech-by-dk-generic-erp-v2";
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const voucherTypes: VoucherType[] = ["Payment", "Receipt", "Contra", "Journal"];
const tabs: [Tab, string][] = [
  ["dashboard", "Dashboard"],
  ["voucher", "New Voucher"],
  ["daybook", "Day Book"],
  ["ledgers", "Ledgers"],
  ["masters", "Masters"],
  ["reports", "Reports"],
  ["connector", "Connector"],
];
const groups: Group[] = [
  { name: "Bank Accounts", nature: "Bank" },
  { name: "Cash-in-hand", nature: "Cash" },
  { name: "Capital Account", nature: "Capital" },
  { name: "Current Assets", nature: "Asset" },
  { name: "Current Liabilities", nature: "Liability" },
  { name: "Fixed Assets", nature: "Asset" },
  { name: "Investments", nature: "Investment" },
  { name: "Direct Incomes", nature: "Income" },
  { name: "Indirect Incomes", nature: "Income" },
  { name: "Direct Expenses", nature: "Expense" },
  { name: "Indirect Expenses", nature: "Expense" },
  { name: "Sales Accounts", nature: "Income" },
  { name: "Purchase Accounts", nature: "Expense" },
  { name: "Sundry Debtors", nature: "Asset" },
  { name: "Sundry Creditors", nature: "Liability" },
];
const emptySetup: SetupDraft = {
  ownerName: "",
  ownerEmail: "",
  passcode: "",
  confirmPasscode: "",
  name: "",
  address: "",
  currency: "USD",
  fiscalMonth: 1,
  mode: "standalone",
  tallyCompany: "",
  tallyBackupPath: "",
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
const clean = (value: unknown) =>
  normalize(value)
    .replace(/\u00c3\S*/g, " ")
    .replace(/[\u00c2\ufffd]/g, " ")
    .replace(/[\u2013\u2014\u2022\u00b7]/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
const keyOf = (value: unknown) => clean(value).toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
const lineId = () => Math.random().toString(36).slice(2);
const zero = (value: number) => (Math.abs(value) < 0.005 ? 0 : value);
const rawDebit = (amount: number) => -Math.abs(amount);
const rawCredit = (amount: number) => Math.abs(amount);
const isCreditNature = (nature: Nature) => ["Liability", "Capital", "Income"].includes(nature);
const isProfitLossNature = (nature: Nature) => nature === "Income" || nature === "Expense";
const isCashNature = (nature: Nature) => nature === "Bank" || nature === "Cash";
const displayDate = (value: string) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : clean(value);
};

const safeCurrency = (value: unknown) => {
  const candidate = clean(value || "USD").toUpperCase();
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: candidate }).format(1);
    return candidate;
  } catch {
    return "USD";
  }
};
async function hashPasscode(passcode: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passcode));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function starterLedgers(mode: Mode): Ledger[] {
  const sync = mode === "tally" ? "pending" : "ready";
  return [
    { id: 1, name: "Bank Account", group: "Bank Accounts", openingRaw: 0, active: true, sync },
    { id: 2, name: "Cash", group: "Cash-in-hand", openingRaw: 0, active: true, sync },
    { id: 3, name: "Capital Account", group: "Capital Account", openingRaw: 0, active: true, sync },
    { id: 4, name: "General Income", group: "Indirect Incomes", openingRaw: 0, active: true, sync },
    {
      id: 5,
      name: "General Expense",
      group: "Indirect Expenses",
      openingRaw: 0,
      active: true,
      sync,
    },
  ];
}
function newVoucherLines(type: VoucherType): VoucherLine[] {
  if (type === "Receipt")
    return [
      { id: lineId(), ledger: "Bank Account", debit: "", credit: "" },
      { id: lineId(), ledger: "General Income", debit: "", credit: "" },
    ];
  if (type === "Contra")
    return [
      { id: lineId(), ledger: "Cash", debit: "", credit: "" },
      { id: lineId(), ledger: "Bank Account", debit: "", credit: "" },
    ];
  if (type === "Journal")
    return [
      { id: lineId(), ledger: "", debit: "", credit: "" },
      { id: lineId(), ledger: "", debit: "", credit: "" },
    ];
  return [
    { id: lineId(), ledger: "General Expense", debit: "", credit: "" },
    { id: lineId(), ledger: "Bank Account", debit: "", credit: "" },
  ];
}
const emptyVoucher = (type: VoucherType = "Payment"): VoucherDraft => ({
  date: today(),
  type,
  narration: "",
  lines: newVoucherLines(type),
  createMissing: false,
});
function makePairingCode() {
  return `FTDK-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
function groupNature(groupName: string): Nature {
  return groups.find((group) => group.name === groupName)?.nature ?? "Asset";
}
function ledgerNature(ledger: Ledger): Nature {
  return groupNature(ledger.group);
}
function defaultGroup(type: VoucherType, side: BalanceSide) {
  if (type === "Receipt" && side === "Dr") return "Bank Accounts";
  if (type === "Receipt" && side === "Cr") return "Indirect Incomes";
  if (type === "Payment" && side === "Dr") return "Indirect Expenses";
  if (type === "Payment" && side === "Cr") return "Bank Accounts";
  if (type === "Contra") return "Bank Accounts";
  if (type === "Journal" && side === "Dr") return "Current Assets";
  return "Current Liabilities";
}
function coerceBook(raw: Partial<Book>): Book | null {
  if (!raw || !raw.id) return null;
  const mode: Mode = raw.mode === "tally" ? "tally" : "standalone";
  const currency = safeCurrency(raw.currency);
  return {
    id: String(raw.id),
    name: clean(raw.name || "My Books"),
    address: clean((raw as Book).address || ""),
    currency,
    fiscalMonth: Number(raw.fiscalMonth || 1),
    ownerName: clean(raw.ownerName),
    ownerEmail: clean(raw.ownerEmail),
    mode,
    tallyCompany: clean(raw.tallyCompany || raw.name || ""),
    tallyBackupPath: clean((raw as Book).tallyBackupPath || ""),
    passcodeHash: String(raw.passcodeHash || ""),
    pairingCode: String(raw.pairingCode || makePairingCode()),
    ledgers:
      Array.isArray(raw.ledgers) && raw.ledgers.length
        ? raw.ledgers.map((ledger, index) => ({
            id: Number(ledger.id || index + 1),
            name: clean(ledger.name),
            group: clean(ledger.group || "Current Assets"),
            openingRaw: Number(ledger.openingRaw || 0),
            active: ledger.active !== false,
            sync: ledger.sync === "pending" ? "pending" : "ready",
          }))
        : starterLedgers(mode),
    vouchers: Array.isArray(raw.vouchers)
      ? raw.vouchers.map((voucher) => ({
          guid: String(voucher.guid || uid()),
          date: String(voucher.date || today()),
          type: (voucherTypes.includes(voucher.type as VoucherType)
            ? voucher.type
            : "Payment") as VoucherType,
          number: String(voucher.number || "1"),
          narration: clean(voucher.narration),
          source: voucher.source === "tally" ? "tally" : "app",
          sync: voucher.sync === "pending" ? "pending" : "ready",
          entries: Array.isArray(voucher.entries)
            ? voucher.entries.map((entry) => ({
                accountId: Number(entry.accountId),
                amount: Number(entry.amount),
              }))
            : [],
        }))
      : [],
  };
}
function fiscalPeriod(book: Book) {
  const now = new Date();
  const startMonth = Math.min(12, Math.max(1, Number(book.fiscalMonth || 1)));
  let startYear = now.getFullYear();
  if (now.getMonth() + 1 < startMonth) startYear -= 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(
    Date.UTC(startMonth === 1 ? startYear : startYear + 1, ((startMonth + 10) % 12) + 1, 0)
  );
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    label: `FY ${startYear} (${monthNames[start.getUTCMonth()]} ${startYear} - ${monthNames[end.getUTCMonth()]} ${end.getUTCFullYear()})`,
  };
}
function formatMoney(book: Book, value: number) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: safeCurrency(book.currency),
      currencyDisplay: "narrowSymbol",
    }).format(zero(value));
  } catch {
    return `${safeCurrency(book.currency)} ${zero(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
function activeLedgers(book: Book) {
  return book.ledgers
    .filter((ledger) => ledger.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}
function nextLedgerId(book: Book) {
  return Math.max(0, ...book.ledgers.map((ledger) => ledger.id)) + 1;
}
function nextVoucherNumber(book: Book, type: VoucherType) {
  return String(
    Math.max(
      0,
      ...book.vouchers
        .filter((voucher) => voucher.type === type)
        .map((voucher) => Number(voucher.number) || 0)
    ) + 1
  );
}
function ledgerRows(book: Book): LedgerRow[] {
  const period = fiscalPeriod(book);
  return activeLedgers(book).map((ledger) => {
    const nature = ledgerNature(ledger);
    let openingRaw = isProfitLossNature(nature) ? 0 : Number(ledger.openingRaw || 0);
    let periodDr = 0,
      periodCr = 0;
    for (const voucher of book.vouchers)
      for (const entry of voucher.entries.filter((line) => line.accountId === ledger.id)) {
        if (voucher.date < period.start) {
          if (!isProfitLossNature(nature)) openingRaw += entry.amount;
        } else if (voucher.date <= period.end) {
          if (entry.amount < 0) periodDr += Math.abs(entry.amount);
          if (entry.amount > 0) periodCr += entry.amount;
        }
      }
    return {
      ledger,
      nature,
      openingRaw: zero(openingRaw),
      periodDr: zero(periodDr),
      periodCr: zero(periodCr),
      closingRaw: zero(openingRaw - periodDr + periodCr),
    };
  });
}
function displayBalance(row: LedgerRow) {
  return isCreditNature(row.nature) ? row.closingRaw : -row.closingRaw;
}
function periodResult(row: LedgerRow) {
  if (row.nature === "Income") return row.periodCr - row.periodDr;
  if (row.nature === "Expense") return row.periodDr - row.periodCr;
  return 0;
}
function periodSummary(rows: LedgerRow[]) {
  let income = 0,
    expense = 0;
  for (const row of rows) {
    if (row.nature === "Income") income += periodResult(row);
    if (row.nature === "Expense") expense += periodResult(row);
  }
  return { income: zero(income), expense: zero(expense), result: zero(income - expense) };
}
function voucherRows(book: Book): VoucherRow[] {
  const names = new Map(book.ledgers.map((ledger) => [ledger.id, ledger.name]));
  return [...book.vouchers]
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.number) - Number(a.number))
    .map((voucher) => ({
      guid: voucher.guid,
      date: voucher.date,
      type: voucher.type,
      number: voucher.number,
      narration: voucher.narration,
      entries: voucher.entries.map((entry) => ({
        accountName: names.get(entry.accountId) || "Missing ledger",
        amount: entry.amount,
      })),
    }));
}
function voucherRule(type: VoucherType) {
  if (type === "Receipt") return "Debit Bank or Cash and credit income or party ledgers.";
  if (type === "Contra") return "Use only Cash and Bank ledgers on both sides.";
  if (type === "Journal") return "Use Journal for non-cash adjustments only.";
  return "Debit expenses, assets, or parties and credit Bank or Cash.";
}

export function GenericHome() {
  const [books, setBooks] = useState<Book[]>([]),
    [selectedBookId, setSelectedBookId] = useState(""),
    [setup, setSetup] = useState<SetupDraft>(emptySetup),
    [tab, setTab] = useState<Tab>("dashboard"),
    [report, setReport] = useState<Report>("trial"),
    [status, setStatus] = useState(""),
    [unlocked, setUnlocked] = useState<Set<string>>(() => new Set()),
    [passcode, setPasscode] = useState(""),
    [draft, setDraft] = useState<VoucherDraft>(() => emptyVoucher()),
    [editingGuid, setEditingGuid] = useState<string | null>(null),
    [ledgerSearch, setLedgerSearch] = useState(""),
    [ledgerModal, setLedgerModal] = useState<LedgerModal>(null),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("resetgeneric")) {
        localStorage.removeItem(STORAGE_KEY);
        setBooks([]);
        setSelectedBookId("");
        return;
      }
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as Partial<Book>[];
      const source = Array.isArray(parsed) ? parsed : [];
      const next = source
        .map((item) => {
          try {
            return coerceBook(item);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Book[];
      setBooks(next);
      setSelectedBookId(next[0]?.id || "");
    } catch {
      setBooks([]);
      setSelectedBookId("");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
  }, [books, loaded]);
  const book = useMemo(
    () => books.find((item) => item.id === selectedBookId) || books[0] || null,
    [books, selectedBookId]
  );
  const rows = useMemo(() => {
    try {
      return book ? ledgerRows(book) : [];
    } catch {
      return [];
    }
  }, [book]);
  const txRows = useMemo(() => {
    try {
      return book ? voucherRows(book) : [];
    } catch {
      return [];
    }
  }, [book]);
  const period = book ? fiscalPeriod(book) : null;
  const locked = !!book && !!book.passcodeHash && !unlocked.has(book.id);
  const saveBook = (next: Book) =>
    setBooks((current) => current.map((item) => (item.id === next.id ? next : item)));
  // Auto-open Migration Assistant for a new Tally workspace until data is imported.
  useEffect(() => {
    if (book?.mode === "tally" && book.vouchers.length === 0 && tab === "dashboard")
      setTab("connector");
  }, [book?.id, book?.mode, book?.vouchers.length, tab]);

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    const userId = clean(setup.ownerEmail);
    const companyName = clean(setup.name);
    if (!userId) {
      setStatus("Enter your user ID or email.");
      return;
    }
    if (setup.passcode.length < 4) {
      setStatus("Create a password of at least 4 characters.");
      return;
    }
    if (setup.passcode !== setup.confirmPasscode) {
      setStatus("Passwords do not match.");
      return;
    }
    if (setup.mode === "standalone" && !companyName) {
      setStatus("Enter the company name.");
      return;
    }
    if (setup.mode === "tally" && !clean(setup.tallyBackupPath)) {
      setStatus("Enter the Tally backup folder path.");
      return;
    }
    const workspaceName = setup.mode === "tally" ? "Tally Migration" : companyName;
    const next: Book = {
      id: uid(),
      name: workspaceName,
      address: clean(setup.address),
      currency: safeCurrency(setup.currency),
      fiscalMonth: Number(setup.fiscalMonth || 1),
      ownerName: userId,
      ownerEmail: userId,
      mode: setup.mode,
      tallyCompany: setup.mode === "tally" ? "" : workspaceName,
      tallyBackupPath: clean(setup.tallyBackupPath),
      passcodeHash: await hashPasscode(setup.passcode),
      pairingCode: makePairingCode(),
      ledgers: starterLedgers(setup.mode),
      vouchers: [],
    };
    setBooks((current) => [next, ...current]);
    setSelectedBookId(next.id);
    setUnlocked((current) => new Set([...current, next.id]));
    setSetup(emptySetup);
    setDraft(emptyVoucher());
    setTab(setup.mode === "tally" ? "connector" : "dashboard");
    setStatus(setup.mode === "tally" ? "Tally migration workspace created." : "Company created.");
  }
  async function unlockWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!book) return;
    const hash = await hashPasscode(passcode);
    if (hash !== book.passcodeHash) {
      setStatus("Incorrect passcode.");
      return;
    }
    setUnlocked((current) => new Set([...current, book.id]));
    setPasscode("");
    setStatus("Workspace unlocked.");
  }
  function lockWorkspace() {
    if (!book) return;
    setUnlocked((current) => {
      const next = new Set(current);
      next.delete(book.id);
      return next;
    });
    setStatus("Workspace locked.");
  }
  function addOrFindLedger(name: string, group: string, opening: number, side: BalanceSide) {
    if (!book) return null;
    const cleanedName = clean(name);
    const existing = activeLedgers(book).find(
      (ledger) => keyOf(ledger.name) === keyOf(cleanedName)
    );
    if (existing) return existing;
    const ledger: Ledger = {
      id: nextLedgerId(book),
      name: cleanedName,
      group,
      openingRaw: side === "Cr" ? rawCredit(opening) : rawDebit(opening),
      active: true,
      sync: book.mode === "tally" ? "pending" : "ready",
    };
    saveBook({ ...book, ledgers: [...book.ledgers, ledger] });
    return ledger;
  }
  function openLedgerModal(line?: VoucherLine, side?: BalanceSide) {
    setLedgerModal({ lineId: line?.id, suggestedName: line?.ledger, side });
  }
  function saveLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!book || !ledgerModal) return;
    const form = new FormData(event.currentTarget),
      name = clean(form.get("name")),
      group = clean(form.get("group")) || defaultGroup(draft.type, ledgerModal.side || "Dr"),
      opening = Math.abs(Number(form.get("opening") || 0)),
      side = (form.get("side") === "Cr" ? "Cr" : "Dr") as BalanceSide;
    if (!name) {
      setStatus("Enter a ledger name.");
      return;
    }
    const ledger = addOrFindLedger(name, group, opening, side);
    if (ledger && ledgerModal.lineId)
      setDraft((current) => ({
        ...current,
        lines: current.lines.map((line) =>
          line.id === ledgerModal.lineId ? { ...line, ledger: ledger.name } : line
        ),
      }));
    setLedgerModal(null);
    setStatus(`Ledger ${name} is ready.`);
  }
  function updateLine(id: string, patch: Partial<VoucherLine>) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }));
  }
  function changeVoucherType(type: VoucherType) {
    setDraft((current) => ({ ...current, type, lines: newVoucherLines(type) }));
    setEditingGuid(null);
  }
  function saveVoucher(event: FormEvent) {
    event.preventDefault();
    if (!book) return;
    let nextLedgers = [...book.ledgers],
      nextId = nextLedgerId(book);
    const entries: Entry[] = [];
    for (const line of draft.lines) {
      const ledgerName = clean(line.ledger),
        debit = Math.abs(Number(line.debit || 0)),
        credit = Math.abs(Number(line.credit || 0));
      if (!ledgerName && !debit && !credit) continue;
      if (!ledgerName) {
        setStatus("Every amount line needs a ledger.");
        return;
      }
      if (debit && credit) {
        setStatus("One line cannot have both Debit and Credit.");
        return;
      }
      if (!debit && !credit) {
        setStatus(`Enter Debit or Credit amount for ${ledgerName}.`);
        return;
      }
      let ledger = nextLedgers.find((item) => keyOf(item.name) === keyOf(ledgerName));
      if (!ledger && draft.createMissing) {
        const group = defaultGroup(draft.type, debit ? "Dr" : "Cr");
        ledger = {
          id: nextId++,
          name: ledgerName,
          group,
          openingRaw: 0,
          active: true,
          sync: book.mode === "tally" ? "pending" : "ready",
        };
        nextLedgers = [...nextLedgers, ledger];
      }
      if (!ledger) {
        setStatus(
          `Ledger ${ledgerName} does not exist. Create it first or tick Create missing ledgers.`
        );
        return;
      }
      entries.push({ accountId: ledger.id, amount: debit ? rawDebit(debit) : rawCredit(credit) });
    }
    const voucher: Voucher = {
      guid: editingGuid || uid(),
      date: draft.date || today(),
      type: draft.type,
      number: editingGuid
        ? book.vouchers.find((item) => item.guid === editingGuid)?.number ||
          nextVoucherNumber(book, draft.type)
        : nextVoucherNumber(book, draft.type),
      narration: clean(draft.narration),
      entries,
      source: "app",
      sync: book.mode === "tally" ? "pending" : "ready",
    };
    const validation = validateVoucher(voucher, nextLedgers);
    if (!validation.valid) {
      setStatus(validation.errors.join(" "));
      return;
    }
    const nextVouchers = editingGuid
      ? book.vouchers.map((item) => (item.guid === editingGuid ? voucher : item))
      : [voucher, ...book.vouchers];
    saveBook({ ...book, ledgers: nextLedgers, vouchers: nextVouchers });
    setEditingGuid(null);
    setDraft(emptyVoucher(draft.type));
    setReport("trial");
    setTab("reports");
    setStatus("Voucher saved. Reports refreshed from the balanced Dr/Cr entry.");
  }
  function editVoucher(row: VoucherRow) {
    if (!book) return;
    const voucher = book.vouchers.find((item) => item.guid === row.guid);
    if (!voucher) return;
    const names = new Map(book.ledgers.map((ledger) => [ledger.id, ledger.name]));
    setEditingGuid(voucher.guid);
    setDraft({
      date: voucher.date,
      type: voucher.type,
      narration: voucher.narration,
      createMissing: false,
      lines: voucher.entries.map((entry) => ({
        id: lineId(),
        ledger: names.get(entry.accountId) || "",
        debit: entry.amount < 0 ? String(Math.abs(entry.amount)) : "",
        credit: entry.amount > 0 ? String(entry.amount) : "",
      })),
    });
    setTab("voucher");
    setStatus("Editing existing voucher. Save to update it.");
  }
  function copyVoucher(row: VoucherRow) {
    editVoucher(row);
    setEditingGuid(null);
    setStatus("Voucher copied. Save it to create a new voucher number.");
  }
  function deleteVoucher(row: VoucherRow) {
    if (!book || !confirm(`Delete ${row.type} voucher ${row.number}?`)) return;
    saveBook({ ...book, vouchers: book.vouchers.filter((voucher) => voucher.guid !== row.guid) });
    setStatus("Voucher deleted. Reports refreshed.");
  }

  if (!loaded)
    return (
      <main className="dk-lock">
        <section className="dk-unlock-card">
          <Brand />
          <h1>FinTech by DK</h1>
          <p>Opening your workspace...</p>
        </section>
      </main>
    );
  if (!loaded)
    return (
      <main className="dk-lock">
        <section className="dk-unlock-card">
          <Brand />
          <h1>FinTech by DK</h1>
          <p>Opening your workspace...</p>
        </section>
      </main>
    );
  if (!loaded)
    return (
      <main className="dk-lock">
        <section className="dk-unlock-card">
          <Brand />
          <h1>FinTech by DK</h1>
          <p>Opening your workspace...</p>
        </section>
      </main>
    );
  if (!book) return renderSetup();
  if (locked) return renderLocked(book);
  const pendingCount =
    book.ledgers.filter((ledger) => ledger.sync === "pending").length +
    book.vouchers.filter((voucher) => voucher.sync === "pending").length;
  return (
    <main className="dk-erp-shell">
      {renderRail(book)}
      <section className="dk-workspace">
        <header className="dk-header">
          <div>
            <small>FINTECH BY DK - GENERIC FINANCE ERP</small>
            <h1>{book.name}</h1>
            <p>
              {book.mode === "standalone" ? "Standalone books" : "Tally migration"} |{" "}
              {book.currency} | {book.ledgers.length} ledgers | {book.vouchers.length} vouchers
            </p>
          </div>
          <div className="dk-actions">
            <button onClick={lockWorkspace}>Lock</button>
            <button onClick={() => setTab("connector")}>Connector</button>
            <button className="dk-primary" onClick={() => setTab("voucher")}>
              New Voucher
            </button>
          </div>
        </header>
        <nav className="dk-tabs">
          {tabs
            .filter(([id]) => id !== "connector")
            .map(([id, label]) => (
              <button key={id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
        </nav>
        <div className="dk-period">
          <strong>Financial period</strong>
          <span>{period?.label}</span>
          <em>Opening + period activity = closing</em>
        </div>
        {status && <div className="dk-status">{status}</div>}
        {tab === "dashboard" && renderDashboard(book, rows, pendingCount)}
        {tab === "voucher" && renderVoucher(book)}
        {tab === "daybook" && (
          <section className="dk-card">
            <div className="dk-card-title">
              <div>
                <h2>Day Book</h2>
                <p>Search, edit, copy, or delete saved vouchers.</p>
              </div>
            </div>
            <TransactionTable
              transactions={txRows}
              formatAmount={(value) => formatMoney(book, value)}
              onView={editVoucher}
              onEdit={editVoucher}
              onCopy={copyVoucher}
              onDelete={deleteVoucher}
            />
          </section>
        )}
        {tab === "ledgers" && renderLedgers(book, rows)}
        {tab === "masters" && renderMasters(book)}
        {tab === "reports" && renderReports(book, rows)}
        {tab === "connector" && renderConnector(book, pendingCount)}
        {ledgerModal && renderLedgerModal(book)}
      </section>
    </main>
  );

  function renderSetup() {
    const isTally = setup.mode === "tally";
    return (
      <main className="dk-erp-shell setup clean-setup">
        <aside className="dk-rail setup-rail">
          <Brand />
          <div>
            <strong>FinTech by DK</strong>
            <small>Finance ERP</small>
          </div>
        </aside>
        <section className="dk-workspace setup-workspace">
          <header className="dk-header">
            <div>
              <small>FINTECH BY DK - START</small>
              <h1>Start your books</h1>
              <p>Choose one option. The app will ask only what is needed.</p>
            </div>
          </header>
          <form className="dk-setup-grid clean-start" onSubmit={createWorkspace}>
            <button
              type="button"
              className={`dk-mode ${!isTally ? "selected" : ""}`}
              onClick={() => setSetup((current) => ({ ...current, mode: "standalone" }))}
            >
              <strong>Standalone</strong>
              <span>Create a new company and use FinTech by DK directly.</span>
            </button>
            <button
              type="button"
              className={`dk-mode tally ${isTally ? "selected" : ""}`}
              onClick={() => setSetup((current) => ({ ...current, mode: "tally" }))}
            >
              <strong>Tally Migration</strong>
              <span>
                Give the Tally backup folder path. The connector reads company data from there.
              </span>
            </button>

            <section className="dk-card setup-login">
              <h2>Secure Login</h2>
              <div className="dk-form two">
                <label>
                  User ID / email
                  <input
                    value={setup.ownerEmail}
                    onChange={(event) =>
                      setSetup((current) => ({ ...current, ownerEmail: event.target.value }))
                    }
                    placeholder="name@example.com"
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={setup.passcode}
                    onChange={(event) =>
                      setSetup((current) => ({ ...current, passcode: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    type="password"
                    value={setup.confirmPasscode}
                    onChange={(event) =>
                      setSetup((current) => ({ ...current, confirmPasscode: event.target.value }))
                    }
                  />
                </label>
              </div>
            </section>

            {!isTally ? (
              <section className="dk-card">
                <h2>Company Details</h2>
                <div className="dk-form two">
                  <label>
                    Company name
                    <input
                      value={setup.name}
                      onChange={(event) =>
                        setSetup((current) => ({ ...current, name: event.target.value }))
                      }
                      placeholder="Example: My Company"
                    />
                  </label>
                  <label>
                    Currency
                    <input
                      value={setup.currency}
                      onChange={(event) =>
                        setSetup((current) => ({
                          ...current,
                          currency: event.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="USD, INR, EUR"
                    />
                  </label>
                  <label>
                    Financial year starts
                    <select
                      value={setup.fiscalMonth}
                      onChange={(event) =>
                        setSetup((current) => ({
                          ...current,
                          fiscalMonth: Number(event.target.value),
                        }))
                      }
                    >
                      {monthNames.map((month, index) => (
                        <option key={month} value={index + 1}>
                          {month}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    Address
                    <textarea
                      rows={2}
                      value={setup.address}
                      onChange={(event) =>
                        setSetup((current) => ({ ...current, address: event.target.value }))
                      }
                      placeholder="Company address"
                    />
                  </label>
                </div>
              </section>
            ) : (
              <section className="dk-card migration-card">
                <h2>Tally Backup</h2>
                <p>
                  Enter only the backup folder path. Company, ledgers, vouchers, fiscal year, and
                  currency will be imported by the connector.
                </p>
                <div className="dk-form two">
                  <label className="wide">
                    Backup folder path
                    <input
                      value={setup.tallyBackupPath}
                      onChange={(event) =>
                        setSetup((current) => ({ ...current, tallyBackupPath: event.target.value }))
                      }
                      placeholder="Example: G:\My Drive\Tally App\Data\10000"
                    />
                  </label>
                </div>
              </section>
            )}

            <section className="dk-card setup-submit">
              <button className="dk-primary">
                {isTally ? "Start Tally Migration" : "Create Standalone Company"}
              </button>
              <span>
                {isTally
                  ? "No host, port, or technical fields are needed."
                  : "You can add ledgers and vouchers after creation."}
              </span>
              {status && <em>{status}</em>}
            </section>
          </form>
        </section>
      </main>
    );
  }
  function renderLocked(activeBook: Book) {
    return (
      <main className="dk-erp-shell">
        {renderRail(activeBook)}
        <section className="dk-lock">
          <form className="dk-unlock-card" onSubmit={unlockWorkspace}>
            <Brand />
            <small>SECURE WORKSPACE</small>
            <h1>{activeBook.name}</h1>
            <p>Enter your workspace passcode to continue.</p>
            <input
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoFocus
            />
            <button className="dk-primary">Unlock</button>
            {status && <span>{status}</span>}
          </form>
        </section>
      </main>
    );
  }
  function renderRail(activeBook: Book | null) {
    return (
      <aside className="dk-rail">
        <div className="dk-rail-brand">
          <Brand />
          <strong>FinTech by DK</strong>
          <small>
            {activeBook
              ? activeBook.mode === "standalone"
                ? "Standalone ERP"
                : "Tally Migration"
              : "Finance ERP"}
          </small>
        </div>
        {books.length > 1 && (
          <select
            className="dk-book-switcher"
            value={selectedBookId}
            onChange={(event) => setSelectedBookId(event.target.value)}
          >
            {books.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        {activeBook && (
          <nav>
            {tabs.map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
        )}
        <div className="dk-rail-bottom" />
      </aside>
    );
  }
  function renderVoucher(activeBook: Book) {
    const debitTotal = draft.lines.reduce(
        (sum, line) => sum + Math.abs(Number(line.debit || 0)),
        0
      ),
      creditTotal = draft.lines.reduce((sum, line) => sum + Math.abs(Number(line.credit || 0)), 0),
      balanced = zero(debitTotal - creditTotal) === 0 && debitTotal > 0;
    return (
      <section className="dk-card voucher">
        <div className="dk-card-title">
          <div>
            <h2>{editingGuid ? "Edit Voucher" : "New Voucher"}</h2>
            <p>{voucherRule(draft.type)}</p>
          </div>
          <button onClick={() => setLedgerModal({ side: "Dr" })}>Create Ledger</button>
        </div>
        <form className="dk-voucher-form" onSubmit={saveVoucher}>
          <div className="dk-form four">
            <label>
              Voucher type
              <select
                value={draft.type}
                onChange={(event) => changeVoucherType(event.target.value as VoucherType)}
              >
                {voucherTypes.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                value={draft.date}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, date: event.target.value }))
                }
              />
            </label>
            <label>
              Voucher number
              <input
                value={
                  editingGuid
                    ? activeBook.vouchers.find((item) => item.guid === editingGuid)?.number ||
                      "Existing"
                    : "Auto assigned"
                }
                readOnly
              />
            </label>
            <label>
              Sync status
              <input
                value={activeBook.mode === "tally" ? "Pending connector sync" : "Ready in app"}
                readOnly
              />
            </label>
          </div>
          <datalist id="generic-ledgers">
            {activeLedgers(activeBook).map((ledger) => (
              <option key={ledger.id} value={ledger.name} />
            ))}
          </datalist>
          <div className="dk-entry-table">
            <div className="entry-head">
              <span>Ledger</span>
              <span>Debit</span>
              <span>Credit</span>
              <span />
            </div>
            {draft.lines.map((line) => (
              <div className="entry-line" key={line.id}>
                <div className="ledger-cell">
                  <input
                    list="generic-ledgers"
                    value={line.ledger}
                    onChange={(event) => updateLine(line.id, { ledger: event.target.value })}
                    placeholder="Choose ledger"
                  />
                  <button
                    type="button"
                    onClick={() => openLedgerModal(line, line.debit ? "Dr" : "Cr")}
                  >
                    +
                  </button>
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.debit}
                  onChange={(event) =>
                    updateLine(line.id, {
                      debit: event.target.value,
                      credit: event.target.value ? "" : line.credit,
                    })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.credit}
                  onChange={(event) =>
                    updateLine(line.id, {
                      credit: event.target.value,
                      debit: event.target.value ? "" : line.debit,
                    })
                  }
                />
                <button
                  type="button"
                  disabled={draft.lines.length <= 2}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      lines: current.lines.filter((item) => item.id !== line.id),
                    }))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="add-line"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  lines: [...current.lines, { id: lineId(), ledger: "", debit: "", credit: "" }],
                }))
              }
            >
              Add line item
            </button>
          </div>
          <label className="dk-check">
            <input
              type="checkbox"
              checked={draft.createMissing}
              onChange={(event) =>
                setDraft((current) => ({ ...current, createMissing: event.target.checked }))
              }
            />{" "}
            Create missing ledgers using sensible default groups
          </label>
          <label className="dk-narration">
            Narration
            <textarea
              rows={3}
              value={draft.narration}
              onChange={(event) =>
                setDraft((current) => ({ ...current, narration: event.target.value }))
              }
            />
          </label>
          <div className={balanced ? "dk-voucher-total balanced" : "dk-voucher-total difference"}>
            <span>
              Debit total <strong>{formatMoney(activeBook, debitTotal)}</strong>
            </span>
            <span>
              Credit total <strong>{formatMoney(activeBook, creditTotal)}</strong>
            </span>
            <span>
              Difference <strong>{formatMoney(activeBook, debitTotal - creditTotal)}</strong>
            </span>
            <button className="dk-primary">Save Voucher and View Reports</button>
          </div>
        </form>
      </section>
    );
  }
  function renderLedgers(activeBook: Book, activeRows: LedgerRow[]) {
    const filtered = activeRows.filter(
      (row) =>
        !ledgerSearch ||
        `${row.ledger.name} ${row.ledger.group}`.toLowerCase().includes(ledgerSearch.toLowerCase())
    );
    const totals = filtered.reduce(
      (acc, row) => ({
        openingDr: acc.openingDr + (row.openingRaw < 0 ? Math.abs(row.openingRaw) : 0),
        openingCr: acc.openingCr + (row.openingRaw > 0 ? row.openingRaw : 0),
        periodDr: acc.periodDr + row.periodDr,
        periodCr: acc.periodCr + row.periodCr,
        closingDr: acc.closingDr + (row.closingRaw < 0 ? Math.abs(row.closingRaw) : 0),
        closingCr: acc.closingCr + (row.closingRaw > 0 ? row.closingRaw : 0),
      }),
      { openingDr: 0, openingCr: 0, periodDr: 0, periodCr: 0, closingDr: 0, closingCr: 0 }
    );
    return (
      <section className="dk-card">
        <div className="dk-card-title">
          <div>
            <h2>Ledger Report</h2>
            <p>Income and expense ledgers start at zero for each financial period.</p>
          </div>
        </div>
        <div className="dk-toolbar">
          <input
            value={ledgerSearch}
            onChange={(event) => setLedgerSearch(event.target.value)}
            placeholder="Filter ledger or group"
          />
          <span>
            {filtered.length} of {activeRows.length} ledgers
          </span>
        </div>
        <table className="dk-table">
          <thead>
            <tr>
              <th>Ledger</th>
              <th>Group</th>
              <th className="right">Opening Dr</th>
              <th className="right">Opening Cr</th>
              <th className="right">Period Dr</th>
              <th className="right">Period Cr</th>
              <th className="right">Closing Dr</th>
              <th className="right">Closing Cr</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.ledger.id}>
                <td>
                  <strong>{row.ledger.name}</strong>
                </td>
                <td>{row.ledger.group}</td>
                <td className="right">
                  {row.openingRaw < 0 ? formatMoney(activeBook, Math.abs(row.openingRaw)) : "-"}
                </td>
                <td className="right">
                  {row.openingRaw > 0 ? formatMoney(activeBook, row.openingRaw) : "-"}
                </td>
                <td className="right">
                  {row.periodDr ? formatMoney(activeBook, row.periodDr) : "-"}
                </td>
                <td className="right">
                  {row.periodCr ? formatMoney(activeBook, row.periodCr) : "-"}
                </td>
                <td className="right">
                  {row.closingRaw < 0 ? formatMoney(activeBook, Math.abs(row.closingRaw)) : "-"}
                </td>
                <td className="right">
                  {row.closingRaw > 0 ? formatMoney(activeBook, row.closingRaw) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Totals</th>
              <th className="right">{formatMoney(activeBook, totals.openingDr)}</th>
              <th className="right">{formatMoney(activeBook, totals.openingCr)}</th>
              <th className="right">{formatMoney(activeBook, totals.periodDr)}</th>
              <th className="right">{formatMoney(activeBook, totals.periodCr)}</th>
              <th className="right">{formatMoney(activeBook, totals.closingDr)}</th>
              <th className="right">{formatMoney(activeBook, totals.closingCr)}</th>
            </tr>
          </tfoot>
        </table>
      </section>
    );
  }
  function renderMasters(activeBook: Book) {
    const filtered = activeLedgers(activeBook).filter(
      (ledger) =>
        !ledgerSearch ||
        `${ledger.name} ${ledger.group}`.toLowerCase().includes(ledgerSearch.toLowerCase())
    );
    return (
      <section className="dk-card">
        <div className="dk-card-title">
          <div>
            <h2>Ledger Masters</h2>
            <p>Create and maintain master data before posting vouchers.</p>
          </div>
          <button onClick={() => setLedgerModal({ side: "Dr" })}>Create Ledger</button>
        </div>
        <div className="dk-toolbar">
          <input
            value={ledgerSearch}
            onChange={(event) => setLedgerSearch(event.target.value)}
            placeholder="Search ledger or group"
          />
          <span>{filtered.length} ledgers</span>
        </div>
        <table className="dk-table">
          <thead>
            <tr>
              <th>Ledger</th>
              <th>Group</th>
              <th>Nature</th>
              <th className="right">Opening</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((ledger) => {
              const nature = ledgerNature(ledger);
              return (
                <tr key={ledger.id}>
                  <td>
                    <strong>{ledger.name}</strong>
                  </td>
                  <td>{ledger.group}</td>
                  <td>{nature}</td>
                  <td className="right">
                    {ledger.openingRaw === 0
                      ? "-"
                      : `${formatMoney(activeBook, Math.abs(ledger.openingRaw))} ${ledger.openingRaw > 0 ? "Cr" : "Dr"}`}
                  </td>
                  <td>
                    <span className={ledger.sync === "pending" ? "dk-pill warn" : "dk-pill good"}>
                      {ledger.sync === "pending" ? "Pending sync" : "Ready"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    );
  }
  function renderReports(activeBook: Book, activeRows: LedgerRow[]) {
    const reportTabs: [Report, string][] = [
      ["trial", "Trial Balance"],
      ["income", "Income & Expense"],
      ["balance", "Balance Sheet"],
      ["cashflow", "Cash Flow"],
      ["cash", "Cash and Bank"],
    ];
    return (
      <section>
        <div className="dk-report-tabs">
          {reportTabs.map(([id, label]) => (
            <button
              key={id}
              className={report === id ? "selected" : ""}
              onClick={() => setReport(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {report === "trial" && renderLedgers(activeBook, activeRows)}
        {report === "income" && renderIncomeReport(activeBook, activeRows)}
        {report === "balance" && renderBalanceSheet(activeBook, activeRows)}
        {report === "cashflow" && renderCashFlow(activeBook, activeRows)}
        {report === "cash" && renderCashAndBank(activeBook, activeRows)}
      </section>
    );
  }
  function renderConnector(activeBook: Book, pendingCount: number) {
    const site = typeof window === "undefined" ? "" : window.location.origin;
    const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const installCommand = [
      "$installer = Join-Path $env:TEMP 'Install-FinTech-Generic-Connector.ps1'",
      "Invoke-WebRequest -Uri " +
        psQuote(site + "/Install-FinTech-Generic-Connector.ps1") +
        " -OutFile $installer",
      "PowerShell -NoProfile -ExecutionPolicy Bypass -File $installer -CloudUrl " +
        psQuote(site) +
        " -WorkspaceId " +
        psQuote(activeBook.id) +
        " -PairingCode " +
        psQuote(activeBook.pairingCode) +
        " -BackupPath " +
        psQuote(activeBook.tallyBackupPath),
    ].join("; ");

    async function copyConnectorSetup() {
      try {
        await navigator.clipboard.writeText(installCommand);
        setStatus(
          "Connector command copied. Paste it in PowerShell on the Tally computer and press Enter."
        );
      } catch {
        setStatus(
          "Copy was blocked. Open Advanced recovery details and copy the connector command manually."
        );
      }
    }

    function refreshCloudImport(_book: Book) {
      window.location.reload();
    }

    return (
      <section className="dk-card connector migration-assistant">
        <div className="dk-card-title">
          <div>
            <h2>Tally Migration Assistant</h2>
            <p>Copy one connector command, run it on the Tally computer, then check import here.</p>
          </div>
          <span className="dk-pill warn">Waiting for connector</span>
        </div>
        <div className="connector-run-card">
          <div>
            <span>NEXT STEP</span>
            <h3>Run connector on the Tally computer</h3>
            <p>
              The command already includes the cloud link, workspace, pairing code, and backup
              folder path.
            </p>
          </div>
          <button type="button" className="dk-primary" onClick={copyConnectorSetup}>
            Copy Connector Command
          </button>
        </div>
        <div className="connector-grid clean">
          <article>
            <b>1</b>
            <strong>Workspace login</strong>
            <span>{activeBook.ownerEmail || "Saved for this workspace"}</span>
          </article>
          <article>
            <b>2</b>
            <strong>Backup folder</strong>
            <span>{activeBook.tallyBackupPath || "Not entered"}</span>
          </article>
          <article>
            <b>3</b>
            <strong>Import queue</strong>
            <span>{pendingCount} pending item(s)</span>
          </article>
          <article>
            <b>4</b>
            <strong>After import</strong>
            <span>Dashboard, Ledgers, Day Book, and Reports become available.</span>
          </article>
        </div>
        <div className="connector-actions">
          <button type="button" onClick={() => refreshCloudImport(activeBook)}>
            Check Import Now
          </button>
          <button type="button" onClick={() => setTab("dashboard")}>
            View Dashboard
          </button>
          <span>Run this only on the computer where the Tally backup folder exists.</span>
        </div>
        <details className="connector-advanced">
          <summary>Advanced recovery details</summary>
          <code>{installCommand}</code>
        </details>
      </section>
    );
  }
  function renderLedgerModal(activeBook: Book) {
    const side = ledgerModal?.side || "Dr";
    return (
      <div className="dk-modal">
        <form className="dk-card dk-modal-card" onSubmit={saveLedger}>
          <h2>Create Ledger</h2>
          <div className="dk-form two">
            <label>
              Ledger name
              <input
                name="name"
                defaultValue={ledgerModal?.suggestedName || ""}
                required
                autoFocus
              />
            </label>
            <label>
              Group
              <select name="group" defaultValue={defaultGroup(draft.type, side)}>
                {groups.map((group) => (
                  <option key={group.name}>{group.name}</option>
                ))}
              </select>
            </label>
            <label>
              Opening balance
              <input name="opening" type="number" min="0" step="0.01" defaultValue="0" />
            </label>
            <label>
              Opening side
              <select name="side" defaultValue={side}>
                <option>Dr</option>
                <option>Cr</option>
              </select>
            </label>
            <label className="wide">
              Status
              <input
                value={activeBook.mode === "tally" ? "Pending connector sync" : "Ready in app"}
                readOnly
              />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setLedgerModal(null)}>
              Cancel
            </button>
            <button className="dk-primary">Save Ledger</button>
          </div>
        </form>
      </div>
    );
  }
}
function Brand() {
  return (
    <b className="dk-brand-mark">
      <span>D</span>
      <span>K</span>
    </b>
  );
}
function renderDashboard(book: Book, rows: LedgerRow[], pendingCount: number) {
  const cash = rows
      .filter((row) => isCashNature(row.nature))
      .reduce((sum, row) => sum + displayBalance(row), 0),
    fixedAssets = rows
      .filter((row) => row.ledger.group === "Fixed Assets")
      .reduce((sum, row) => sum + displayBalance(row), 0),
    investments = rows
      .filter((row) => row.nature === "Investment")
      .reduce((sum, row) => sum + displayBalance(row), 0),
    summary = periodSummary(rows),
    recent = voucherRows(book).slice(0, 5);
  return (
    <>
      <section className="dk-kpis">
        <Kpi
          title="Cash and bank closing"
          value={formatMoney(book, cash)}
          note="Current cash position"
        />
        <Kpi
          title="Investments closing"
          value={formatMoney(book, investments)}
          note="Investment ledgers"
        />
        <Kpi
          title="Fixed assets closing"
          value={formatMoney(book, fixedAssets)}
          note="Fixed asset ledgers"
        />
        <Kpi
          title="Current period income"
          value={formatMoney(book, summary.income)}
          note="Income ledgers only"
        />
        <Kpi
          title="Current period expense"
          value={formatMoney(book, summary.expense)}
          note="Expense ledgers only"
        />
        <Kpi
          title="Pending sync"
          value={String(pendingCount)}
          note={book.mode === "tally" ? "Connector queue" : "Standalone mode"}
        />
      </section>
      <section className="dk-dashboard-lower">
        <div className="dk-card">
          <h2>Recent vouchers</h2>
          {recent.length ? (
            recent.map((row) => (
              <div className="dk-recent" key={row.guid}>
                <span>{displayDate(row.date)}</span>
                <strong>
                  {row.type} #{row.number}
                </strong>
                <em>{row.entries.map((entry) => clean(entry.accountName)).join(" / ")}</em>
              </div>
            ))
          ) : (
            <p className="empty-note">No vouchers yet. Post your first balanced voucher.</p>
          )}
        </div>
        <div className="dk-card">
          <h2>Workspace health</h2>
          <div className="health-row">
            <span>Mode</span>
            <strong>{book.mode === "standalone" ? "Standalone ERP" : "Tally Migration"}</strong>
          </div>
          <div className="health-row">
            <span>Ledgers</span>
            <strong>{book.ledgers.length}</strong>
          </div>
          <div className="health-row">
            <span>Vouchers</span>
            <strong>{book.vouchers.length}</strong>
          </div>
          <div className="health-row">
            <span>Reports</span>
            <strong>Ready</strong>
          </div>
        </div>
      </section>
    </>
  );
}
function Kpi({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <article className="dk-kpi">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function renderIncomeReport(book: Book, rows: LedgerRow[]) {
  const income = rows
      .filter((row) => row.nature === "Income")
      .map((row) => [row.ledger.name, periodResult(row)] as [string, number])
      .filter(([, value]) => Math.abs(value) > 0.005),
    expense = rows
      .filter((row) => row.nature === "Expense")
      .map((row) => [row.ledger.name, periodResult(row)] as [string, number])
      .filter(([, value]) => Math.abs(value) > 0.005),
    summary = periodSummary(rows);
  return (
    <div className="dk-report-grid">
      <ReportBlock
        title="Income"
        rows={income}
        totalLabel="Total Income"
        total={summary.income}
        book={book}
      />
      <ReportBlock
        title="Expenditure"
        rows={expense}
        totalLabel="Total Expenditure"
        total={summary.expense}
        book={book}
      />
      <section className="dk-card report-result">
        <span>Current period result</span>
        <strong>{formatMoney(book, summary.result)}</strong>
        <small>{summary.result >= 0 ? "Surplus" : "Deficit"}</small>
      </section>
    </div>
  );
}
function renderBalanceSheet(book: Book, rows: LedgerRow[]) {
  const summary = periodSummary(rows),
    assets = rows
      .filter((row) => ["Asset", "Bank", "Cash", "Investment"].includes(row.nature))
      .map((row) => [row.ledger.name, Math.max(0, displayBalance(row))] as [string, number])
      .filter(([, value]) => value > 0.005),
    liabilities = rows
      .filter((row) => ["Liability", "Capital"].includes(row.nature))
      .map((row) => [row.ledger.name, Math.abs(displayBalance(row))] as [string, number])
      .filter(([, value]) => value > 0.005),
    assetTotal =
      assets.reduce((sum, [, value]) => sum + value, 0) +
      (summary.result < 0 ? Math.abs(summary.result) : 0),
    liabilityTotal =
      liabilities.reduce((sum, [, value]) => sum + value, 0) +
      (summary.result > 0 ? summary.result : 0);
  return (
    <div className="dk-report-grid">
      <ReportBlock
        title="Capital and Liabilities"
        rows={[
          ...liabilities,
          ...(summary.result > 0
            ? [["Current period surplus", summary.result] as [string, number]]
            : []),
        ]}
        totalLabel="Total Capital and Liabilities"
        total={liabilityTotal}
        book={book}
      />
      <ReportBlock
        title="Assets"
        rows={[
          ...assets,
          ...(summary.result < 0
            ? [["Current period deficit", Math.abs(summary.result)] as [string, number]]
            : []),
        ]}
        totalLabel="Total Assets"
        total={assetTotal}
        book={book}
      />
      <section className="dk-card report-result">
        <span>Balance Sheet check</span>
        <strong>{formatMoney(book, assetTotal - liabilityTotal)}</strong>
        <small>
          {Math.abs(assetTotal - liabilityTotal) < 0.005 ? "Balanced" : "Review required"}
        </small>
      </section>
    </div>
  );
}
function renderCashAndBank(book: Book, rows: LedgerRow[]) {
  const cashRows = rows
    .filter((row) => isCashNature(row.nature))
    .map((row) => [row.ledger.name, displayBalance(row)] as [string, number])
    .filter(([, value]) => Math.abs(value) > 0.005);
  return (
    <ReportBlock
      title="Cash and Bank"
      rows={cashRows}
      totalLabel="Total Cash and Bank"
      total={cashRows.reduce((sum, [, value]) => sum + value, 0)}
      book={book}
    />
  );
}
function renderCashFlow(book: Book, rows: LedgerRow[]) {
  const cashLedgerIds = new Set(
      rows.filter((row) => isCashNature(row.nature)).map((row) => row.ledger.id)
    ),
    opening = rows
      .filter((row) => cashLedgerIds.has(row.ledger.id))
      .reduce(
        (sum, row) => sum + (isCreditNature(row.nature) ? row.openingRaw : -row.openingRaw),
        0
      ),
    closing = rows
      .filter((row) => cashLedgerIds.has(row.ledger.id))
      .reduce((sum, row) => sum + displayBalance(row), 0),
    inflows = new Map<string, number>(),
    outflows = new Map<string, number>();
  for (const voucher of book.vouchers) {
    const cashMovement = voucher.entries
      .filter((entry) => cashLedgerIds.has(entry.accountId))
      .reduce((sum, entry) => sum - entry.amount, 0);
    if (Math.abs(cashMovement) < 0.005) continue;
    const target = cashMovement > 0 ? inflows : outflows;
    for (const entry of voucher.entries.filter((line) => !cashLedgerIds.has(line.accountId))) {
      const ledger = book.ledgers.find((item) => item.id === entry.accountId),
        label = ledger?.group || ledger?.name || "Other";
      target.set(label, (target.get(label) || 0) + Math.abs(entry.amount));
    }
  }
  return (
    <div className="dk-report-grid">
      <ReportBlock
        title="Cash Inflows"
        rows={[...inflows]}
        totalLabel="Total Cash Inflows"
        total={[...inflows.values()].reduce((sum, value) => sum + value, 0)}
        book={book}
      />
      <ReportBlock
        title="Cash Outflows"
        rows={[...outflows]}
        totalLabel="Total Cash Outflows"
        total={[...outflows.values()].reduce((sum, value) => sum + value, 0)}
        book={book}
      />
      <section className="dk-card report-result">
        <span>Opening cash and bank</span>
        <strong>{formatMoney(book, opening)}</strong>
        <span>Net movement</span>
        <strong>{formatMoney(book, closing - opening)}</strong>
        <span>Closing cash and bank</span>
        <strong>{formatMoney(book, closing)}</strong>
      </section>
    </div>
  );
}
function ReportBlock({
  title,
  rows,
  totalLabel,
  total,
  book,
}: {
  title: string;
  rows: [string, number][];
  totalLabel: string;
  total: number;
  book: Book;
}) {
  return (
    <section className="dk-card report-block">
      <h2>{title}</h2>
      {rows.length ? (
        rows.map(([name, value]) => (
          <div className="report-row" key={name}>
            <span>{name}</span>
            <strong>{formatMoney(book, value)}</strong>
          </div>
        ))
      ) : (
        <p className="empty-note">No activity in this section.</p>
      )}
      <div className="report-total">
        <span>{totalLabel}</span>
        <strong>{formatMoney(book, total)}</strong>
      </div>
    </section>
  );
}
