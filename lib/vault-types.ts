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
  // Set once, at creation, when this voucher was saved directly from a real Plaid bank
  // transaction (the Bank Reconciliation "Save pending" bulk-import path) -- the permanent
  // "this is backed by an actual bank record" marker. Deliberately NOT syncStatus: that field
  // gets overwritten to "synced" the first time Tally sync runs (tools/tally-sync/apply-one-
  // app-change.js), which would silently erase the Plaid origin the moment the voucher synced.
  plaidTxId?: string;
  // Set once, at creation, when this voucher was saved via "Reverse" against another voucher
  // (see useVoucherForm.ts's reverseVoucher) -- the id (Tx.id, not guid) of the voucher it
  // reverses. A reversal pair nets to zero and reflects no real money movement, so neither leg
  // can ever legitimately match a Plaid bank transaction -- TransactionTable.tsx's isReconciled
  // treats both the reversal and the original it points to as reconciled on this basis alone, so
  // the Day Book's "Unreconciled only" filter doesn't permanently clutter up with pairs that were
  // never going to post to the bank in the first place (e.g. an order that showed as Plaid-
  // pending, got posted, then never actually shipped/settled).
  reversalOf?: number;
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
  // Mailing address and email for this ledger's counterparty (bank, loan, sundry debtor/
  // creditor, ...) -- lets the Balance Confirmation Letter pull a recipient's details from
  // Masters instead of retyping them per letter. Editable there too; a per-letter edit only
  // overrides that one letter, it doesn't write back to the master record.
  address?: string;
  email?: string;
  // Real-world banking detail for a Bank-nature account (covers both plain bank accounts AND
  // credit cards -- this app nests credit cards under the same "Bank Accounts" group). Useful on
  // its own as a reference, and specifically what FinCEN Form 114 Part III asks for per account
  // (Name of Financial Institution, Account Number, Mailing Address -- the last of which already
  // has a home in the `address` field above, shared with Balance Confirmation Letters).
  bankAccountNumber?: string;
  bankIfscOrRouting?: string; // IFSC for an Indian bank, routing number for a US one
  bankSwiftCode?: string;
  bankBranch?: string;
  // City/State/Postal split out separately from `address` (which stays the street line) because
  // FinCEN Form 114 Part II asks for them as distinct boxes (Items 19-23) -- same reasoning as
  // Ledger.fbarFilerProfile's own split fields, since guessing how to split a single free-text
  // address back apart isn't safe on an actual government filing. Country defaults to "India" at
  // export time (lib/fbar-pdf.ts) when unset, since the FBAR Worksheet only applies to the India
  // book, but can be overridden here for an account actually held elsewhere.
  bankCity?: string;
  bankState?: string;
  bankPostalCode?: string;
  bankCountry?: string;
  // How this account should be treated by the FBAR Worksheet (components/reports/FbarReport.tsx),
  // remembered on the account itself so the choice carries forward to next year automatically
  // instead of needing to be redone at every filing. Undefined = "include" (the default: use this
  // ledger's own computed peak balance, correct for a real bank/investment account). "exclude" is
  // for a ledger that tracks something other than an actual account value (e.g. a premium-payment
  // ledger like "LIC Premium" -- the premiums paid aren't themselves a reportable balance).
  // "manual" is for an account whose real reportable value (e.g. a life insurance policy's cash
  // surrender value) isn't what this ledger's own balance reflects, but IS still a real foreign
  // financial account that needs reporting -- see fbarManualValuesInr below for the actual figure.
  fbarTreatment?: "include" | "exclude" | "manual";
  // Only read when fbarTreatment === "manual" -- the account's real reportable value in INR, for
  // the specific calendar year a figure was entered for (keyed "YYYY", since a cash surrender
  // value changes every year and last year's number silently going stale would be a real risk).
  fbarManualValuesInr?: Record<string, number>;
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
  // "FIT Taxable Wages" straight off an uploaded paystub PDF's own Pay Summary table -- a truer
  // Box 1 (W-2 "Wages, tips, other comp") figure than Gross, since it already excludes 401(k)
  // and Section 125 (medical/dental/vision) but still includes imputed-income lines this app
  // doesn't separately itemize (e.g. group-term-life over $50k). Undefined for Excel-imported or
  // pre-this-feature periods, which have no such figure to draw from -- see W2Preview's own
  // fallback formula for those. See lib/parse-paystub-pdf.ts's ParsedPaystub.fitTaxableWages.
  fitTaxableWages?: number;
  // Sum of every Deductions-table row a real uploaded paystub had that this app has no
  // dedicated bucket for (e.g. "RSU Excess Tax") -- see lib/parse-paystub-pdf.ts's
  // otherAdjustments. Negative when it's net a credit/addback to pay, same sign convention as
  // every other deduction field here. Undefined for Excel-imported or pre-this-feature periods.
  otherAdjustments?: number;
  // The real row name(s) behind otherAdjustments (e.g. "RSU Excess Tax"), comma-joined when a
  // paystub had more than one -- lets the period-view modal show the actual label instead of a
  // generic "Other Adjustments". Purely descriptive, never read for any calculation.
  otherAdjustmentsLabel?: string;
};

// Real tax withheld on a specific RSU vesting event, entered from the actual "stock-only"
// off-cycle pay-stub(s) NVIDIA issues for it -- one separate PDF per RSU lot vesting the same
// day, so `federal`/`ssn`/etc. here are the SUM across however many of those were uploaded for
// this date, not any single one. Keyed by the vest date (matches TaxReport's vestGroups[].date)
// rather than by a stockIdx, since stockIdx is recomputed at render time from the current vest
// list and could shift if an earlier grant is added later -- the date is what's actually stable.
// Overrides the Excel-imported "Stocks" column figure for that vest entirely once it exists
// (not added on top of it): a fresh vest usually has no Excel figure yet at all.
export type ManualVestTax = {
  date: string;    // YYYY-MM-DD, the vest date
  federal: number;
  ssn: number;
  medicare: number;
  stateWH: number;
  stateSDI: number;
  totalTax: number;
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
  // Every employer that paid during this calendar year -- read from the source workbook's own
  // "Summary" sheet (Year/Employer header rows), when present. A job change mid-year means a
  // "Yearly <YYYY>" sheet can genuinely fold TWO employers' periods together (e.g. ["TechM",
  // "Accrete"] for 2017) -- an array, not a single string, so a transition year is never
  // misrepresented as belonging to only whichever employer happened to be listed first.
  employers?: string[];
  periodLabels: string[]; // e.g. ["Jan 01 Jan 15", "Jan 16 Jan 31", ...]
  rows: PayrollRow[];
  matches?: PayrollMatch[];
  manualPeriods?: ManualPayrollPeriod[];
  manualVestTax?: ManualVestTax[];
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
  // Reference-only record of exempt income for this AY (e.g. LIC/insurance maturity proceeds
  // exempt under Section 10(10D), PPF interest, agricultural income) -- NEVER added to
  // grossTotalIncome/totalIncome/taxPayable anywhere in this app; purely a durable place to note
  // "I earned this much but it's genuinely tax-free" for your own records. Real ITR filings still
  // disclose exempt income separately (Schedule EI) even though it isn't taxed, since a large
  // undeclared bank credit can otherwise trigger an AIS mismatch notice -- this field exists so
  // that figure has a permanent home here instead of only living in a popup's own transient note.
  exemptIncome?: number;
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
  frequency: "monthly" | "bimonthly" | "quarterly" | "halfyearly" | "yearly" | "custom";
  // Only meaningful for frequency "custom" -- the number of months between occurrences (e.g. 4
  // for a bill due every 4 months). monthly/bimonthly/quarterly/yearly each have a fixed interval
  // (1/2/3/12) and ignore this field.
  intervalMonths?: number;
  // "YYYY-MM" -- a month known to be on-cycle, so lib/recurring.ts's period buckets (and, for
  // YEARLY, the due-month gate in dueTemplates()) land on the bill's own real cycle instead of an
  // arbitrary offset from whenever the template happened to be created. For bimonthly/quarterly/
  // custom this anchors which months the N-month buckets fall on (e.g. a quarterly bill last due
  // July anchors to "2026-07" so buckets fall Jan/Apr/Jul/Oct). For YEARLY, only the month part is
  // used -- it's the month the bill is actually due (e.g. "2024-12" for a December home insurance
  // renewal), so dueTemplates() doesn't flag it as due starting every January 1st. Ignored by
  // monthly, which needs no anchor (every month is its own period regardless).
  anchorMonth?: string;
  // "Usually due on the Nth" -- for a MONTHLY (or bimonthly/quarterly/custom/yearly-with-
  // anchorMonth) template, this gates when dueTemplates() starts flagging it (see
  // lib/recurring.ts): due from this day of the month onward, not from the 1st -- for a
  // multi-month cycle, checked against the LAST month of that cycle's period, not its first; for
  // YEARLY, checked against its anchorMonth. A YEARLY template with no anchorMonth set has no
  // known due month to gate against, so it stays due for the whole year once unposted.
  dayOfMonth?: number;
  // Extra days to wait past dayOfMonth before dueTemplates() actually flags it -- for a bill whose
  // real due day jitters a bit cycle to cycle (confirmed live: PG&E's autopay date moved between
  // the 27th and 29th across three cycles), this keeps dayOfMonth itself set to the bill's true
  // usual due day (meaningful on its own, e.g. for display) while absorbing that jitter separately
  // instead of either flagging a day or two early some cycles, or padding dayOfMonth itself out
  // and losing what day the bill is actually due on. Ignored when dayOfMonth isn't set.
  graceDays?: number;
  voucherType: string;
  narrationTemplate: string; // e.g. "{month} rent" -- {month}/{year} interpolated at post time
  entries: { accountId: number; amount: number }[]; // fixed amount, signed like Entry (negative = debit)
  plaidMatch?: { institutionPattern: string; amountTolerance: number };
  // Persisted link from a period to the voucher that satisfied it -- generalizes PayrollMatch's
  // period->txGuid link (above) to any recurring template, not just payroll.
  postings: { periodKey: string; txGuid: string; postedAt: string }[];
};

// How a paycheck's net deposit actually splits across bank accounts -- mirrors the employer
// payroll portal's own "direct deposit" setup (account, fixed $ amount or "available balance" /
// remainder, active/archived), so this is user-editable in Masters instead of hardcoded constants
// in the Plaid import composer that needed a code change + redeploy every time the real-world
// split changed. Exactly one ACTIVE split should be "remainder" at a time (the account that
// receives whatever's left after every active "fixed" split is subtracted) -- the UI warns, but
// doesn't hard-block, more than one.
export type PayrollDirectDepositSplit = {
  id: string;
  accountId: number;
  amountType: "fixed" | "remainder";
  amount?: number; // only meaningful for amountType "fixed"
  active: boolean;
};

// One line item on a real Costco receipt, as captured straight from Costco's own order-history
// API (see tools/costco-receipts/) -- NOT derived or guessed from Day Book narration. `amount` is
// what was actually paid for this line (qty x unit price), always positive; a return/adjustment
// line is dropped during import rather than carried as a negative amount here.
export type CostcoReceiptItem = {
  itemNumber: string;
  description: string;
  amount: number;
  qty: number;
};

// One real Costco receipt (one till transaction), imported via Masters -> Costco Receipts. The
// one real source for BOTH the Executive 2% Reward calculation and the Price Match Watchlist --
// see lib/costco-receipts.ts -- instead of guessing either from voucher narration the way
// lib/costco-reward.ts's older estimate still does for periods with no receipt on file.
export type CostcoReceipt = {
  // Stable identity (warehouse+register+transaction number+date) so re-importing the same
  // receipt from a later capture run never creates a duplicate -- MUST stay in sync with
  // receiptKey() in tools/costco-receipts/parse.mjs, the only thing that generates these.
  key: string;
  cardholder: string; // whichever --label/--profile the capture was run under (e.g. "dignesh")
  date: string; // YYYY-MM-DD
  warehouse: string;
  receiptType: string; // Costco's own field verbatim -- "In-Warehouse", "Gas Station", etc.
  total: number;
  items: CostcoReceiptItem[];
};

// A real, live current-price lookup against costco.com for one item, produced by
// tools/costco-receipts/check-prices.mjs (driven through an already-authenticated Chrome session
// -- no generic web search, which proved unreliable/stale when tried). `currentPrice` is null
// either because costco.com had no clean single-product match for the search (ambiguous results)
// or because `notSoldOnline` is true (the item is warehouse-only, confirmed by a zero-result
// search -- common for fresh produce/grocery, nothing to look up online in that case).
export type CostcoPriceCheck = {
  itemNumber: string;
  description: string;
  pricePaid: number;
  currentPrice: number | null;
  // "warehouse" = Costco's own real in-store/pickup price at the account's "My Warehouse" setting
  // (confirmed live to genuinely differ from online pricing) -- always preferred when available.
  // "estimated-warehouse" = no real warehouse price was available, but the item is clothing/shoes
  // -- per the user's own real shopping experience, in-warehouse apparel/shoe pricing typically
  // runs about $2 under online, so the online price minus $2 is used as the estimate instead of
  // the raw online figure. "online" = plain ship-to-home/delivery price, used only when neither
  // of the above applies. null = currentPrice itself is null (not checked, no match, or not sold
  // online).
  priceSource?: "warehouse" | "estimated-warehouse" | "online" | null;
  currentPriceWarehouse?: string | null;
  notSoldOnline: boolean;
  priceDropped: boolean;
  checkedAt: string;
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
  // Optional override for when depreciation actually starts accruing, distinct from
  // `purchaseDate` (which for a tagged asset is always re-derived as the earliest tagged
  // transaction's date -- e.g. an earnest-money deposit -- and gets silently overwritten back to
  // that on every future re-sync, so a manual edit to `purchaseDate` itself would never stick).
  // Real-world case this exists for: a home's EMD/down-payment vouchers predate actual
  // possession/move-in by months, but depreciation should only start once the asset is genuinely
  // placed in service. Undefined means "same as purchaseDate" -- see depreciationStartDate in
  // lib/fixed-assets.ts, the one place this should ever be read from.
  inServiceDate?: string;
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
  // Costco Executive Membership's renewal month/day ("MM-DD", e.g. "08-31", Masters > Settings)
  // -- powers the Costco Executive 2% Reward estimate on the Spend report (see
  // lib/costco-reward.ts). Deliberately no year: under normal renewal the month/day is fixed
  // year over year, so this is meant to be set once, not bumped every renewal. Costco calculates
  // that reward on a window ending ~3 months BEFORE this date each year, not the membership year
  // itself (confirmed against Costco's own Executive 2% Reward FAQ and the member's own renewal
  // notice, which opens exactly 3 months early).
  costcoMembershipRenewalMonthDay?: string;
  // One-time calibration against Costco's OWN stated "Rewards earned since" date on the member's
  // account page (Masters > Settings) -- a real-world check (member's own account, 2026-10-26)
  // found the CURRENT cycle's true start 11 days earlier than the clean 12-months-before-the-
  // cutoff date computeCostcoRewardWindow assumes ("earned since 05/20/2026" vs. the computed
  // 05/31/2026), with no known reason for the gap (a past renewal quirk? how Costco's own system
  // rounds the first qualifying purchase?) -- not something to guess-generalize into the window
  // formula itself. Only ever applied to the CURRENT (in-progress) cycle in SpendReport.tsx, never
  // to listPastCostcoRewardCycles's own walked-back past cycles, since there's no evidence the
  // same 11-day gap applies to those too. Undefined = use the computed start, unchanged.
  // The REAL reward figure, typed in straight from the member's own Costco account page
  // (costco.com -> Account -> Membership Information shows "Estimated 2% Reward" directly) --
  // simplest, most honest ground truth there is, and zero receipt-clicking required to get it.
  // Purely a reference display next to the app's own narration/receipt-based estimates on Spend
  // Report; never computed from anything else, never overwritten automatically.
  costcoActualReward?: { amount: number; asOfDate: string };
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
  // Estimated monthly Social Security benefit at each claiming age, manually copied from the
  // annual SSA statement -- a reference figure only (no ledger posting, no reconciliation), same
  // treatment as retirementOtherInvestments above. statementDate is when that SSA statement was
  // issued, so a stale estimate is visible rather than silently assumed current.
  socialSecurityEstimate?: { at62?: number; atFullRetirement?: number; at70?: number; statementDate?: string };
  // Per-fiscal-year budgets for the Budget vs Actual report, one entry per FY the user has
  // budgeted. See lib/budget.ts for how these are generated/compared against actuals.
  budgets?: Budget[];
  // User-defined recurring bills/expenses/income. See lib/recurring.ts.
  recurringTemplates?: RecurringTemplate[];
  // Account-pair keys ("${debitAccountId}|${creditAccountId}") the user explicitly said NOT to
  // suggest again from Masters -> Recurring's "Scan for recurring bills" (lib/recurring-detect.ts)
  // -- without this, a re-scan would keep re-proposing the same irrelevant pattern (e.g. two
  // coincidentally similar-interval but unrelated transactions) every time.
  dismissedRecurringCandidates?: string[];
  // How a paycheck's net deposit splits across bank accounts, editable in Masters -> Direct
  // Deposit -- see PayrollDirectDepositSplit above. Empty/unset falls back to depositing the
  // whole paycheck in whichever account the Plaid transaction's own institution matches.
  payrollDirectDeposit?: PayrollDirectDepositSplit[];
  // Real itemized Costco receipts imported from Masters -> Costco Receipts. See CostcoReceipt's
  // own comment and lib/costco-receipts.ts.
  costcoReceipts?: CostcoReceipt[];
  // Real, live current-price lookups imported from Masters -> Costco Receipts. See
  // CostcoPriceCheck's own comment and lib/costco-receipts.ts.
  costcoPriceChecks?: CostcoPriceCheck[];
  // Watchlist rows the user has already taken the real in-store price adjustment for -- keyed
  // "<itemNumber>|<date>" (not itemNumber alone, since the same item bought on two different
  // dates needs to be tracked separately; see costcoClaimKey in lib/costco-receipts.ts). Marked
  // from the Price Match Watchlist itself (Spend report) so an already-refunded item stops
  // showing as an open "match" and isn't double-counted in Total potential savings.
  costcoPriceMatchClaimed?: string[];
  // Change history for vouchers and master data. See lib/audit.ts. Capped to the most recent
  // 5000 entries (appendAuditEntry trims the oldest) to bound blob growth over years of use.
  auditLog?: AuditEntry[];
  // Manual "this will never have a match, stop flagging it" overrides for the Bank Reconciliation
  // report -- e.g. a cash transaction with no corresponding Plaid line, or a known one-off Plaid
  // entry (a bank fee) the user doesn't book as a voucher. See lib/plaid-recon.ts.
  bankReconExceptions?: BankReconException[];
  // Ledger account ids whose vouchers should always show "Reconciled", regardless of any
  // per-voucher Plaid match -- for accounts where Plaid only ever exposes a balance, never a
  // transaction feed to match against (HSA/401k-type accounts, per ReconAccountStatus's
  // noPlaidTransactionFeed in lib/plaid-recon.ts), or that aren't Plaid-connected at all
  // (Schwab brokerage, its own separate direct-API sync). The account's balance is the real
  // source of truth in both cases, not a per-transaction match this app can ever produce. See
  // TransactionTable.tsx's isReconciled.
  alwaysReconciledAccountIds?: number[];
  // Voucher guids the user has explicitly reviewed and confirmed correct in the Categorization
  // Review report (components/reports/CategorizationReview.tsx) -- a one-off word coincidence the
  // audit's heuristic can't distinguish from a real miscategorization (e.g. a person's name
  // shared with an unrelated ledger's vouchers). Suppresses that one voucher from future audit
  // runs without changing anything about the voucher itself; see lib/categorization-audit.ts.
  categorizationReviewDismissed?: string[];
  // Depreciable physical assets tracked in the Fixed Asset Register. See lib/fixed-assets.ts.
  fixedAssets?: FixedAsset[];
  // Prepaid expenses amortized over time. See lib/prepaid-expense.ts.
  prepaidExpenses?: PrepaidExpense[];
  // Loans tracked in the Loan/Debt Register. See lib/loans.ts.
  loans?: Loan[];
  // User-dismissed Cash Flow Forecast living-expense categories (e.g. a one-time class fee
  // that's now paid off) -- excluded from the trailing-average projection until the user
  // re-includes them, since the trailing history alone can't tell "finished, one-time" apart
  // from "still recurring, just slow this window". See lib/cash-flow-forecast.ts.
  cashFlowForecastExclusions?: string[];
  // Plaid connections that failed on their most recent fetch (e.g. ITEM_LOGIN_REQUIRED after a
  // bank forces a password reset) -- persisted here purely so this can surface in Needs Attention
  // even when the user hasn't revisited Import -> Plaid since the failure. Populated/cleared as a
  // side effect of PlaidImport's own on-demand fetch (see components/vault/PlaidImport.tsx);
  // nothing here ever triggers a new Plaid API call on its own.
  plaidConnectionIssues?: { itemId: string; institutionName: string; errorMessage?: string; detectedAt: string }[];
  // A personal document library (pay stubs, RSU/stock grant agreements, offer letters, ...) --
  // stored purely for later reference, no ledger posting or reconciliation tied to any entry.
  // Same "metadata in the vault, bytes in R2" split as Tx.attachments above; see VaultDocument.
  documents?: VaultDocument[];
  // ISO timestamp of the last time the user clicked "Download backup" (see VaultApp.tsx's
  // downloadVaultBackup) -- purely informational, drives the overdue-backup reminder dot on the
  // settings gear icon. Never set any other way; undefined means "never backed up".
  lastBackupAt?: string;
  // Filer's own identity details for FinCEN Form 114 (FBAR) Part I -- has nothing to do with
  // ledger accounts, entered once in Masters > Settings so the FBAR Worksheet's pre-filled PDF
  // export (see components/reports/FbarReport.tsx, lib/fbar-pdf.ts) doesn't need these re-typed
  // every filing year. Lives in the same encrypted vault blob as everything else here (e.g. bank
  // account numbers on Account), same protection level, nothing extra.
  // Name/address are split into the form's own fields (not one free-text blob) deliberately --
  // the FBAR XFA data model needs FirstName/LastName/etc and Address/City/State/ZIP as separate
  // XML elements, and parsing a free-text name or address back into those parts reliably isn't
  // possible, which on an actual government filing is a real-accuracy risk, not just cosmetic.
  fbarFilerProfile?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    suffix?: string;
    ssnOrItin?: string; // digits only, no dashes -- FinCEN's own form strips formatting anyway
    dateOfBirth?: string; // "YYYY-MM-DD"
    street?: string;
    city?: string;
    state?: string; // 2-letter USPS code
    zip?: string;
    country?: string; // defaults to "United States" in the UI
  };
  // Self-service fallback for a calendar year not yet in lib/fbar.ts's own hardcoded, reviewed
  // TREASURY_YEAR_END_RATE_INR table (Treasury typically publishes the Dec 31 rate a few weeks
  // into the following January) -- entered once in Masters > Settings, keyed "YYYY" -> INR per
  // USD. Only ever consulted when the hardcoded table has no entry for that year; it can never
  // override a year already reviewed and locked in there. Exists so a new year's FBAR Worksheet
  // doesn't need a code change/redeploy (or this app's developer being reachable) just to add one
  // published number -- the user can type it in directly once Treasury publishes it.
  fbarManualTreasuryRates?: Record<string, number>;
};

// One archived personal document (pay stub, RSU grant agreement/award notice, offer letter, ...).
// File bytes live in R2 under `${book}/documents/...` (see app/api/attachments/route.ts) -- only
// this small metadata record lives in the encrypted vault blob, same split as Attachment/Tx.
export type VaultDocument = {
  id: string;
  category: "Pay Stub" | "Grant Agreement" | "Grant Award" | "Offer Letter" | "Other";
  label: string;
  // Optional date the document is "about" (a pay period, a grant date) -- distinct from
  // uploadedAt below, which is just when the file was archived here.
  date?: string;
  key: string;
  filename: string;
  size: number;
  contentType: string;
  uploadedAt: string;
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
