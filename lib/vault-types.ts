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
