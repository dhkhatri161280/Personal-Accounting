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
