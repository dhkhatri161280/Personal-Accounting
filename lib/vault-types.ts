import type { MasterGroup } from "@/components/MastersPanel";

// assetTag is an optional sub-ledger marker (SAP/Oracle "Asset Number" style): a free-text tag
// the user assigns when the debit ledger is a Fixed-Assets-nature account, letting several
// entries posted to the SAME GL ledger (e.g. "Furniture Purchase") still be tracked as distinct
// depreciable assets underneath -- see lib/fixed-assets-ledger.ts's discoverTaggedAssetGroups.
// Only ever set going forward at entry time; never backfilled onto historical vouchers.
export type Entry = { accountId: number; accountName: string; amount: number; assetTag?: string };

export type VoucherLineDraft = {
  id: string;
  side: "debit" | "credit";
  accountId: string;
  amount: string;
  assetTag?: string;
  // Only meaningful when assetTag is a brand-new (not-yet-registered) tag -- the desired name for
  // its Asset Master record, e.g. "Dining Table - Living Spaces" instead of the ledger's own
  // generic name. Not itself stored on the Entry; useVoucherForm's add() reads it once to name
  // the record autoSyncTaggedAssets creates, same as the voucher detail popup's tag editor does.
  assetName?: string;
};

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
  // Receipts/statements attached via the voucher view modal. File bytes live in R2 (the
  // ATTACHMENTS binding) -- only this small metadata array lives in the encrypted vault blob.
  attachments?: Attachment[];
};

export type Attachment = {
  key: string; // R2 object key, e.g. "us/<txGuid>/<uuid>-<filename>"
  filename: string;
  size: number;
  contentType: string;
  uploadedAt: string;
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
  // true = an enrolled offering period whose purchase date hasn't happened yet -- shares/
  // purchasePrice/marketPriceAtPurchase are unset (0) until confirmed, since neither is knowable
  // before the actual purchase date (unlike an RSU's pending vest, where share count is fixed at
  // grant time). See RsuVest.pending for the analogous RSU flag.
  pending?: boolean;
};

// A single brokerage trade — open if saleDate is unset, closed once it is. marketOrSalePrice
// doubles as "last known market price" while open (superseded by live price fetches at render
// time) and "actual sale price" once closed; yesterday is only meaningful while open (daily G/L).
export type Trade = {
  id: string;
  company: string;
  symbol: string;
  broker: "CST" | "CSS" | "RBS";
  buyDate: string;
  saleDate?: string;
  units: number;
  costPerSh: number;
  marketOrSalePrice: number;
  yesterday: number;
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

// A pay period the user edited by hand — either created from a posted Receipt voucher
// (txGuid set) for a period the Excel import doesn't cover, OR a correction overlaid on
// top of an Excel-imported period (periodIndex set, txGuid absent) when the imported
// numbers were wrong and the user has the real paystub. Persisted (unlike the live-only
// "shadow period" preview) so edits survive and don't get recomputed on every render.
export type ManualPayrollPeriod = {
  id: string;
  label: string;       // e.g. "Aug 16 Aug 31"
  txGuid?: string;      // the linked Receipt voucher, when this period was created from one
  periodIndex?: number; // index into an Excel-imported PayrollYear.periodLabels, when this is
                         // a correction overlaid on an existing imported period
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
  // Set when a sheet's name matched the expected "Yearly <year>"/"<year> RCS" pattern but its
  // content couldn't be located (e.g. a renamed header column) -- that year silently vanished
  // from `years` otherwise, with nothing telling the user why.
  warnings?: string[];
};

// One TCS-style payslip (or similar Indian payroll slip), parsed from a password-protected
// PDF. "Projected Annual ..." fields are cumulative/YTD figures as printed on that specific
// month's slip (not derived) -- the employer recomputes them each month as investments and
// income change, so the *latest* month of a financial year has the most complete figures.
export type IndiaPayslipMonth = {
  label: string;   // e.g. "Apr 2014"
  date: string;    // YYYY-MM-01, for sorting/grouping by financial year
  basic: number;
  hra: number;
  conveyance: number;
  otherAllowances: number; // remaining Earnings lines lumped together
  grossEarnings: number;   // "Total Earnings (Current + Arrears)"
  pf: number;
  professionalTax: number;
  incomeTax: number;
  otherDeductions: number; // remaining Deductions lines lumped together
  totalDeductions: number;
  netPay: number;
  annualIncome?: number;       // "Annual Income" (projected, cumulative)
  netTaxIncome?: number;       // "Net Tax Income r/o"
  section80C?: number;
  section80D?: number;
  hsgLoanInterest?: number;
  chapterVIARelief?: number;
  totalTaxPayable?: number;
  taxDeductedTillDate?: number;
  balanceTax?: number;
  sourceFile: string;
  generatedAt?: string; // ISO timestamp the slip was generated -- used to pick the newer one
                        // when two files cover the same month (e.g. a reissued/corrected slip)
};

export type IndiaPayslipData = {
  months: IndiaPayslipMonth[];
  importedAt: string;
};

// One row per Assessment Year, entered by hand from a filed ITR -- these older PDFs are
// flattened/rendered (no fillable form fields) with layouts that changed across years, so
// they can't be reliably auto-parsed the way the payslips or the US payroll Excel can.
export type IndiaItrYear = {
  id: string;
  assessmentYear: string; // e.g. "2008-09"
  grossTotalIncome: number;
  deductionsChapterVIA: number;
  totalIncome: number;
  taxPayable: number;
  advanceTax: number;
  tds: number;
  tcs: number;
  selfAssessmentTax: number;
  refundOrDemand: number; // positive = refund, negative = demand payable
  filingDate?: string;
  notes?: string;
  // Itemized Chapter VI-A detail -- investments/premiums paid outside payroll (LIC, NSC, PPF,
  // ELSS, etc. under 80C; a medical policy premium under 80D). Their sum drives
  // deductionsChapterVIA rather than that field being entered as one lump guess.
  section80CItems?: { description: string; amount: number }[];
  section80DMedical?: number;
  // The HRA amount treated as exempt when deriving grossTotalIncome from payroll (Gross Salary
  // - HRA exempt - Professional Tax). Defaults to the full HRA paid but is editable since the
  // real exemption (least of HRA received / rent paid - 10% of basic / 50%-40% of basic) can be
  // less than that.
  hraExemptOverride?: number;
  // Short/long-term capital gain (or loss, entered negative) rolled into Gross Total Income
  // alongside salary income. Taxed at special flat rates (STCG under 111A, LTCG under 112/112A),
  // not the individual's slab rate -- kept separate from salary income so the slab-based Tax
  // Payable estimate can tell when it isn't applicable, rather than silently taxing gains at the
  // wrong rate.
  capitalGains?: { shortTerm: number; longTerm: number };
  // Gross Salary and Professional Tax normally come straight from summing this FY's payslip
  // rows, but both are editable overrides -- the payroll data can be incomplete, mid-correction,
  // or simply not match the figure actually filed, and the reconciliation shouldn't be blocked
  // on the payroll table being perfectly clean first.
  grossSalaryOverride?: number;
  professionalTaxOverride?: number;
  // Interest paid on a home loan, deductible under Section 24(b) against "Income from House
  // Property". Stored RAW (the actual amount paid, even past any statutory cap) -- capping is
  // applied only when deriving Gross Total Income, same pattern as the 80C/80D items. Whether
  // it's capped at all depends on houseRentIncome (see below).
  homeLoanInterest?: number;
  // Annual rent received on the property -- 0/undefined means self-occupied (no rental income),
  // where the home loan interest deduction is capped (Section 24(b)). Any positive rent means
  // the property is treated as let-out: a flat 30% standard deduction applies to the rent
  // (Section 24(a)) and the loan interest deduction becomes UNCAPPED (the self-occupied cap
  // doesn't apply to a let-out property at all).
  houseRentIncome?: number;
  // Overrides the general-case self-occupied Section 24(b) cap for this specific AY -- the
  // Rs 2,00,000 figure only applies if the property's construction/acquisition completed within
  // 5 years of the loan (among other conditions this app can't verify), so a real filed return
  // can show a different figure (e.g. Rs 1,50,000) than the general rule would predict.
  homeLoanInterestCapOverride?: number;
  // Income from Other Sources (Section 56) -- bank/FD interest, dividends, etc. Added to Gross
  // Total Income in full, no standard deduction or cap (unlike house property/80C).
  otherSourcesIncome?: number;
};

export type IndiaTaxData = {
  payslips?: IndiaPayslipData;
  itrYears: IndiaItrYear[];
};

// A user-defined recurring bill/expense/income (rent, a subscription, an EMI, an insurance
// premium) that either gets auto-detected during Plaid import (if plaidMatch is set, same
// institution+amount matching the mortgage/payroll detection already do) or shows up in the
// Recurring report's "due this period" list for one-click manual posting.
export type RecurringTemplate = {
  id: string;
  label: string;
  active: boolean;
  frequency: "monthly" | "yearly";
  dayOfMonth?: number; // informational "usually due on the Nth" -- not used to gate visibility
  voucherType: string;
  narrationTemplate: string; // e.g. "{month} rent" -- {month}/{year} interpolated at post time
  entries: { accountId: number; amount: number }[]; // fixed amount, signed like Entry (negative = debit)
  plaidMatch?: { institutionPattern: string; amountTolerance: number };
  // Persisted link from a period to the voucher that satisfied it -- generalizes PayrollMatch's
  // period->txGuid link (above) to any recurring template, not just payroll.
  postings: { periodKey: string; txGuid: string; postedAt: string }[];
};

export type BudgetLine = {
  id: string;
  accountId: number;
  monthly: number[]; // 12 values, index 0 = Apr .. 11 = Mar, aligned to the FY's monthly
                      // columnar periods (lib/columnar-report.ts). Positive = budgeted amount.
};

// One fiscal year's budget -- generatedFromFy records which prior FY's actuals were used to
// seed `lines` (see lib/budget.ts's generateBudgetFromActuals), purely informational.
export type Budget = {
  fy: string; // e.g. "2026" -- same Apr-start FY convention as VaultApp's `year` state
  lines: BudgetLine[];
  generatedFromFy?: string;
  updatedAt: string;
};

// A depreciable physical asset (laptop, furniture, vehicle) -- straight-line depreciation only.
// No schedule is persisted, just the inputs; book value/accumulated depreciation are derived at
// render time from these (lib/fixed-assets.ts). accountId is the asset's own "Fixed Assets"-group
// ledger account (its cost shows in the trial balance/balance sheet like any other asset);
// depreciation postings hit two shared accounts ("Depreciation Expense"/"Accumulated
// Depreciation"), not a per-asset pair.
export type FixedAsset = {
  id: string;
  name: string;
  accountId: number;
  // Asset Class/Group (SAP/Oracle/Rillet-style categorization, e.g. "Vehicles", "IT Equipment",
  // "Furniture & Fixtures") -- purely a grouping/reporting label, not tied to any GL account or
  // depreciation math. Optional so existing assets added before this field existed still work.
  assetClass?: string;
  purchaseDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  // "YYYY-MM" of the last month a depreciation Tx was posted for this asset -- undefined means
  // none posted yet (depreciation starts accruing from purchaseDate's month).
  lastDepreciatedThrough?: string;
  disposed?: { date: string; proceeds: number; txGuid?: string };
  // Set only when this asset was created via "Sync tagged assets" (lib/fixed-assets-ledger.ts's
  // discoverTaggedAssetGroups) rather than the manual "+ Add Asset" form -- identifies which
  // (accountId, Entry.assetTag) group funds it, so a later sync can find and update it (cost grows
  // as new tagged entries post) instead of creating a duplicate. Absent for manually-added assets,
  // whose cost/purchaseDate the user typed directly rather than derived from tagged entries.
  sourceAccountId?: number;
  sourceTag?: string;
};

// A prepaid expense (an annual insurance premium, a subscription paid upfront) -- same
// straight-line "spread a cost over N months" shape as FixedAsset, but simpler: no salvage
// value (always fully expenses) and no disposal-with-proceeds, just an optional early write-off
// of whatever's left. accountId is its own "Current Assets"-group ledger account (the unamortized
// balance); expenseAccountId is the specific expense account monthly amortization posts against
// (unlike FixedAsset, there's no shared pool account -- each prepaid item hits its own expense
// category). See lib/prepaid-expense.ts.
export type PrepaidExpense = {
  id: string;
  name: string;
  accountId: number;
  expenseAccountId: number;
  startDate: string;
  totalAmount: number;
  termMonths: number;
  lastAmortizedThrough?: string;
  writtenOff?: { date: string; txGuid?: string };
};

// A loan (car loan, personal loan, a second mortgage) with auto-computed principal/interest
// amortization -- distinct from FixedAsset/PrepaidExpense in that a payment is a real cash event,
// not a non-cash accrual to backfill on a schedule, so there's no "run pending months" poster;
// see lib/loans.ts/lib/loans-ledger.ts's recordLoanPayment (one real payment at a time). Current
// balance is never stored -- always computed live via ledgerBalanceAsOf(data, accountId, asOfDate)
// from whatever's actually posted to accountId, the same self-correcting approach
// lib/mortgage-amortization.ts's currentMortgageBalance already uses for the one real mortgage
// that file tracks (deliberately kept separate from this general register -- see that file's own
// comments). accountId is a Liability-nature account under "Loans (Liability)";
// interestExpenseAccountId is the target expense account each payment's interest portion posts
// against.
export type Loan = {
  id: string;
  name: string;
  accountId: number;
  interestExpenseAccountId: number;
  originalPrincipal: number;
  annualRate: number;
  termMonths: number;
  startDate: string;
  standardPayment: number;
  // Date through which `annualRate` is confirmed accurate. Optional fallback for an
  // adjustable-rate loan whose reset terms (below) aren't known -- when set (and rateAdjustment is
  // NOT set), the projected schedule stops rolling forward past this date instead of silently
  // assuming the current rate holds indefinitely.
  rateValidThrough?: string;
  // The actual contractual reset terms for an adjustable-rate loan (straight from the Note's
  // "Interest Rate and Monthly Payment Changes" section), used to project a worst-case (rate
  // always moves to the cap) future schedule instead of just flagging the rate as unknown -- the
  // real post-reset rate depends on a future market index value and can't be known in advance, but
  // the CONTRACTUAL CEILING at each reset is spelled out in the Note and is knowable today.
  rateAdjustment?: {
    firstChangeDate: string; // e.g. "2028-01-01"
    changeIntervalMonths: number; // e.g. 60 for a 5-year-interval ARM
    firstChangeCapPct: number; // max rate (%) allowed at the first change, e.g. 4.875
    periodicCapPct: number; // max +/- (percentage points) per change after the first, e.g. 2.0
    lifetimeCapPct: number; // absolute max rate (%) over the life of the loan, e.g. 7.875
    lifetimeFloorPct: number; // absolute min rate (%) over the life of the loan, e.g. 2.375
  };
  closed?: { date: string; txGuid?: string };
};

export type TallyLedgerSnapshot = {
  asOf: string;
  balances: { name: string; parent?: string; closingBalance: number }[];
};

export type Ledger = {
  version: number;
  company: string;
  // Optional company profile fields (Masters > Settings), shown on the voucher print view and
  // usable as the default sender letterhead for the Balance Confirmation Letter -- same generic
  // "company details" block any ERP's settings screen has, absent here until now.
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  currency: string;
  createdAt: string;
  accounts: Account[];
  transactions: Tx[];
  groups?: MasterGroup[];
  currencies?: string[];
  voucherTypes?: string[];
  fiscalYearStartMonth?: number;
  // Standard ERP-style period close: vouchers dated in a closed period ("YYYY-MM" keys, e.g.
  // "2026-08") cannot be newly created, edited, or deleted (see findClosedPeriodViolations in
  // lib/vault-accounting.ts). Any combination of periods can be closed independently -- there's
  // no requirement to close in sequence, so e.g. March can stay open while January is closed.
  // Undefined/empty = nothing closed. Reads/reports are never affected -- this only gates save().
  closedPeriods?: string[];
  equity?: EquityData;
  payroll?: PayrollData;
  indiaTax?: IndiaTaxData;
  tallyLedgerSnapshot?: TallyLedgerSnapshot;
  trades?: Trade[];
  // Retirement money moved into a private/illiquid investment that Plaid can't see (e.g. a
  // portion of a Merrill IRA put into a private deal) -- manually entered and updated on the
  // Retirement tab, added into "Current balance" alongside the live Fidelity/Merrill figures.
  // Deliberately NOT tied to any ledger account balance: the account holding this money (if one
  // exists) may also contain non-retirement capital, so only the user-entered retirement portion
  // counts here.
  retirementOtherInvestments?: { id: string; label: string; amount: number }[];
  // Per-fiscal-year budgets for the Budget vs Actual report, one entry per FY the user has
  // budgeted. See lib/budget.ts for how these are generated/compared against actuals.
  budgets?: Budget[];
  // User-defined recurring bills/expenses/income. See lib/recurring.ts.
  recurringTemplates?: RecurringTemplate[];
  // Change history for vouchers and master data. See lib/audit.ts. Capped to the most recent
  // 5000 entries (appendAuditEntry trims the oldest) to bound blob growth over years of use.
  auditLog?: AuditEntry[];
  // Manual "this will never have a match, stop flagging it" overrides for the Bank Reconciliation
  // report -- e.g. a cash transaction with no corresponding Plaid line, or a known one-off Plaid
  // entry (a bank fee) the user doesn't book as a voucher. See lib/plaid-recon.ts.
  bankReconExceptions?: BankReconException[];
  // Depreciable physical assets tracked in the Fixed Asset Register. See lib/fixed-assets.ts.
  fixedAssets?: FixedAsset[];
  // Prepaid expenses amortized over time. See lib/prepaid-expense.ts.
  prepaidExpenses?: PrepaidExpense[];
  // Loans tracked in the Loan/Debt Register. See lib/loans.ts.
  loans?: Loan[];
};

export type BankReconException = {
  // "v:<txGuid>" for a vault voucher, or "p:<plaid_account_id>:<plaid_transaction_id>" for a
  // Plaid-side transaction -- one flat namespaced key so both sides share one array.
  key: string;
  label: string; // snapshot of what this was, so the exceptions list stays readable later
  markedAt: string;
};

export type AuditEntry = {
  id: string;
  at: string; // ISO timestamp
  entity: "voucher" | "account" | "group";
  entityId: string; // Tx.guid, or Account.id / MasterGroup.name as a string
  action: "created" | "edited" | "deleted" | "restored";
  summary: string; // human-readable one-liner, e.g. "Amount changed from $100.00 to $150.00"
  // Shallow field-level diff only, not full before/after snapshots -- keeps entries small since
  // this array lives inside the same single encrypted vault blob re-saved on every change.
  changes?: { field: string; before: unknown; after: unknown }[];
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
