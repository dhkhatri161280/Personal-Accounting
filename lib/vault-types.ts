import type { MasterGroup } from "@/components/MastersPanel";

export type Entry = { accountId: number; accountName: string; amount: number };

export type VoucherLineDraft = { id: string; side: "debit" | "credit"; accountId: string; amount: string };

export type Tx = {
  id: number;
  guid: string;
  tallyGuid?: string;
  syncFingerprint?: string;
  syncStatus?: string;
  lastSyncedAt?: string;
  createdAt?: string;   // ISO timestamp when this entry was first saved to vault
  date: string;
  number: string;
  type: string;
  narration: string;
  historical: boolean;
  cancelled?: boolean;
  deleted?: boolean;
  entries: Entry[];
};

export type Account = {
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

export type RsuVest = {
  id: string;
  vestDate: string;
  shares: number;
  vestPrice: number;
  sharesHeld: number;
  taxShares?: number; // shares withheld by company for tax (auto-sold at vest FMV)
  salePrice?: number; // actual $/share for user-initiated sales; defaults to vestPrice
  pending?: boolean;  // true = future scheduled vest, not yet received
};

export type RsuGrant = {
  id: string;
  ticker: string;
  grantDate: string;
  totalShares: number;
  grantPrice: number;
  vests: RsuVest[];
};

export type EsppPurchase = {
  id: string;
  ticker: string;
  offeringDate: string;
  purchaseDate: string;
  shares: number;
  offeringPrice: number;
  purchasePrice: number;
  marketPriceAtPurchase: number;
  sharesHeld: number;
};

export type EquityData = {
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
};

export type PayrollRow = {
  label: string;       // e.g. "Base", "Bonus", "Stock", "Federal", "Total Tax"
  annual: number;       // "Salary" column — full-year total
  cumulative: number;   // "CUMULATIVE" column — YTD as of last filled period
  values: number[];     // one value per period, aligned to PayrollYear.periodLabels
  stockValues?: number[]; // one value per quarterly "Stocks" vesting-event column (separate
                           // from the pay-period columns) — the tax withheld on that specific
                           // vest, not a lump sum. Index N lines up with the Nth vest date of
                           // the year (chronological) in the Equity report.
};

// A pay period created from a posted Receipt voucher rather than the Excel import — either
// because the books have moved past the last Excel export, or the user filled in real
// paystub numbers by hand. Persisted (unlike the live-only "shadow period" preview) so
// edits survive and don't get recomputed from a rough estimate on every render.
export type ManualPayrollPeriod = {
  id: string;
  label: string;       // e.g. "Aug 16 Aug 31"
  txGuid: string;       // the linked Receipt voucher
  base: number;
  telephone: number;
  medical: number;
  k401: number;         // employee 401K contribution — can be derived from the voucher
  k401Emplr?: number;   // employer 401K match — NOT in the voucher (employer deposits it
                         // directly into the plan, not through the paycheck); manual entry only
  espp?: number;        // ESPP payroll deduction — also not in the voucher; manual entry only
  federal: number;
  ssn: number;
  medicare: number;
  stateWH: number;
  stateSDI: number;
  totalTax: number;
  net: number;
  estimated: boolean;   // true until the user edits it with real paystub numbers
};

// Records that a Plaid-confirmed bank deposit was matched to a specific pay period —
// set when the user saves an auto-detected payroll transaction in Plaid Import.
export type PayrollMatch = {
  periodIndex: number;   // index into PayrollYear.periodLabels / PayrollRow.values
  txGuid: string;        // guid of the vault Tx this deposit was posted as
  txDate: string;        // ISO date of the bank deposit
  depositAmount: number; // actual $ that hit the bank, from Plaid
  confirmedAt: string;   // ISO timestamp when the match was recorded
};

export type PayrollYear = {
  year: string;         // e.g. "2026"
  sheetName: string;    // source sheet name, e.g. "Yearly 2026"
  periodLabels: string[]; // e.g. ["Jan 01 Jan 15", "Jan 16 Jan 31", ...]
  rows: PayrollRow[];
  matches?: PayrollMatch[];
  manualPeriods?: ManualPayrollPeriod[];
};

export type PayrollData = {
  years: PayrollYear[];
  importedAt: string;
  sourceFileName: string;
};

export type TallyLedgerSnapshot = {
  asOf: string;
  balances: { name: string; parent?: string; closingBalance: number }[];
};

export type Ledger = {
  version: number;
  company: string;
  currency: string;
  createdAt: string;
  accounts: Account[];
  transactions: Tx[];
  groups?: MasterGroup[];
  currencies?: string[];
  voucherTypes?: string[];
  fiscalYearStartMonth?: number;
  equity?: EquityData;
  payroll?: PayrollData;
  tallyLedgerSnapshot?: TallyLedgerSnapshot;
};

export type Vault = {
  version: number;
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type SyncHealth = {
  book?: string;
  status?: string | null;
  lastCheckedAt?: string | null;
  matched?: number;
  tallyToApp?: number;
  appToTally?: number;
  conflicts?: number;
  errors?: number;
  message?: string | null;
};
