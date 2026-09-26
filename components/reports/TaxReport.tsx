"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PayrollData, PayrollRow, PayrollYear, Tx, EquityData, ManualPayrollPeriod, ManualVestTax, RsuGrant, RsuVest, EsppPurchase, Account, VaultDocument, Trade } from "@/lib/vault-types";
import { apiFetch } from "@/lib/api-fetch";
import { trimPdfToFit } from "@/lib/trim-pdf";
import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/document-limits";
import { findPayrollVoucher, findAllPayrollVouchers, parsePeriodRange, findUncoveredSalaryVouchers, estimateManualPeriod, generateStandardPeriodLabels, normalizePayrollYear, matchPayrollPeriod, inferPeriodLabel } from "@/lib/payroll-match";
import type { ParsedPaystub } from "@/lib/parse-paystub-pdf";
import { StatIcon, type IconKind } from "@/components/Icon";
import { DonutChart, type DonutSegment } from "@/components/DonutChart";
import { VoucherTypeBadge, VoucherFlow } from "@/components/VoucherVisual";
import { FloatingWindow as Modal } from "@/components/FloatingWindow";
import { useUiPrefs } from "@/hooks/useUiPrefs";
import { classifyRsuSales, classifyEsppSales, classifyTradingSales, summarizeCapitalGains, sumInterestDividendIncome } from "@/lib/tax-classify";
import { estimateUsFederalTax, computeItemizedDeduction, computeHsaDeduction, type HsaCoverage } from "@/lib/tax-usa-engine";
import { listUsTaxYears, type UsFilingStatus } from "@/lib/tax-usa-rules";
import { matchDeductionLedgers, deductionTotal, findHsaContributions } from "@/lib/tax-deductions";
import { estimateCaStateTax, computeCaItemizedDeduction } from "@/lib/tax-ca-engine";
import { resolveCaTaxRules } from "@/lib/tax-ca-rules";
import { estimateNjStateTax, computeNjPropertyTaxDeduction } from "@/lib/tax-nj-engine";
import { estimateAzStateTax, computeAzItemizedDeduction } from "@/lib/tax-az-engine";
import { resolveStateResidency } from "@/lib/tax-state-residency";
import { computeTaxPlanningScenarios } from "@/lib/tax-planning";
import { compute401kByYear } from "@/lib/payroll-401k";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { AutoFitAmount } from "@/components/AutoFitAmount";

interface TaxReportProps {
  payroll: PayrollData | undefined;
  transactions: Tx[];
  equity: EquityData | undefined;
  accounts: Account[];
  // Closed brokerage-trade positions (Reports > Trading) -- realized gain/loss on non-employer
  // stock, a real taxable capital gain source alongside RSU/ESPP sales.
  trades: Trade[] | undefined;
  // newDocument is set when "Upload Paystub PDF" is being confirmed -- the PDF itself is
  // archived into Masters > Documents (see archivePaystubDocument below) in the SAME save as
  // the extracted numbers, not a separate trip.
  onSave: (payroll: PayrollData, newDocument?: VaultDocument) => Promise<boolean | void>;
  onViewVoucher: (tx: Tx) => void; // only used for the explicit "Edit in Daybook" action inside the voucher popup
  // Jumps to Masters > Documents, where archived pay stub PDFs live.
  onViewDocuments?: () => void;
  // Needed only to key the archived PDF's R2 path the same way Masters > Documents does (see
  // app/api/attachments/route.ts) -- every other use of this report works off `payroll` alone.
  book: "us" | "india";
  fmt: (n: number) => string;
  readOnly?: boolean;
  livePrice?: number | null;
}

function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

function at(r: PayrollRow | undefined, i: number): number {
  return r?.values[i] ?? 0;
}

// A linked voucher was previously trusted purely by DATE match -- its actual dollar amount
// was never compared to the expected payroll Net Salary, so a wrongly-linked or mistyped
// voucher (e.g. today's swapped-GUID incident) would show a plain, unflagged link with no
// indication anything was off.
//
// A payroll Receipt's debit side is NOT just the bank account(s) -- deduction lines (Tax,
// Health Insurance, 401K, Legal Plan) are debited the same way the destination bank is
// (vault convention: negative = debit, positive = credit). Summing every negative entry
// would give the gross-ish total, not the real net deposit. Only entries whose account is
// an actual bank/cash account count -- same category pattern isCashBank() uses in
// components/VaultApp.tsx.
function voucherNetAmount(tx: Tx, accounts: Account[]): number {
  const bankIds = new Set(
    accounts.filter((a) => /^(bank accounts|cash-in-hand)$/i.test(a.parent || "")).map((a) => a.id)
  );
  return -tx.entries
    .filter((e) => e.amount < 0 && bankIds.has(e.accountId))
    .reduce((s, e) => s + e.amount, 0);
}

// Reads the employer straight off the linked voucher's own ledger name ("Salary Income - X")
// so the period popup can show which job a given paycheck came from -- useful across a job
// change or an old employer's history, where periods sit side by side with different employers.
function employerFromVoucher(tx: Tx): string | null {
  const entry = tx.entries.find((e) => /salary income/i.test(e.accountName || ""));
  if (!entry) return null;
  const m = (entry.accountName || "").match(/salary income\s*-\s*(.+)/i);
  return m ? m[1].trim() : null;
}

// Fixed color per component (not palette-cycled) so a given slice means the same thing across
// every paystub you open -- comparing periods side by side relies on Federal always being red,
// Net always being green, etc. Take-home is computed as the REMAINDER (gross minus every other
// slice), not read from a separately-stored "net" figure -- this app has more than one "Net"
// concept on a paystub (e.g. "Net Salary" is gross minus tax only, before 401K/medical/ESPP;
// "After Tax Salary" is the true final take-home), and picking the wrong one silently produces
// slices that don't sum to gross. Computing the remainder guarantees they always do.
function paystubDonutSegments({
  gross, federal, ssn, medicare, state, k401, medical, espp,
}: {
  gross: number; federal: number; ssn: number; medicare: number; state: number; k401: number; medical: number; espp: number;
}): DonutSegment[] {
  const otherSlices = Math.max(0, federal) + Math.max(0, ssn) + Math.max(0, medicare) + Math.max(0, state) + Math.max(0, k401) + Math.max(0, medical) + Math.max(0, espp);
  return [
    { label: "Net Take-Home", value: Math.max(0, gross - otherSlices), color: "#16a34a" },
    { label: "Federal Tax", value: Math.max(0, federal), color: "#dc2626" },
    { label: "SSN + Medicare", value: Math.max(0, ssn + medicare), color: "#d97706" },
    { label: "State Tax", value: Math.max(0, state), color: "#7c3aed" },
    { label: "401K", value: Math.max(0, k401), color: "#0891b2" },
    { label: "Medical", value: Math.max(0, medical), color: "#0d9488" },
    { label: "ESPP", value: Math.max(0, espp), color: "#db2777" },
  ];
}

// Display-only: "Jan 01 Jan 15" -> "Jan 15" to save space in the Pay Periods table. The full
// label is still what's stored/matched against everywhere else -- only this rendering uses
// the shortened form. Falls back to the raw label if it isn't a parseable period range.
function periodEndLabel(label: string, year: string): string {
  const range = parsePeriodRange(label, year);
  if (!range) return label;
  const d = new Date(range.end + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Total for a row = every real pay-period value + the sheet's separate "Stocks" vesting-tax-
// event columns for that row (confirmed with the user: that money is real and should count).
function sumRow(r: PayrollRow | undefined): number {
  return (r?.values.reduce((s, v) => s + v, 0) ?? 0) + (r?.stockValues?.reduce((s, v) => s + v, 0) ?? 0);
}

function stockVal(r: PayrollRow | undefined, idx: number): number | null {
  const v = r?.stockValues?.[idx];
  return v === undefined ? null : v;
}

export type YearSalaryTaxSummary = {
  year: string;
  gross: number;
  totalTax: number;
  net: number;
  afterTax: number;
  effective: number;
  k401Self: number;
  k401Employer: number;
  espp: number;
  rsuVested: number;
};

// The employer's own ticker(s) (RSU grants + ESPP purchases), so a Trading-report entry for that
// same symbol -- e.g. synced in from a Schwab CSV that also holds the employer stock -- is
// excluded from classifyTradingSales and doesn't get double-counted alongside the Equity-report
// RSU/ESPP sale classification, which already covers it.
function employerTickerSet(equity: EquityData | undefined): Set<string> {
  const tickers = new Set<string>();
  for (const g of equity?.grants ?? []) tickers.add(g.ticker);
  for (const e of equity?.esppPurchases ?? []) tickers.add(e.ticker);
  return tickers;
}

// Same aggregation formulas the single-year view below uses (override-aware: a manual period
// correction replaces that period's Excel-imported value, a voucher-derived period adds on top,
// a row's separate "Stocks" vesting-tax-event columns always add in) -- reimplemented here as a
// standalone, year-parameterized function so both "All Years" summaries (payroll totals, and the
// federal/state tax estimate below) can compute every year the same way without touching (and
// risking regressing) the existing single-year computation below, which stays wired to component
// state/closures for its own click-through popups.
function computeYearAggregates(rawYr: PayrollYear, equity?: EquityData) {
  const yr = normalizePayrollYear(rawYr);
  const rows = yr.rows;
  const gross = row(rows, "Gross Salary");
  const federal = row(rows, "Federal");
  const ssn = row(rows, "SSN");
  const medicare = row(rows, "Medicare");
  const stateWH = row(rows, "State W/H");
  const stateSDI = row(rows, "State SDI");
  const totalTax = row(rows, "Total Tax");
  const netSalary = row(rows, "Net Salary", 1) ?? row(rows, "Net Salary", 0);
  const afterTax = row(rows, "After Tax Salary");
  const effective = row(rows, "Effective Salary");
  const k401 = row(rows, "401K");
  const k401Emplr = row(rows, "401K Emplr");
  const esppRow = row(rows, "ESPP");

  const allManualPeriods = yr.manualPeriods ?? [];
  const voucherPeriods = allManualPeriods.filter((m) => m.periodIndex === undefined);
  const overrideByIndex = new Map(allManualPeriods.filter((m) => m.periodIndex !== undefined).map((m) => [m.periodIndex!, m]));

  // Same fix as the single-year view's own overriddenTotal/overriddenGrossTotal: a vest's real
  // gross (equity-derived, not Excel) and a real vesting pay-stub's tax override (manualVestTax)
  // must count here too, or this "All Years" table silently disagrees with the single-year cards
  // for the current year the moment either one is used and the Excel import hasn't caught up.
  const vestDates = Array.from(new Set((equity?.grants ?? []).flatMap((g) => g.vests.filter((v) => v.vestDate.startsWith(yr.year)).map((v) => v.vestDate)))).sort();
  const vestTaxByDate = new Map((yr.manualVestTax ?? []).map((v) => [v.date, v]));
  const vestGrossTotal = (equity?.grants ?? [])
    .flatMap((g) => g.vests)
    .filter((v) => !v.pending && v.vestDate.startsWith(yr.year))
    .reduce((s, v) => s + v.shares * v.vestPrice, 0);
  const VEST_TAX_FIELDS = new Set(["federal", "ssn", "medicare", "stateWH", "stateSDI", "totalTax"]);
  function vestStockTotal(baseRowForField: PayrollRow | undefined, field: keyof ManualPayrollPeriod): number {
    if (!VEST_TAX_FIELDS.has(field as string)) return baseRowForField?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
    return vestDates.reduce((s, date, stockIdx) => {
      const override = vestTaxByDate.get(date);
      const v = override ? (override as unknown as Record<string, number>)[field as string] : (baseRowForField?.stockValues?.[stockIdx] ?? 0);
      return s + (v ?? 0);
    }, 0);
  }
  // Same "After Tax Salary" fix as the single-year view: net-of-withholding value of every vest,
  // replacing this row's own (possibly missing/stale) Excel stockValues for the vest component.
  const vestGrossByDate = new Map<string, number>();
  for (const g of equity?.grants ?? []) {
    for (const v of g.vests) {
      if (v.pending || !v.vestDate.startsWith(yr.year)) continue;
      vestGrossByDate.set(v.vestDate, (vestGrossByDate.get(v.vestDate) ?? 0) + v.shares * v.vestPrice);
    }
  }
  const vestAfterTaxTotal = vestDates.reduce((s, date, stockIdx) => {
    const gross = vestGrossByDate.get(date) ?? 0;
    const override = vestTaxByDate.get(date);
    const fed = override ? override.federal : (federal?.stockValues?.[stockIdx] ?? 0);
    const ssnV = override ? override.ssn : (ssn?.stockValues?.[stockIdx] ?? 0);
    const med = override ? override.medicare : (medicare?.stockValues?.[stockIdx] ?? 0);
    const swh = override ? override.stateWH : (stateWH?.stockValues?.[stockIdx] ?? 0);
    const sdi = override ? override.stateSDI : (stateSDI?.stockValues?.[stockIdx] ?? 0);
    return s + gross - fed - ssnV - med - swh - sdi;
  }, 0);

  function overriddenTotal(baseRowForField: PayrollRow | undefined, field: keyof ManualPayrollPeriod): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? (Number(ov[field]) || 0) : (baseRowForField?.values[i] ?? 0);
    }
    return sum + vestStockTotal(baseRowForField, field) + voucherPeriods.reduce((s, m) => s + (Number(m[field]) || 0), 0);
  }
  function overriddenGrossTotal(): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? ov.base + ov.telephone : (gross?.values[i] ?? 0);
    }
    return sum + vestGrossTotal + voucherPeriods.reduce((s, m) => s + m.base + m.telephone, 0);
  }

  return {
    yr,
    totalGross: overriddenGrossTotal(),
    totalFederal: overriddenTotal(federal, "federal"),
    totalMedicare: overriddenTotal(medicare, "medicare"),
    totalStateWH: overriddenTotal(stateWH, "stateWH"),
    totalTaxAll: overriddenTotal(totalTax, "totalTax"),
    totalNet: overriddenTotal(netSalary, "net"),
    totalAfterTax: (afterTax?.values ?? []).reduce((s, v) => s + v, 0) + vestAfterTaxTotal,
    totalEffective: (effective?.values ?? []).reduce((s, v) => s + v, 0) + vestGrossTotal,
    totalK401: overriddenTotal(k401, "k401"),
    totalK401Emplr: overriddenTotal(k401Emplr, "k401Emplr"),
    totalEsppDeduction: overriddenTotal(esppRow, "espp"),
  };
}

function computeYearSummary(rawYr: PayrollYear, equity: EquityData | undefined): YearSalaryTaxSummary {
  const agg = computeYearAggregates(rawYr, equity);
  // RSU vest records come from Reports > Equity (authoritative for date/shares/price), same
  // source the single-year "Stock (RSU) Vested" card uses -- only actually-vested (not pending)
  // tranches whose vest date falls in this year.
  const rsuVested = (equity?.grants ?? [])
    .flatMap((g) => g.vests.filter((v) => !v.pending && v.vestDate.startsWith(agg.yr.year)))
    .reduce((s, v) => s + v.shares * v.vestPrice, 0);

  return {
    year: agg.yr.year,
    gross: agg.totalGross,
    totalTax: agg.totalTaxAll,
    net: agg.totalNet,
    afterTax: agg.totalAfterTax,
    effective: agg.totalEffective,
    k401Self: agg.totalK401,
    k401Employer: agg.totalK401Emplr,
    espp: agg.totalEsppDeduction,
    rsuVested,
  };
}

export type YearFederalStateTaxEstimate = {
  year: string;
  agi: number;
  deductionUsed: number;
  usedItemized: boolean;
  longTermGain: number;
  estimatedFederalTax: number;
  federalWithheld: number;
  federalRefund: number;
  federalBalanceDue: number;
  stateCode: string;
  stateName: string;
  stateTaxableIncome: number;
  estimatedStateTax: number;
  stateWithheld: number;
  stateRefund: number;
  stateBalanceDue: number;
};

// Same federal/state estimate the single-year view below computes (lines ~950+), reimplemented
// standalone and year-parameterized for the same reason computeYearSummary above is -- filing
// status and HSA coverage are a single, global assumption in this report (not stored per year),
// so every year's estimate uses whatever the user currently has selected, matching how the
// single-year view already treats them.
function computeYearTaxEstimate(
  rawYr: PayrollYear,
  transactions: Tx[],
  accounts: Account[],
  equity: EquityData | undefined,
  trades: Trade[] | undefined,
  filingStatus: UsFilingStatus,
  hsaCoverage: HsaCoverage
): YearFederalStateTaxEstimate {
  const agg = computeYearAggregates(rawYr, equity);
  const year = agg.yr.year;
  const taxableWages = Math.max(0, agg.totalGross - agg.totalK401);
  const taxEstimateYear = listUsTaxYears().includes(year) ? year : listUsTaxYears()[0]!;
  const employerTickers = employerTickerSet(equity);
  const gainEvents = [
    ...classifyRsuSales(equity?.grants ?? [], year, 365),
    ...classifyEsppSales(equity?.esppPurchases ?? [], year, 365),
    ...classifyTradingSales(trades ?? [], year, 365, employerTickers),
  ];
  const gainTotals = summarizeCapitalGains(gainEvents);
  const deductionMatches = matchDeductionLedgers(accounts, transactions, year);
  const hsaContributionTotal = findHsaContributions(transactions, year).reduce((s, h) => s + h.amount, 0);
  const hsaDeduction = computeHsaDeduction(taxEstimateYear, hsaCoverage, hsaContributionTotal);
  const interestDividendIncome = sumInterestDividendIncome(transactions, accounts, year);
  const preliminaryAgi = Math.max(
    0,
    taxableWages +
      interestDividendIncome +
      gainTotals.shortTermGainTaxable +
      gainTotals.longTermGainTaxable -
      gainTotals.ordinaryLossDeduction -
      hsaDeduction
  );
  const federalItemized = computeItemizedDeduction(taxEstimateYear, preliminaryAgi, {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    stateIncomeTaxPaid: deductionTotal(deductionMatches, "stateIncomeTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  });
  const taxEstimate = estimateUsFederalTax({
    taxYear: taxEstimateYear,
    filingStatus,
    wages: taxableWages,
    federalWithheld: agg.totalFederal,
    medicareWages: agg.totalGross,
    medicareWithheld: agg.totalMedicare,
    interestDividendIncome,
    shortTermGainTaxable: gainTotals.shortTermGainTaxable,
    longTermGainTaxable: gainTotals.longTermGainTaxable,
    capitalLossDeduction: gainTotals.ordinaryLossDeduction,
    aboveLineDeduction: hsaDeduction,
    itemizedDeduction: federalItemized.total,
  });

  const stateResidency = resolveStateResidency(taxEstimateYear);
  const stateAgi = stateResidency.code === "AZ" ? taxEstimate.agi : taxEstimate.agi + taxEstimate.aboveLineDeduction;
  const stateItemizedInputs = {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  };
  const stateItemized =
    stateResidency.code === "NJ"
      ? computeNjPropertyTaxDeduction(stateItemizedInputs.propertyTax)
      : stateResidency.code === "AZ"
        ? computeAzItemizedDeduction(stateAgi, stateItemizedInputs)
        : computeCaItemizedDeduction(stateAgi, stateItemizedInputs, resolveCaTaxRules(taxEstimateYear, filingStatus).itemizedDeductionPhaseoutThreshold);
  const stateTaxEstimate =
    stateResidency.code === "NJ"
      ? estimateNjStateTax({ taxYear: taxEstimateYear, filingStatus, agi: stateAgi, propertyTax: stateItemizedInputs.propertyTax, stateWithheld: agg.totalStateWH })
      : stateResidency.code === "AZ"
        ? estimateAzStateTax({ taxYear: taxEstimateYear, filingStatus, agi: stateAgi, itemizedDeduction: stateItemized, stateWithheld: agg.totalStateWH })
        : estimateCaStateTax({ taxYear: taxEstimateYear, filingStatus, agi: stateAgi, itemizedDeduction: stateItemized, stateWithheld: agg.totalStateWH });

  return {
    year,
    agi: taxEstimate.agi,
    deductionUsed: taxEstimate.deductionUsed,
    usedItemized: taxEstimate.usedItemized,
    longTermGain: taxEstimate.longTermGain,
    estimatedFederalTax: taxEstimate.estimatedTax,
    federalWithheld: taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld,
    federalRefund: taxEstimate.refund,
    federalBalanceDue: taxEstimate.balanceDue,
    stateCode: stateResidency.code,
    stateName: stateResidency.name,
    stateTaxableIncome: stateTaxEstimate.taxableIncome,
    estimatedStateTax: stateTaxEstimate.estimatedTax,
    stateWithheld: stateTaxEstimate.stateWithheld,
    stateRefund: stateTaxEstimate.refund,
    stateBalanceDue: stateTaxEstimate.balanceDue,
  };
}

const linkBtnStyle: React.CSSProperties = { background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, font: "inherit", textDecoration: "underline" };

function VestTable({ items, fmt }: { items: { grant: RsuGrant; vest: RsuVest }[]; fmt: (n: number) => string }) {
  return (
    <table className="equity-table" style={{ width: "100%" }}>
      <thead>
        {/* Same fix the drill-down tables already needed (see .equity-drilldown-table th in
            globals.css): the generic theme padding/font-size wasn't sized for an 8-column table,
            so 2-word headers ("Tax Sh", "Net Sh", "Vest $/sh") wrapped to two lines and made the
            whole table look broken. Force single-line headers so columns size to their content
            instead. */}
        <tr>
          <th style={{ whiteSpace: "nowrap" }}>Vest Date</th>
          <th style={{ whiteSpace: "nowrap" }}>Grant</th>
          <th className="right" style={{ whiteSpace: "nowrap" }}>Shares</th>
          <th className="right" style={{ whiteSpace: "nowrap" }}>Tax Sh</th>
          <th className="right" style={{ whiteSpace: "nowrap" }}>Net Sh</th>
          <th className="right" style={{ whiteSpace: "nowrap" }}>Vest $/sh</th>
          <th className="right" style={{ whiteSpace: "nowrap" }}>Value</th>
          <th style={{ whiteSpace: "nowrap" }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 && (
          <tr><td colSpan={8} style={{ opacity: 0.5 }}>No RSU vests recorded.</td></tr>
        )}
        {items.map(({ grant, vest }) => {
          const taxShares = vest.taxShares ?? 0;
          return (
            <tr key={vest.id}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(vest.vestDate + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</td>
              <td className="equity-neutral" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{grant.ticker} granted {fmtDate(grant.grantDate)}</td>
              <td className="right">{vest.shares.toLocaleString()}</td>
              <td className="right">{vest.pending ? "—" : taxShares.toLocaleString()}</td>
              <td className="right">{vest.pending ? "—" : (vest.shares - taxShares).toLocaleString()}</td>
              <td className="right" style={{ whiteSpace: "nowrap" }}>{vest.pending ? "—" : `$${vest.vestPrice.toFixed(2)}`}</td>
              <td className="right equity-amt" style={{ whiteSpace: "nowrap" }}>{vest.pending ? "—" : fmt(vest.shares * vest.vestPrice)}</td>
              <td style={{ whiteSpace: "nowrap" }}>{vest.pending ? <span style={{ color: "#888" }}>Scheduled</span> : <span style={{ color: "#16a34a" }}>Vested</span>}</td>
            </tr>
          );
        })}
      </tbody>
      {items.length > 0 && (() => {
        // Vest $/sh has no meaningful sum (a per-share price, not an amount) -- left blank.
        // Tax Sh/Net Sh/Value only total the already-vested rows, same as each row itself only
        // shows "—" for a still-scheduled one (its withholding/value aren't known yet).
        const totalShares = items.reduce((s, { vest }) => s + vest.shares, 0);
        const vested = items.filter(({ vest }) => !vest.pending);
        const totalTaxShares = vested.reduce((s, { vest }) => s + (vest.taxShares ?? 0), 0);
        const totalNetShares = vested.reduce((s, { vest }) => s + (vest.shares - (vest.taxShares ?? 0)), 0);
        const totalValue = vested.reduce((s, { vest }) => s + vest.shares * vest.vestPrice, 0);
        return (
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td className="right">{totalShares.toLocaleString()}</td>
              <td className="right">{totalTaxShares.toLocaleString()}</td>
              <td className="right">{totalNetShares.toLocaleString()}</td>
              <td className="right">—</td>
              <td className="right equity-amt">{fmt(totalValue)}</td>
              <td></td>
            </tr>
          </tfoot>
        );
      })()}
    </table>
  );
}

function EsppTable({ items, fmt }: { items: EsppPurchase[]; fmt: (n: number) => string }) {
  return (
    <table className="equity-table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Purchase Date</th>
          <th className="right">Shares</th>
          <th className="right">Offering $/sh</th>
          <th className="right">Purchase $/sh</th>
          <th className="right">Market $/sh</th>
          <th className="right">Discount Value</th>
        </tr>
      </thead>
      <tbody>
        {items.length === 0 && (
          <tr><td colSpan={6} style={{ opacity: 0.5 }}>No ESPP purchases recorded.</td></tr>
        )}
        {items.map((e) => (
          <tr key={e.id}>
            <td>{new Date(e.purchaseDate + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</td>
            <td className="right">{e.shares.toLocaleString()}</td>
            <td className="right">${e.offeringPrice.toFixed(2)}</td>
            <td className="right">${e.purchasePrice.toFixed(2)}</td>
            <td className="right">${e.marketPriceAtPurchase.toFixed(2)}</td>
            <td className="right equity-amt">{fmt((e.marketPriceAtPurchase - e.purchasePrice) * e.shares)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditFieldsForm({
  form, onChange, onSave, onCancel, saving,
}: {
  form: typeof BLANK_MANUAL_FORM;
  onChange: (next: typeof BLANK_MANUAL_FORM) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div style={{ padding: "0.5rem 0.25rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.6rem" }}>
        {MANUAL_FIELDS.map((f) => (
          <label key={f.key} style={{ fontSize: 12 }}>
            {f.label}
            <input
              type="number"
              step="0.01"
              className="tax-manual-input"
              value={form[f.key]}
              onChange={(e) => onChange({ ...form, [f.key]: e.target.value })}
              style={{ width: "100%", display: "block", marginTop: 2 }}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <button onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

const MANUAL_FIELDS: { key: keyof typeof BLANK_MANUAL_FORM; label: string }[] = [
  { key: "base", label: "Base" },
  { key: "telephone", label: "Telephone" },
  { key: "medical", label: "Medical" },
  { key: "k401", label: "401K (employee)" },
  { key: "k401Emplr", label: "401K Employer Match" },
  { key: "espp", label: "ESPP Deduction" },
  { key: "federal", label: "Federal" },
  { key: "ssn", label: "SSN" },
  { key: "medicare", label: "Medicare" },
  { key: "stateWH", label: "State W/H" },
  { key: "stateSDI", label: "State SDI" },
  { key: "net", label: "Net (bank deposit)" },
];

const BLANK_MANUAL_FORM = {
  base: "", telephone: "", medical: "", k401: "", k401Emplr: "", espp: "",
  federal: "", ssn: "", medicare: "", stateWH: "", stateSDI: "", net: "",
};

export function TaxReport({ payroll, transactions, equity, accounts, trades, onSave, onViewVoucher, onViewDocuments, book, fmt, readOnly, livePrice }: TaxReportProps) {
  const { privacyMode } = useUiPrefs();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  // Narrows the Year chip row below to one employer's years -- see PayrollYear.employer
  // (lib/vault-types.ts), populated from the imported workbook's own "Summary" sheet.
  // "All" shows every year regardless of employer, same as before this filter existed.
  const [employerFilter, setEmployerFilter] = useState<string>("All");
  // Clicking a pay period (Excel-imported, manual/voucher-derived, or an RSU vest event) opens
  // a popup with a donut + full detail, rather than expanding an inline row.
  const [viewPeriod, setViewPeriod] = useState<
    | { type: "excel"; index: number }
    | { type: "manual"; id: string }
    | { type: "vest"; date: string }
    | { type: "ytd" }
    | null
  >(null);
  const [todayIso] = useState(() => todayLocalIso());
  const [showRsuModal, setShowRsuModal] = useState(false);
  const [periodVestModal, setPeriodVestModal] = useState<{ label: string; items: { grant: RsuGrant; vest: RsuVest }[] } | null>(null);
  const [showEsppModal, setShowEsppModal] = useState(false);
  const [periodEsppModal, setPeriodEsppModal] = useState<{ label: string; items: EsppPurchase[] } | null>(null);
  const [voucherModalTx, setVoucherModalTx] = useState<Tx | null>(null);
  const [editingTarget, setEditingTarget] = useState<{ id: string | null; periodIndex?: number; label: string } | null>(null);
  const [manualForm, setManualForm] = useState(BLANK_MANUAL_FORM);
  const [savingManual, setSavingManual] = useState(false);
  const paystubFileInputRef = useRef<HTMLInputElement>(null);
  const [parsingPaystub, setParsingPaystub] = useState(false);
  const [paystubError, setPaystubError] = useState("");
  // A regular pay-period paystub ("period") vs. an off-cycle, single-day, stock-only vesting
  // pay-stub ("vest") -- the latter never matches a regular semi-monthly Pay Period or a Receipt
  // voucher at all (confirmed: "RSU Vesting paystub will not match with any of the receipt
  // vouchers in app"), and instead feeds the RSU vest row's tax columns (see manualVestTax).
  type PaystubTarget =
    | { kind: "period"; id: string | null; periodIndex?: number; label: string }
    | { kind: "vest"; date: string; stockIdx: number };
  const [paystubReview, setPaystubReview] = useState<{
    target: PaystubTarget;
    parsed: ParsedPaystub;
    // The raw uploaded file, kept alongside the parsed numbers so savePaystubReview can archive
    // it into Masters > Documents when the user confirms -- one upload does both jobs instead of
    // needing a second, separate trip through Documents for the same PDF.
    file: File;
    tieOut: { voucher: Tx; voucherNet: number } | null;
    // Set when this period/vest already has real (non-estimated) saved numbers from an earlier
    // paystub -- NVIDIA issues one separate "Pay Statement" PDF (or, for a vest, one PAGE within
    // one PDF) per RSU lot vesting on the same date, all with identical period dates, so a
    // second (third, fourth...) upload for the same period is normal, not a re-upload of the
    // same document. Non-null offers "add to this" as the default instead of silently
    // clobbering the first paystub's numbers.
    priorSaved: ManualPayrollPeriod | ManualVestTax | null;
  } | null>(null);
  const [paystubMode, setPaystubMode] = useState<"replace" | "add">("replace");
  const [savingPaystub, setSavingPaystub] = useState(false);
  // Maps a Net Pay Distribution account's last-4 digits to a friendly bank name (e.g. "5570" ->
  // "BofA") -- the paystub PDF itself only ever shows masked account numbers, never bank names,
  // so this has to be a one-time mapping the user supplies and the app remembers, not something
  // parseable from the PDF. Persisted so every future paystub import reuses it automatically.
  // Two different last-4s can share one bank name (e.g. two linked accounts both routing to the
  // same physical Chase account) -- the Distribution summary below groups by name, not by account.
  const [bankNames, setBankNames] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("dk-paystub-bank-names") || "{}");
    } catch {
      return {};
    }
  });
  const setBankName = (last4: string, name: string) =>
    setBankNames((prev) => {
      const next = { ...prev, [last4]: name };
      localStorage.setItem("dk-paystub-bank-names", JSON.stringify(next));
      return next;
    });
  const [startingManualYear, setStartingManualYear] = useState(false);
  const [manualYearInput, setManualYearInput] = useState(() => String(new Date().getFullYear()));
  const [filingStatus, setFilingStatus] = useState<UsFilingStatus>("mfj");
  const [hsaCoverage, setHsaCoverage] = useState<HsaCoverage>("family");
  const [showGainEventsModal, setShowGainEventsModal] = useState(false);
  const [showDeductionsModal, setShowDeductionsModal] = useState(false);
  const [showTaxPlanningModal, setShowTaxPlanningModal] = useState(false);
  // `total` is always the SAME value already shown on the triggering card (totalGross,
  // totalTaxAll, etc.) -- passed through rather than recomputed, so the modal's footer can
  // never drift from the card that opened it. `field`/`isGross` (optional) make the per-period
  // row list override- and voucher-period-aware too, for the cards whose own total already is
  // (gross/totalTax/net/k401/k401Emplr) -- confirmed live: without this, the modal for "Gross
  // Salary" showed a Total $20k+ short of the card, since it read raw Excel values only and
  // silently dropped both manual corrections AND paystub-only periods outside the Excel import.
  const [periodBreakdownModal, setPeriodBreakdownModal] = useState<{
    label: string; row: PayrollRow | undefined; total: number;
    field?: keyof ManualPayrollPeriod; isGross?: boolean;
  } | null>(null);
  // Line-item derivation for the Federal/State tax estimate summary cards -- several of those
  // cards (AGI, Estimated Tax, Withheld, Refund/Balance Due) had no click handler at all, so the
  // "sub" caption text was the only explanation offered for how the number was computed. Every
  // line here reuses an already-computed field from taxEstimate/stateTaxEstimate, never
  // re-derives the math, so the modal can't drift from what's actually displayed on the card.
  const [taxBreakdownModal, setTaxBreakdownModal] = useState<{ title: string; lines: { label: string; value: number; bold?: boolean }[] } | null>(null);
  const attemptedGuidsRef = useRef<Set<string>>(new Set());

  const activeYearLabel = selectedYear ?? payroll?.years[0]?.year ?? null;

  // One-time cleanup for duplicate manual periods created by the bug fixed below, BEFORE the
  // fix existed -- multiple vouchers estimating to the same label had each gotten their own
  // row. Keeps one entry per label (preferring a manually-corrected one over a still-"estimated"
  // one), only among voucher-derived periods (periodIndex === undefined; an Excel-correction
  // override is keyed by periodIndex, not label, and can't collide the same way).
  const cleanupAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!payroll || readOnly) return;
    const yr = payroll.years.find((y) => y.year === activeYearLabel);
    if (!yr || cleanupAttemptedRef.current.has(yr.year)) return;
    const voucherPeriods = (yr.manualPeriods ?? []).filter((m) => m.periodIndex === undefined);
    const byLabel = new Map<string, typeof voucherPeriods>();
    for (const m of voucherPeriods) byLabel.set(m.label, [...(byLabel.get(m.label) ?? []), m]);
    const dupeLabels = [...byLabel.entries()].filter(([, group]) => group.length > 1);
    if (dupeLabels.length === 0) { cleanupAttemptedRef.current.add(yr.year); return; }
    const keepIds = new Set(
      dupeLabels.map(([, group]) => (group.find((m) => !m.estimated) ?? group[0]).id)
    );
    const dropIds = new Set(
      dupeLabels.flatMap(([, group]) => group.filter((m) => !keepIds.has(m.id)).map((m) => m.id))
    );
    const updatedYears = payroll.years.map((y) =>
      y.year !== yr.year ? y : { ...y, manualPeriods: (y.manualPeriods ?? []).filter((m) => !dropIds.has(m.id)) }
    );
    (async () => {
      const ok = await onSave({ ...payroll, years: updatedYears });
      if (ok !== false) cleanupAttemptedRef.current.add(yr.year);
    })();
  }, [payroll, activeYearLabel, readOnly, onSave]);

  // One-time repair for a voucher-derived manual period whose label now matches a real
  // Excel-imported period but was never LINKED to it (periodIndex left undefined). Confirmed
  // live: this produces both a visibly duplicated Pay Periods row (the Excel row AND the
  // unlinked correction, both showing the same period) AND, more seriously, DOUBLE-COUNTS every
  // total this feeds -- manualGross/manualFederal/etc. sum every periodIndex-undefined entry
  // unconditionally and add it ON TOP of overriddenGrossTotal()'s own Excel-row sum, which has
  // no way to know this "voucher" period is actually the SAME real pay period (see the comment
  // on voucherPeriods/overrideByIndex above). Likely cause: the paystub was uploaded and saved
  // before this label existed in the Excel import (a later re-import added or renamed that
  // period), so matchPayrollPeriod had nothing to match against at save time. Re-links by
  // setting periodIndex to the now-matching Excel row -- converting it into a proper override,
  // which both collapses the duplicate row and removes the double-count, without touching any
  // of its actual saved numbers. Runs every time a new match appears (not just once ever), so
  // it keeps self-healing if the same situation recurs after a future re-import.
  const relinkAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!payroll || readOnly) return;
    const yr = payroll.years.find((y) => y.year === activeYearLabel);
    if (!yr || relinkAttemptedRef.current.has(yr.year)) return;
    const manualPeriods = yr.manualPeriods ?? [];
    const claimedIndexes = new Set(manualPeriods.filter((m) => m.periodIndex !== undefined).map((m) => m.periodIndex));
    let changed = false;
    const relinked = manualPeriods.map((m) => {
      if (m.periodIndex !== undefined) return m;
      const idx = yr.periodLabels.indexOf(m.label);
      if (idx === -1 || claimedIndexes.has(idx)) return m;
      claimedIndexes.add(idx);
      changed = true;
      return { ...m, periodIndex: idx };
    });
    if (!changed) { relinkAttemptedRef.current.add(yr.year); return; }
    const updatedYears = payroll.years.map((y) => (y.year !== yr.year ? y : { ...y, manualPeriods: relinked }));
    (async () => {
      const ok = await onSave({ ...payroll, years: updatedYears });
      if (ok !== false) relinkAttemptedRef.current.add(yr.year);
    })();
  }, [payroll, activeYearLabel, readOnly, onSave]);

  // Once a salary voucher is posted for a period the Excel doesn't cover, auto-create a
  // (marked "estimated") Tax tab line for it right away — no need to wait for a re-import.
  useEffect(() => {
    if (!payroll || readOnly) return;
    const yr = payroll.years.find((y) => y.year === activeYearLabel);
    if (!yr) return;
    const uncovered = findUncoveredSalaryVouchers(transactions, yr).filter((t) => !attemptedGuidsRef.current.has(t.guid));
    if (uncovered.length === 0) return;
    // Two different vouchers (e.g. distinct historical paychecks from an old employer, both
    // falling in the same inferred "Mon 01 Mon 15" bucket) can independently estimate to the
    // SAME period label -- previously each got its own manual period, so the same label showed
    // up twice in the table. Keep only the first voucher per unique label; every voucher in
    // this batch (created or skipped as a duplicate) still counts as handled so it doesn't
    // re-trigger every render.
    const existingLabels = new Set((yr.manualPeriods ?? []).map((m) => m.label));
    const newManual: ReturnType<typeof estimateManualPeriod>[] = [];
    for (const t of uncovered) {
      const period = estimateManualPeriod(yr, t);
      if (existingLabels.has(period.label)) continue;
      existingLabels.add(period.label);
      newManual.push(period);
    }
    if (newManual.length === 0) {
      uncovered.forEach((t) => attemptedGuidsRef.current.add(t.guid));
      return;
    }
    const updatedYears = payroll.years.map((y) =>
      y.year !== yr.year ? y : { ...y, manualPeriods: [...(y.manualPeriods ?? []), ...newManual] }
    );
    // Only mark these as "attempted" once the save actually succeeds -- onSave resolves
    // false on a version conflict (two saves racing, e.g. right after posting the voucher
    // and matching it via "Already posted?"), and silently marking a failed attempt as done
    // meant it would never be retried for the rest of this page visit.
    (async () => {
      const ok = await onSave({ ...payroll, years: updatedYears });
      if (ok !== false) uncovered.forEach((t) => attemptedGuidsRef.current.add(t.guid));
    })();
  }, [payroll, transactions, activeYearLabel, readOnly, onSave]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportError("");
    setImporting(true);
    try {
      const { parsePayrollXlsx } = await import("@/lib/parse-payroll-xlsx");
      const parsed = await parsePayrollXlsx(file);
      if (parsed.years.length === 0) {
        setImportError('No "Yearly <year>" sheets found in this file.');
        return;
      }
      // A re-import replaces payroll.years wholesale -- without this, every manual correction
      // (a joining-bonus voucher explicitly linked to a period the date-window match can't
      // reach, a real-paystub edit overlaid on an Excel period) is silently wiped the next time
      // the same workbook is re-imported, even though nothing about that correction changed.
      // Carry them forward by matching on the period's LABEL TEXT (not periodIndex), since a
      // re-import can shift column positions (e.g. inserting/renaming an early column) --
      // blindly keeping the same index could silently attach an old correction to the wrong
      // period. An override whose label no longer exists in the freshly parsed sheet is dropped
      // (it was orphaned) rather than carried forward onto whatever now sits at its old index.
      const mergedYears = parsed.years.map((y) => {
        const oldYear = payroll?.years.find((oy) => oy.year === y.year);
        const oldManual = oldYear?.manualPeriods ?? [];
        if (oldManual.length === 0) return y;
        const carried = oldManual
          .map((m) => {
            if (m.periodIndex === undefined) return m; // voucher-derived period, no index to remap
            const oldLabel = oldYear!.periodLabels[m.periodIndex];
            const newIndex = oldLabel ? y.periodLabels.indexOf(oldLabel) : -1;
            return newIndex === -1 ? null : { ...m, periodIndex: newIndex };
          })
          .filter((m): m is ManualPayrollPeriod => m !== null);
        return { ...y, manualPeriods: carried };
      });
      await onSave({ ...parsed, years: mergedYears });
      setSelectedYear(parsed.years[0].year);
      if (parsed.warnings?.length) setImportError(parsed.warnings.join(" "));
    } catch (err: any) {
      setImportError("Failed to parse Excel file: " + (err?.message ?? "Unknown error"));
    } finally {
      setImporting(false);
    }
  }

  // Parses a real paystub PDF and stages it for review (paystubReview) -- never writes
  // anything until the user explicitly clicks Save in the review panel, same "preview then
  // confirm" pattern as every other write in this app. Finds which period it belongs to: an
  // existing Excel period first (matchPayrollPeriod, same logic used for Plaid's payroll
  // auto-draft), then an existing manual/estimated period with the same inferred label, and
  // only creates a brand-new one if neither exists yet.
  async function handlePaystubUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setPaystubError("");
    setPaystubReview(null);
    setParsingPaystub(true);
    try {
      const { parsePaystubPdf } = await import("@/lib/parse-paystub-pdf");
      const parsed = await parsePaystubPdf(file);
      if (!parsed.periodEnd) {
        // Surface exactly what the PDF's own text near "Period" looked like -- two rounds of
        // guessing at the date format from a screenshot alone didn't find the real cause, so
        // showing the raw extracted text directly in the error is more useful than a third guess.
        const periodIdx = parsed.rawText.indexOf("Period");
        const nearPeriod = periodIdx >= 0 ? parsed.rawText.slice(periodIdx, periodIdx + 120) : "(no \"Period\" text found anywhere in this PDF)";
        setPaystubError(`Could not read the pay period dates from this PDF — please check the file. Raw text found: "${nearPeriod}"`);
        return;
      }

      // A real regular paystub always spans a multi-day period (e.g. 09/01-09/15); Period Start
      // === Period End is NVIDIA's signature for an off-cycle, single-day, stock-only "vesting"
      // pay statement -- confirmed live against a real one (Period/Pay Date all 09/17/2026,
      // Salary/Net Pay $0.00, only the "Restricted Stoc" earnings line and tax withholding
      // populated). Those never correspond to a regular semi-monthly Pay Period or a posted
      // Receipt voucher, and instead belong on the matching RSU vest row's tax columns.
      const singleDayRun = !!parsed.periodEnd && parsed.periodStart === parsed.periodEnd;
      const VEST_MATCH_WINDOW_DAYS = 14;
      let vestMatch: { date: string; stockIdx: number } | null = null;
      if (singleDayRun) {
        const target = new Date(parsed.periodEnd + "T00:00:00Z").getTime();
        let bestDiff = Infinity;
        for (const g of vestGroups) {
          const diffDays = Math.abs((target - new Date(g.date + "T00:00:00Z").getTime()) / 86400000);
          if (diffDays <= VEST_MATCH_WINDOW_DAYS && diffDays < bestDiff) { bestDiff = diffDays; vestMatch = { date: g.date, stockIdx: g.stockIdx }; }
        }
      }

      let target: PaystubTarget;
      let tieOut: { voucher: Tx; voucherNet: number } | null = null;
      let priorSaved: ManualPayrollPeriod | ManualVestTax | null;

      if (vestMatch) {
        target = { kind: "vest", date: vestMatch.date, stockIdx: vestMatch.stockIdx };
        priorSaved = vestTaxByDate.get(vestMatch.date) ?? null;
        // No voucher tie-out for a vest -- the whole reason this path exists is that a vesting
        // pay-stub never matches a posted Receipt voucher at all.
      } else {
        const yearIdx = years.findIndex((y) => y.year === yr.year);
        const match = matchPayrollPeriod(payroll, parsed.periodEnd);
        const inferredLabel = inferPeriodLabel(parsed.periodEnd);
        const label = match && match.yearIdx === yearIdx ? (yr.periodLabels[match.periodIndex] || inferredLabel) : inferredLabel;
        // A manual entry for this exact label always wins, whether it's a voucher-derived
        // estimate (posted before the real paystub existed -- periodIndex undefined, txGuid set)
        // or a prior correction (periodIndex set). Checking the Excel column match FIRST used to
        // ignore an already-linked voucher entirely and create a second, disconnected row with no
        // voucher link -- exactly the "why two Aug 31 rows" case this was built to fix.
        const existingManual = (yr.manualPeriods ?? []).find((m) => m.label === label);
        if (existingManual) {
          target = { kind: "period", id: existingManual.id, periodIndex: existingManual.periodIndex, label };
        } else if (match && match.yearIdx === yearIdx) {
          target = { kind: "period", id: null, periodIndex: match.periodIndex, label };
        } else {
          target = { kind: "period", id: null, periodIndex: undefined, label };
        }

        // Same tie-out comparison as the Pay Periods table, surfaced immediately here instead of
        // requiring a save-then-look-at-the-table round trip.
        const periodTarget = target as { kind: "period"; id: string | null; periodIndex?: number; label: string };
        const existingManualForTarget = periodTarget.id ? (yr.manualPeriods ?? []).find((m) => m.id === periodTarget.id) : undefined;
        const linkedTx = existingManualForTarget?.txGuid
          ? transactions.find((t) => t.guid === existingManualForTarget.txGuid)
          : findPayrollVoucher(transactions, yr.year, periodTarget.label, yr.periodLabels, claimedTxGuids);
        if (linkedTx) tieOut = { voucher: linkedTx, voucherNet: voucherNetAmount(linkedTx, accounts) };

        // Real, already-saved numbers (not still a voucher-derived estimate) on the SAME period
        // this upload resolved to -- almost certainly a second paystub for a same-day multi-lot
        // vesting, not a duplicate upload of the first one. Offer to add rather than overwrite.
        priorSaved = existingManual && !existingManual.estimated ? existingManual : null;
      }
      setPaystubMode(priorSaved ? "add" : "replace");
      setPaystubReview({ target, parsed, file, tieOut, priorSaved });
    } catch (err: any) {
      setPaystubError("Failed to parse paystub PDF: " + (err?.message ?? "Unknown error"));
    } finally {
      setParsingPaystub(false);
    }
  }

  // Uploads the raw paystub PDF into R2 the same way Masters > Documents does (see
  // MastersPanel.tsx's uploadDocuments) and returns the resulting VaultDocument to fold into the
  // same save as the extracted numbers below. Auto-trims an oversized PDF first, same as
  // Documents; returns null (with a soft warning, not a blocking error) if archiving fails for
  // any reason -- the numeric save this exists alongside is the important part and must not be
  // blocked by a secondary archival problem.
  async function archivePaystubDocument(file: File, label: string, date: string): Promise<VaultDocument | null> {
    let toUpload = file;
    if (file.size > DOCUMENT_MAX_SIZE_BYTES) {
      const trimmed = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? await trimPdfToFit(file, DOCUMENT_MAX_SIZE_BYTES) : null;
      if (!trimmed) {
        setPaystubError(`Numbers saved, but the PDF itself was too large to archive (${(file.size / 1024 / 1024).toFixed(1)}MB, limit ~${DOCUMENT_MAX_SIZE_BYTES / 1024 / 1024}MB).`);
        return null;
      }
      toUpload = trimmed.file;
    }
    try {
      const form = new FormData();
      form.append("file", toUpload);
      form.append("book", book);
      form.append("folder", "documents");
      const r = await apiFetch("/api/attachments", { method: "POST", body: form });
      if (!r.ok) {
        setPaystubError(`Numbers saved, but archiving the PDF to Documents failed (${r.status}).`);
        return null;
      }
      const meta = (await r.json()) as { key: string; filename: string; size: number; contentType: string; uploadedAt: string };
      return { id: crypto.randomUUID(), category: "Pay Stub", label, date, ...meta };
    } catch {
      setPaystubError("Numbers saved, but archiving the PDF to Documents failed.");
      return null;
    }
  }

  async function savePaystubReview() {
    if (!paystubReview) return;
    setSavingPaystub(true);
    setPaystubError("");
    try {
      const { target, parsed, file, priorSaved } = paystubReview;
      const archiveLabel = target.kind === "vest" ? `RSU Vest Pay Stub — ${target.date}` : `Pay Stub — ${target.label}`;
      const archiveDate = target.kind === "vest" ? target.date : parsed.periodEnd;
      const newDocument = await archivePaystubDocument(file, archiveLabel, archiveDate);
      // "Add" sums this paystub's numbers onto whatever was already saved for this exact
      // period/vest -- NVIDIA issues one Pay Statement PDF (or, for a vest, one PAGE within one
      // PDF, already summed by parsePaystubPdf) per RSU lot vesting the same day, so uploading a
      // second FILE for the same date needs to total onto the first, not clobber it. "Replace"
      // (the default when there's no prior real data) behaves as a plain overwrite.
      const add = paystubMode === "add" && !!priorSaved;

      if (target.kind === "vest") {
        const prior = add ? (priorSaved as ManualVestTax | null) : null;
        const entry: ManualVestTax = {
          date: target.date,
          federal: (prior?.federal ?? 0) + parsed.federal,
          ssn: (prior?.ssn ?? 0) + parsed.ssn,
          medicare: (prior?.medicare ?? 0) + parsed.medicare,
          stateWH: (prior?.stateWH ?? 0) + parsed.stateWH,
          stateSDI: (prior?.stateSDI ?? 0) + parsed.stateSDI,
          totalTax: (prior?.totalTax ?? 0) + parsed.totalTax,
        };
        const updatedYears = payroll!.years.map((y) => {
          if (y.year !== yr.year) return y;
          const existing = (y.manualVestTax ?? []).filter((v) => v.date !== target.date);
          return { ...y, manualVestTax: [...existing, entry] };
        });
        await onSave({ ...payroll!, years: updatedYears }, newDocument ?? undefined);
        setPaystubReview(null);
        return;
      }

      const prior = add ? (priorSaved as ManualPayrollPeriod | null) : null;
      const fields = {
        base: (prior?.base ?? 0) + parsed.base,
        telephone: (prior?.telephone ?? 0) + parsed.telephone,
        medical: (prior?.medical ?? 0) + parsed.medical,
        k401: (prior?.k401 ?? 0) + parsed.k401,
        k401Emplr: (prior?.k401Emplr ?? 0) + parsed.k401Emplr,
        espp: (prior?.espp ?? 0) + parsed.espp,
        federal: (prior?.federal ?? 0) + parsed.federal,
        ssn: (prior?.ssn ?? 0) + parsed.ssn,
        medicare: (prior?.medicare ?? 0) + parsed.medicare,
        stateWH: (prior?.stateWH ?? 0) + parsed.stateWH,
        stateSDI: (prior?.stateSDI ?? 0) + parsed.stateSDI,
        totalTax: (prior?.totalTax ?? 0) + parsed.totalTax,
        net: (prior?.net ?? 0) + parsed.netPay,
        estimated: false as const,
      };
      const updatedYears = payroll!.years.map((y) => {
        if (y.year !== yr.year) return y;
        const existing = y.manualPeriods ?? [];
        if (target.id) {
          return { ...y, manualPeriods: existing.map((x) => (x.id === target.id ? { ...x, ...fields } : x)) };
        }
        const newPeriod: ManualPayrollPeriod = { id: crypto.randomUUID(), label: target.label, periodIndex: target.periodIndex, ...fields };
        return { ...y, manualPeriods: [...existing, newPeriod] };
      });
      await onSave({ ...payroll!, years: updatedYears }, newDocument ?? undefined);
      setPaystubReview(null);
    } finally {
      setSavingPaystub(false);
    }
  }

  async function startWithoutExcel() {
    const year = manualYearInput.trim();
    if (!/^\d{4}$/.test(year)) return;
    const newYear: PayrollYear = {
      year,
      sheetName: "(manual entry)",
      periodLabels: generateStandardPeriodLabels(year),
      rows: [],
      manualPeriods: [],
    };
    const next: PayrollData = payroll
      ? { ...payroll, years: [...payroll.years.filter((y) => y.year !== year), newYear] }
      : { years: [newYear], importedAt: new Date().toISOString(), sourceFileName: "(manual entry — no Excel)" };
    await onSave(next);
    setSelectedYear(year);
    setStartingManualYear(false);
  }

  if (!payroll || payroll.years.length === 0) {
    return (
      <div className="data-panel tax-report">
        <div className="equity-seed-banner">
          <p className="equity-empty">No paystub/tax data imported yet.</p>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleUpload} />
          <button className="equity-seed-btn" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            {importing ? "Importing…" : "📄 Import Paystub Excel (Total Salary Details.xlsx)"}
          </button>
          <p className="equity-seed-note">
            Reads each &quot;Yearly &lt;year&gt;&quot; sheet — Base, Bonus, Stock (RSU), Federal, SSN, Medicare,
            State W/H, State SDI, and Net/After-Tax Salary — broken down per pay period.
          </p>
          {importError && <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{importError}</p>}

          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid #e2e8f0" }}>
            {!startingManualYear ? (
              <button onClick={() => setStartingManualYear(true)}>Or track manually — no Excel needed</button>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <label style={{ fontSize: 12 }}>
                  Year
                  <input
                    type="number"
                    value={manualYearInput}
                    onChange={(e) => setManualYearInput(e.target.value)}
                    style={{ display: "block", width: 90 }}
                  />
                </label>
                <button onClick={startWithoutExcel}>Start {manualYearInput}</button>
                <button onClick={() => setStartingManualYear(false)}>Cancel</button>
              </div>
            )}
            <p className="equity-seed-note" style={{ marginTop: "0.5rem" }}>
              Creates an empty year with standard semi-monthly periods. Every salary Receipt you post from then on
              (Plaid or manual) automatically adds a line here, with Federal/SSN/Medicare/State fields you can edit yourself.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const years = payroll.years;
  const yr: PayrollYear = normalizePayrollYear(years.find((y) => y.year === activeYearLabel) ?? years[0]);
  const rows = yr.rows;
  const gross = row(rows, "Gross Salary");
  const federal = row(rows, "Federal");
  const ssn = row(rows, "SSN");
  const medicare = row(rows, "Medicare");
  const stateWH = row(rows, "State W/H");
  const stateSDI = row(rows, "State SDI");
  const totalTax = row(rows, "Total Tax");
  const netSalary = row(rows, "Net Salary", 1) ?? row(rows, "Net Salary", 0);
  const afterTax = row(rows, "After Tax Salary");
  const effective = row(rows, "Effective Salary");
  const k401 = row(rows, "401K");
  const k401Emplr = row(rows, "401K Emplr");
  const esppRow = row(rows, "ESPP");
  const baseRow = row(rows, "Base");
  const telRow = row(rows, "Telephone");
  const medicalRow = row(rows, "Medical");
  // Only present for a handful of old-employer years (a "no active project" bench
  // arrangement required paying part of a paycheck back) -- absent everywhere else.
  const refundRow = row(rows, "Refund");
  // Deliberately NOT adjusting for "RSU Excess Tax" here (tried it, reverted it) -- checked
  // two real vouchers with this credit and found it was entered inconsistently: one voucher's
  // Tax Deduction line already had the credit baked in, the other didn't. No single formula
  // predicts the real bank amount for both, so encoding one would be right for one period and
  // wrong for the next by coincidence. Leave those periods to a manual look instead of guessing.

  // 401(k) lifetime contribution history — one row per imported year, self + employer match.
  // Also reused by RetirementReport.tsx (see lib/payroll-401k.ts) for the Retirement tab's
  // employee/employer split.
  const k401ByYear = compute401kByYear(payroll);
  const k401LifetimeSelf = k401ByYear.reduce((s, r) => s + r.self, 0);
  const k401LifetimeEmployer = k401ByYear.reduce((s, r) => s + r.employer, 0);

  // Every imported year's full salary/tax picture, side by side -- see the "All Years" table
  // rendered near the Year pills below.
  const allYearsSummary = years
    .map((y) => computeYearSummary(y, equity))
    .sort((a, b) => b.year.localeCompare(a.year));

  // Every imported year's federal/state estimate, side by side -- see the "All Years" table
  // rendered near "Estimated Tax Liability" below. Uses the currently-selected filing status/HSA
  // coverage for every year (same single, global assumption the year-at-a-time view uses).
  const allYearsTaxEstimate = years
    .map((y) => computeYearTaxEstimate(y, transactions, accounts, equity, trades, filingStatus, hsaCoverage))
    .sort((a, b) => b.year.localeCompare(a.year));

  const allManualPeriods = yr.manualPeriods ?? [];
  // Two kinds share the same ManualPayrollPeriod record: a voucher-derived period (new pay
  // period the Excel doesn't cover) vs. a correction overlaid on an Excel-imported period
  // (periodIndex set) — the latter must NOT be added on top of the Excel row it corrects,
  // or totals would double-count it.
  const voucherPeriods = allManualPeriods.filter((m) => m.periodIndex === undefined);
  const overrideByIndex = new Map(allManualPeriods.filter((m) => m.periodIndex !== undefined).map((m) => [m.periodIndex!, m]));
  // Vouchers already explicitly assigned to a period via a manual override's txGuid (e.g. a
  // joining bonus paid the same date as the following regular paycheck) must not also be
  // auto-matched into another period whose own window happens to cover that same date.
  const claimedTxGuids = new Set(allManualPeriods.filter((m) => m.txGuid).map((m) => m.txGuid!));

  const manualGross = voucherPeriods.reduce((s, m) => s + m.base + m.telephone, 0);
  const manualFederal = voucherPeriods.reduce((s, m) => s + m.federal, 0);
  const manualSsn = voucherPeriods.reduce((s, m) => s + m.ssn, 0);
  const manualMedicare = voucherPeriods.reduce((s, m) => s + m.medicare, 0);
  const manualStateWH = voucherPeriods.reduce((s, m) => s + m.stateWH, 0);
  const manualStateSDI = voucherPeriods.reduce((s, m) => s + m.stateSDI, 0);
  const manualTax = voucherPeriods.reduce((s, m) => s + m.totalTax, 0);
  const manualNet = voucherPeriods.reduce((s, m) => s + m.net, 0);
  const manualK401 = voucherPeriods.reduce((s, m) => s + m.k401, 0);
  const manualK401Emplr = voucherPeriods.reduce((s, m) => s + (m.k401Emplr ?? 0), 0);
  const manualEspp = voucherPeriods.reduce((s, m) => s + (m.espp ?? 0), 0);
  const manualMedical = voucherPeriods.reduce((s, m) => s + m.medical, 0);
  const manualBase = voucherPeriods.reduce((s, m) => s + m.base, 0);
  const manualTelephone = voucherPeriods.reduce((s, m) => s + m.telephone, 0);

  // RSU vest records come from Reports > Equity (authoritative for date/shares/price) —
  // the Excel's own Stock row doesn't break its cumulative total down per vest.
  const yearVests = (equity?.grants ?? [])
    .flatMap((g) => g.vests.filter((v) => v.vestDate.startsWith(yr.year)).map((v) => ({ grant: g, vest: v })))
    .sort((a, b) => a.vest.vestDate.localeCompare(b.vest.vestDate));
  const stockVestedValue = yearVests
    .filter(({ vest }) => !vest.pending)
    .reduce((s, { vest }) => s + vest.shares * vest.vestPrice, 0);
  const stockScheduledShares = yearVests.filter(({ vest }) => vest.pending).reduce((s, { vest }) => s + vest.shares, 0);

  // Group vest events by date (multiple grants can vest the same day) and line them up in
  // chronological order with the Excel's "Stocks" columns — column N is the Nth vest date of
  // the year (quarterly: Mar/Jun/Sep/Dec), not a lump sum for the whole year.
  const vestGroups = Array.from(
    yearVests.reduce((map, item) => {
      const list = map.get(item.vest.vestDate) ?? [];
      list.push(item);
      map.set(item.vest.vestDate, list);
      return map;
    }, new Map<string, { grant: RsuGrant; vest: RsuVest }[]>())
  )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items], idx) => ({ date, items, stockIdx: idx }));

  // Real tax entered from an actual vesting pay-stub (see handlePaystubUpload) overrides the
  // Excel-imported "Stocks" column entirely for that date once it exists -- a brand-new vest
  // usually has no Excel figure at all yet, which is exactly the case this exists for. Returns
  // the same "null means genuinely no data yet" shape stockVal() does (rendered as "—", distinct
  // from a real $0), rather than coercing an absent override into 0.
  const vestTaxByDate = new Map((yr.manualVestTax ?? []).map((v) => [v.date, v]));
  function vestTax(date: string, stockIdx: number): {
    federal: number | null; ssn: number | null; medicare: number | null;
    stateWH: number | null; stateSDI: number | null; totalTax: number | null;
  } {
    const override = vestTaxByDate.get(date);
    if (override) return override;
    return {
      federal: stockVal(federal, stockIdx),
      ssn: stockVal(ssn, stockIdx),
      medicare: stockVal(medicare, stockIdx),
      stateWH: stockVal(stateWH, stockIdx),
      stateSDI: stockVal(stateSDI, stockIdx),
      totalTax: stockVal(totalTax, stockIdx),
    };
  }
  // Sum of every vest's real gross value -- computed LIVE from equity data (shares x vest
  // price actually received), the same authoritative source the Pay Periods table's own vest
  // rows use, NOT the Excel "Stocks" column, which is only as current as the last import and
  // can be entirely missing for a vest that happened after it (confirmed live: a brand-new vest
  // was completely absent from the Excel Stocks column, silently understating Gross Salary --
  // and therefore taxable wages/AGI -- by its full real value).
  const vestGrossTotal = vestGroups.reduce(
    (s, g) => s + g.items.reduce((gs, { vest }) => gs + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0),
    0
  );
  const VEST_TAX_FIELDS = new Set(["federal", "ssn", "medicare", "stateWH", "stateSDI", "totalTax"]);
  // Same override rule as vestTax() above, generalized across whichever of the 6 tax fields
  // this row is -- a real vesting pay-stub's numbers replace the Excel Stocks-column figure for
  // that date entirely, not just in the Pay Periods table display but in every year TOTAL that
  // feeds the Estimated Tax Liability cards, AGI, and Federal/State Withheld too.
  function vestStockTotal(baseRowForField: PayrollRow | undefined, field: keyof ManualPayrollPeriod): number {
    if (!VEST_TAX_FIELDS.has(field as string)) return baseRowForField?.stockValues?.reduce((s, v) => s + v, 0) ?? 0;
    return vestGroups.reduce((s, g) => {
      const override = vestTaxByDate.get(g.date);
      const v = override ? (override as unknown as Record<string, number>)[field as string] : (baseRowForField?.stockValues?.[g.stockIdx] ?? 0);
      return s + (v ?? 0);
    }, 0);
  }
  const stockFederal = vestStockTotal(federal, "federal");
  const stockSsn = vestStockTotal(ssn, "ssn");
  const stockMedicare = vestStockTotal(medicare, "medicare");
  const stockStateWH = vestStockTotal(stateWH, "stateWH");
  const stockStateSDI = vestStockTotal(stateSDI, "stateSDI");
  const stockTaxTotal = vestStockTotal(totalTax, "totalTax");
  // Net-of-withholding value of every vest -- same formula the Pay Periods table's own vest row
  // uses for its "Net" column, reused here so "After Tax Salary" gets the same live-vest fix
  // Gross/Tax already got (a vest that postdates the last Excel import was entirely missing from
  // this row's Excel-only Stocks column too, understating it the same way).
  const vestAfterTaxTotal = vestGroups.reduce((s, g) => {
    const grossVal = g.items.reduce((gs, { vest }) => gs + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
    const vt = vestTax(g.date, g.stockIdx);
    return s + grossVal - (vt.federal ?? 0) - (vt.ssn ?? 0) - (vt.medicare ?? 0) - (vt.stateWH ?? 0) - (vt.stateSDI ?? 0);
  }, 0);

  // Sum a row across every Excel period, substituting an override's value wherever one
  // exists for that period index, then add the vest total (Excel Stocks column, or a real
  // vesting pay-stub's override when one exists for that vest date).
  function overriddenTotal(baseRowForField: PayrollRow | undefined, field: keyof ManualPayrollPeriod): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? (Number(ov[field]) || 0) : (baseRowForField?.values[i] ?? 0);
    }
    return sum + vestStockTotal(baseRowForField, field);
  }
  function overriddenGrossTotal(): number {
    let sum = 0;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const ov = overrideByIndex.get(i);
      sum += ov ? ov.base + ov.telephone : (gross?.values[i] ?? 0);
    }
    return sum + vestGrossTotal;
  }

  // The most recently PAID period (by end date, not just latest index) -- used as the model
  // for projecting the rest of the year in Tax Planning: a single recent paystub reflects your
  // CURRENT elections (401k %, ESPP %, any raise) better than averaging across the whole year,
  // which would be dragged down by older, possibly-since-changed periods. Considers both
  // Excel-imported periods (override-aware) and voucher-derived periods, and only periods that
  // have actually ended (not the in-progress current period, which hasn't been paid yet).
  const lastPaidPeriod = (() => {
    type Candidate = {
      end: string; gross: number; federal: number; stateWH: number; medicare: number; k401: number; espp: number;
    };
    let best: Candidate | null = null;
    for (let i = 0; i < yr.periodLabels.length; i++) {
      const range = parsePeriodRange(yr.periodLabels[i], yr.year);
      if (!range || range.end > todayIso) continue;
      const ov = overrideByIndex.get(i);
      const g = ov ? ov.base + ov.telephone : gross?.values[i] ?? 0;
      if (!g) continue;
      const cand: Candidate = {
        end: range.end, gross: g,
        federal: ov ? ov.federal : federal?.values[i] ?? 0,
        stateWH: ov ? ov.stateWH : stateWH?.values[i] ?? 0,
        medicare: ov ? ov.medicare : medicare?.values[i] ?? 0,
        k401: ov ? ov.k401 : k401?.values[i] ?? 0,
        espp: ov ? (ov.espp ?? 0) : esppRow?.values[i] ?? 0,
      };
      if (!best || cand.end > best.end) best = cand;
    }
    for (const vp of voucherPeriods) {
      const range = parsePeriodRange(vp.label, yr.year);
      const end = range?.end ?? vp.label;
      if (end > todayIso) continue;
      const g = vp.base + vp.telephone;
      if (!g) continue;
      const cand: Candidate = { end, gross: g, federal: vp.federal, stateWH: vp.stateWH, medicare: vp.medicare, k401: vp.k401, espp: vp.espp ?? 0 };
      if (!best || cand.end > best.end) best = cand;
    }
    return best;
  })();

  const totalGross = overriddenGrossTotal() + manualGross;
  const totalFederal = overriddenTotal(federal, "federal") + manualFederal;
  const totalSsn = overriddenTotal(ssn, "ssn") + manualSsn;
  const totalMedicare = overriddenTotal(medicare, "medicare") + manualMedicare;
  const totalStateWH = overriddenTotal(stateWH, "stateWH") + manualStateWH;
  const totalStateSDI = overriddenTotal(stateSDI, "stateSDI") + manualStateSDI;
  const totalTaxAll = overriddenTotal(totalTax, "totalTax") + manualTax;
  const totalNet = overriddenTotal(netSalary, "net") + manualNet;
  // Unlike every other total above, After Tax Salary/Effective Salary have no corresponding
  // field on ManualPayrollPeriod (they're Excel-only imported columns, never recorded for a
  // manual/voucher period) -- so this doesn't attempt override-awareness for a manually-
  // corrected period, only the same concrete, confirmed gap just fixed for Gross/Tax: the raw
  // per-period values come straight from Excel, but the vest component is replaced with the
  // live equity-derived figure instead of the row's own (possibly missing/stale) stockValues.
  const totalAfterTax = (afterTax?.values ?? []).reduce((s, v) => s + v, 0) + vestAfterTaxTotal;
  const totalEffective = (effective?.values ?? []).reduce((s, v) => s + v, 0) + vestGrossTotal;
  const totalK401 = overriddenTotal(k401, "k401") + manualK401;
  const totalK401Emplr = overriddenTotal(k401Emplr, "k401Emplr") + manualK401Emplr;
  const totalEsppDeduction = overriddenTotal(esppRow, "espp") + manualEspp;
  const totalMedical = overriddenTotal(medicalRow, "medical") + manualMedical;
  const totalBaseYtd = overriddenTotal(baseRow, "base") + manualBase;
  const totalTelephoneYtd = overriddenTotal(telRow, "telephone") + manualTelephone;
  const effectiveRate = totalGross > 0 ? (totalTaxAll / totalGross) * 100 : 0;

  // ESPP purchases come from Reports > Equity the same way RSU vests do.
  const yearEspp = (equity?.esppPurchases ?? [])
    .filter((e) => e.purchaseDate.startsWith(yr.year))
    .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  const esppDiscountValue = yearEspp.reduce((s, e) => s + (e.marketPriceAtPurchase - e.purchasePrice) * e.shares, 0);

  // Federal tax estimate — totalGross is GROSS pay (Base+Bonus+Stock+other), not W-2 Box 1
  // federal taxable wages: a traditional 401(k) employee contribution is pretax and reduces
  // Box 1, so it has to come out here or the estimate overtaxes that money. (Assumes a
  // traditional, not Roth, 401(k) -- Roth contributions are post-tax and wouldn't reduce
  // wages; this app doesn't distinguish the two.) ESPP deductions are always post-tax and
  // correctly aren't subtracted. RSU-vest/ESPP-discount ordinary income is already included
  // in totalGross via payroll; only realized capital gains from shares actually SOLD (an
  // explicit salePrice on the vest/purchase) are added on top, split short/long term.
  const taxableWages = Math.max(0, totalGross - totalK401);
  const taxEstimateYear = listUsTaxYears().includes(yr.year) ? yr.year : listUsTaxYears()[0]!;
  // Federal filing deadline (April 15 the following year, ignoring extensions/weekend shifts --
  // an approximation, same convention as the HSA contribution deadline elsewhere in this file).
  // Once it's passed, that year's return is done -- Tax Planning only makes sense for a year
  // still open to act on, not one already filed and processed.
  const taxYearFilingDeadline = `${Number(taxEstimateYear) + 1}-04-15`;
  const taxYearIsOpenForPlanning = todayIso <= taxYearFilingDeadline;
  const employerTickers = employerTickerSet(equity);
  const gainEvents = [
    ...classifyRsuSales(equity?.grants ?? [], yr.year, 365),
    ...classifyEsppSales(equity?.esppPurchases ?? [], yr.year, 365),
    ...classifyTradingSales(trades ?? [], yr.year, 365, employerTickers),
  ];
  const gainTotals = summarizeCapitalGains(gainEvents);

  // Itemized deductions — matched from expense-ledger names (medical, mortgage interest,
  // property tax, state income tax paid, charitable). Shown in the UI so a miss is obvious
  // and fixable by renaming the ledger, rather than silently wrong.
  const deductionMatches = matchDeductionLedgers(accounts, transactions, yr.year);

  // Personal (non-payroll) HSA contributions — an above-the-line federal deduction (Form
  // 8889), capped at the IRS annual limit for the selected coverage tier. California doesn't
  // conform: it's added back for the CA AGI proxy below, not carried through.
  const hsaContributions = findHsaContributions(transactions, yr.year);
  const hsaContributionTotal = hsaContributions.reduce((s, h) => s + h.amount, 0);
  const hsaDeduction = computeHsaDeduction(taxEstimateYear, hsaCoverage, hsaContributionTotal);

  const interestDividendIncome = sumInterestDividendIncome(transactions, accounts, yr.year);
  const preliminaryAgi = Math.max(
    0,
    taxableWages +
      interestDividendIncome +
      gainTotals.shortTermGainTaxable +
      gainTotals.longTermGainTaxable -
      gainTotals.ordinaryLossDeduction -
      hsaDeduction
  );
  const federalItemized = computeItemizedDeduction(taxEstimateYear, preliminaryAgi, {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    stateIncomeTaxPaid: deductionTotal(deductionMatches, "stateIncomeTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  });
  const taxEstimate = estimateUsFederalTax({
    taxYear: taxEstimateYear,
    filingStatus,
    wages: taxableWages,
    federalWithheld: totalFederal,
    // Medicare wages aren't reduced by a 401(k) deferral (still FICA-taxable), unlike the
    // federal-income-tax wages above -- use gross pay, not taxableWages.
    medicareWages: totalGross,
    medicareWithheld: totalMedicare,
    interestDividendIncome,
    shortTermGainTaxable: gainTotals.shortTermGainTaxable,
    longTermGainTaxable: gainTotals.longTermGainTaxable,
    capitalLossDeduction: gainTotals.ordinaryLossDeduction,
    aboveLineDeduction: hsaDeduction,
    itemizedDeduction: federalItemized.total,
  });

  // State tax — dispatches to whichever state the user actually lived/worked in for this tax
  // year (lib/tax-state-residency.ts). AZ conforms to federal HSA treatment (no addback needed);
  // CA and NJ don't, so the HSA deduction is added back to approximate state AGI for those two.
  const stateResidency = resolveStateResidency(taxEstimateYear);
  const stateAgi = stateResidency.code === "AZ" ? taxEstimate.agi : taxEstimate.agi + taxEstimate.aboveLineDeduction;
  const stateItemizedInputs = {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    mortgageInterest: deductionTotal(deductionMatches, "mortgageInterest"),
    charitable: deductionTotal(deductionMatches, "charitable"),
  };
  const stateItemized =
    stateResidency.code === "NJ"
      ? computeNjPropertyTaxDeduction(stateItemizedInputs.propertyTax)
      : stateResidency.code === "AZ"
        ? computeAzItemizedDeduction(stateAgi, stateItemizedInputs)
        : computeCaItemizedDeduction(stateAgi, stateItemizedInputs, resolveCaTaxRules(taxEstimateYear, filingStatus).itemizedDeductionPhaseoutThreshold);
  const stateTaxEstimate =
    stateResidency.code === "NJ"
      ? estimateNjStateTax({
          taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
          propertyTax: stateItemizedInputs.propertyTax, stateWithheld: totalStateWH,
        })
      : stateResidency.code === "AZ"
        ? estimateAzStateTax({
            taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
            itemizedDeduction: stateItemized, stateWithheld: totalStateWH,
          })
        : estimateCaStateTax({
            taxYear: taxEstimateYear, filingStatus, agi: stateAgi,
            itemizedDeduction: stateItemized, stateWithheld: totalStateWH,
          });

  // Computed "what if" scenarios (own tax engine only, no external AI/data-sharing) -- see
  // lib/tax-planning.ts. Projects the rest of the tax year forward -- remaining semi-monthly
  // paychecks are modeled on lastPaidPeriod (the most recent actual paystub, computed above),
  // not a whole-year average, plus any shares still scheduled to vest at today's live price --
  // rather than only looking at year-to-date actuals. RSU/ESPP hold-timing scenarios are
  // skipped internally when no live price is available.
  const { scenarios: taxPlanningScenarios, projection: taxPlanningProjection } = computeTaxPlanningScenarios({
    taxYear: taxEstimateYear,
    filingStatus,
    stateCode: stateResidency.code,
    stateName: stateResidency.name,
    longTermHoldingDays: taxEstimate.rules.longTermHoldingDays,
    taxableWages,
    totalGross,
    totalFederal,
    totalMedicare,
    shortTermGainTaxable: gainTotals.shortTermGainTaxable,
    longTermGainTaxable: gainTotals.longTermGainTaxable,
    capitalLossDeduction: gainTotals.ordinaryLossDeduction,
    federalItemizedTotal: federalItemized.total,
    hsaContributionTotal,
    hsaCoverage,
    totalK401,
    totalStateWH,
    stateItemizedTotal: stateItemized,
    stateHsaConforms: stateResidency.code === "AZ",
    baselineFederalStandardDeduction: taxEstimate.rules.standardDeduction,
    totalEsppYtd: totalEsppDeduction,
    lastPeriod: lastPaidPeriod,
    grants: equity?.grants ?? [],
    esppPurchases: equity?.esppPurchases ?? [],
    livePrice: livePrice ?? null,
    todayIso,
  });
  const taxPlanningTotalSavings = taxPlanningScenarios.reduce((s, sc) => s + sc.totalSavings, 0);
  // Positive = projected to owe more; negative = projected refund. FullYearProjection only
  // stores a one-sided federal balanceDue (0 when it'd actually be a refund) and no state
  // balance field at all -- computed directly here instead so both directions render correctly.
  const projectedFederalBalance = taxPlanningProjection.projectedFederalTax - taxPlanningProjection.fullYearFederalWithheld;
  const projectedStateBalance = taxPlanningProjection.projectedStateTax - taxPlanningProjection.fullYearStateWithheld;

  const summaryCards: { label: string; value: number; sub: string; onClick?: () => void; icon: IconKind; color: string }[] = [
    { label: "Gross Salary", value: totalGross, sub: "Base + Bonus + Stock + other — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Gross Salary", row: gross, total: totalGross, isGross: true }), icon: "cash", color: "#1e40af" },
    { label: "Total Tax", value: totalTaxAll, sub: `${effectiveRate.toFixed(1)}% effective rate — click for details →`, onClick: () => setPeriodBreakdownModal({ label: "Total Tax", row: totalTax, total: totalTaxAll, field: "totalTax" }), icon: "receipt", color: "#dc2626" },
    { label: "Net Salary", value: totalNet, sub: "after deductions — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Net Salary", row: netSalary, total: totalNet, field: "net" }), icon: "wallet", color: "#16a34a" },
    { label: "After Tax Salary", value: totalAfterTax, sub: "take-home — click for details →", onClick: () => setPeriodBreakdownModal({ label: "After Tax Salary", row: afterTax, total: totalAfterTax }), icon: "bank", color: "#0891b2" },
    { label: "401K (Employee)", value: totalK401, sub: "payroll deduction — click for details →", onClick: () => setPeriodBreakdownModal({ label: "401K (Employee)", row: k401, total: totalK401, field: "k401" }), icon: "shield", color: "#7c3aed" },
    { label: "401K Employer Match", value: totalK401Emplr, sub: "not in the paycheck deposit — click for details →", onClick: () => setPeriodBreakdownModal({ label: "401K Employer Match", row: k401Emplr, total: totalK401Emplr, field: "k401Emplr" }), icon: "shield", color: "#9333ea" },
    { label: "ESPP Deduction", value: totalEsppDeduction, sub: `${fmt(esppDiscountValue)} discount value — click for details →`, onClick: () => setShowEsppModal(true), icon: "tag", color: "#d97706" },
    { label: "Stock (RSU) Vested", value: stockVestedValue, sub: "click for vest details →", onClick: () => setShowRsuModal(true), icon: "stock", color: "#1e40af" },
    { label: "Effective Salary", value: totalEffective, sub: "incl. employer 401K + ESPP — click for details →", onClick: () => setPeriodBreakdownModal({ label: "Effective Salary", row: effective, total: totalEffective }), icon: "trending-up", color: "#16a34a" },
  ];

  function openVoucherModal(tx: Tx) {
    setVoucherModalTx(tx);
  }

  // Handles both cases: editing an existing ManualPayrollPeriod (voucher-derived, or an
  // already-created Excel correction) when editingTarget.id is set, or creating a brand
  // new correction overlay for an Excel period when it's null.
  async function saveEdit() {
    if (!editingTarget) return;
    setSavingManual(true);
    try {
      const federalV = Number(manualForm.federal) || 0;
      const ssnV = Number(manualForm.ssn) || 0;
      const medicareV = Number(manualForm.medicare) || 0;
      const stateWHV = Number(manualForm.stateWH) || 0;
      const stateSDIV = Number(manualForm.stateSDI) || 0;
      const fields = {
        base: Number(manualForm.base) || 0,
        telephone: Number(manualForm.telephone) || 0,
        medical: Number(manualForm.medical) || 0,
        k401: Number(manualForm.k401) || 0,
        k401Emplr: Number(manualForm.k401Emplr) || 0,
        espp: Number(manualForm.espp) || 0,
        federal: federalV,
        ssn: ssnV,
        medicare: medicareV,
        stateWH: stateWHV,
        stateSDI: stateSDIV,
        totalTax: federalV + ssnV + medicareV + stateWHV + stateSDIV,
        net: Number(manualForm.net) || 0,
        estimated: false as const,
      };
      const updatedYears = payroll!.years.map((y) => {
        if (y.year !== yr.year) return y;
        const existing = y.manualPeriods ?? [];
        if (editingTarget.id) {
          return { ...y, manualPeriods: existing.map((x) => (x.id === editingTarget.id ? { ...x, ...fields } : x)) };
        }
        const newPeriod: ManualPayrollPeriod = { id: crypto.randomUUID(), label: editingTarget.label, periodIndex: editingTarget.periodIndex, ...fields };
        return { ...y, manualPeriods: [...existing, newPeriod] };
      });
      await onSave({ ...payroll!, years: updatedYears });
      setEditingTarget(null);
    } finally {
      setSavingManual(false);
    }
  }

  function startEditExisting(m: ManualPayrollPeriod) {
    setManualForm({
      base: String(m.base), telephone: String(m.telephone), medical: String(m.medical),
      k401: String(m.k401), k401Emplr: String(m.k401Emplr ?? 0), espp: String(m.espp ?? 0),
      federal: String(m.federal), ssn: String(m.ssn), medicare: String(m.medicare),
      stateWH: String(m.stateWH), stateSDI: String(m.stateSDI), net: String(m.net),
    });
    setEditingTarget({ id: m.id, periodIndex: m.periodIndex, label: m.label });
  }

  function startEditExcel(i: number, label: string) {
    setManualForm({
      base: String(at(baseRow, i)), telephone: String(at(telRow, i)), medical: String(at(medicalRow, i)),
      k401: String(at(k401, i)), k401Emplr: String(at(k401Emplr, i)), espp: String(at(esppRow, i)),
      federal: String(at(federal, i)), ssn: String(at(ssn, i)), medicare: String(at(medicare, i)),
      stateWH: String(at(stateWH, i)), stateSDI: String(at(stateSDI, i)), net: String(at(netSalary, i)),
    });
    setEditingTarget({ id: null, periodIndex: i, label });
  }

  return (
    <div className="data-panel tax-report">
      <div className="equity-header">
        <div className="equity-title-row">
          <h3>Tax &amp; Paystub Details</h3>
          <div className="equity-price-row">
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleUpload} />
            <input ref={paystubFileInputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handlePaystubUpload} />
            {!readOnly && (
              <>
                <button className="equity-refresh" onClick={() => paystubFileInputRef.current?.click()} disabled={parsingPaystub}>
                  {parsingPaystub ? "Reading…" : "📄 Upload Paystub PDF"}
                </button>
                <button className="equity-refresh" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                  {importing ? "Importing…" : "↻ Re-import from Excel"}
                </button>
              </>
            )}
            {onViewDocuments && (
              <button className="equity-refresh" onClick={onViewDocuments} title="Archived pay stub PDFs">
                📄 Documents
              </button>
            )}
            <ExportButton
              onExport={async () => {
                const header = ["Period", "Gross", "Federal", "SSN", "Medicare", "State W/H", "State SDI", "Total Tax", "Net"];
                const body = yr.periodLabels.map((label, i) => [
                  label || `Period ${i + 1}`,
                  at(gross, i),
                  at(federal, i),
                  at(ssn, i),
                  at(medicare, i),
                  at(stateWH, i),
                  at(stateSDI, i),
                  at(totalTax, i),
                  at(netSalary, i),
                ]);
                await exportWorkbook(`Tax & Paystub Details — ${yr.year}.xlsx`, [{ name: `${yr.year}`, rows: [header, ...body] }]);
              }}
            />
          </div>
        </div>
        {importError && <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{importError}</p>}
        {paystubError && <p className="equity-pdf-error" style={{ marginTop: "0.5rem" }}>{paystubError}</p>}
        <p className="equity-seed-note">
          Imported {new Date(payroll.importedAt).toLocaleDateString()} from {payroll.sourceFileName}
        </p>

        {paystubReview && (() => {
          const { target, parsed, tieOut, priorSaved } = paystubReview;
          const netVariance = tieOut ? tieOut.voucherNet - parsed.netPay : 0;
          const netMismatch = tieOut && Math.abs(netVariance) > 1;
          const isVest = target.kind === "vest";
          const priorPeriod = !isVest ? (priorSaved as ManualPayrollPeriod | null) : null;
          const priorVest = isVest ? (priorSaved as ManualVestTax | null) : null;
          const resultingNet = paystubMode === "add" && priorPeriod ? priorPeriod.net + parsed.netPay : parsed.netPay;
          const resultingVestTax = paystubMode === "add" && priorVest ? priorVest.totalTax + parsed.totalTax : parsed.totalTax;
          const title = isVest
            ? `${new Date(target.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} Vesting`
            : periodEndLabel(target.label, yr.year);
          return (
            <div className="equity-inline-detail" style={{ marginTop: "0.75rem", border: "1px solid #cbd5e1", borderRadius: 8, padding: "0.75rem" }}>
              <strong>Parsed paystub — {title}</strong>
              {parsed.pageCount > 1 && (
                <p style={{ fontSize: 12, opacity: 0.7, margin: "0.25rem 0 0" }}>
                  This PDF has {parsed.pageCount} Pay Statement pages (one per RSU lot vesting this date) — summed into the figures below.
                </p>
              )}
              {isVest && (
                <p style={{ fontSize: 12, opacity: 0.7, margin: "0.25rem 0 0" }}>
                  Matched to this RSU vest by date, not a pay period or voucher — a vesting pay-stub never links to a posted Receipt.
                </p>
              )}
              {(priorPeriod || priorVest) && (
                <div style={{ margin: "0.5rem 0", padding: "0.5rem", background: "#fefce8", borderRadius: 6, fontSize: 13 }}>
                  This {isVest ? "vest" : "period"} already has saved data ({isVest ? fmt(priorVest!.totalTax) : fmt(priorPeriod!.net)} {isVest ? "total tax" : "net"}) —
                  NVIDIA issues one Pay Statement PDF (or, for a vest, one page within one PDF) per RSU lot vesting the same day,
                  so this is likely another lot from the same date, not a re-upload.
                  <div style={{ display: "flex", gap: "1rem", marginTop: "0.4rem" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                      <input type="radio" checked={paystubMode === "add"} onChange={() => setPaystubMode("add")} />
                      Add to existing total
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                      <input type="radio" checked={paystubMode === "replace"} onChange={() => setPaystubMode("replace")} />
                      Replace existing data
                    </label>
                  </div>
                  <p style={{ margin: "0.4rem 0 0", fontWeight: 600 }}>
                    Resulting {isVest ? "Total Tax" : "Net"} for this {isVest ? "vest" : "period"}: {fmt(isVest ? resultingVestTax : resultingNet)}
                  </p>
                </div>
              )}
              <div className="tax-parsed-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.4rem", margin: "0.5rem 0", fontSize: 13 }}>
                {!isVest && <span>Base: {fmt(parsed.base)}</span>}
                {!isVest && <span>Telephone: {fmt(parsed.telephone)}</span>}
                {!isVest && <span>Medical: {fmt(parsed.medical)}</span>}
                {!isVest && <span>401K: {fmt(parsed.k401)}</span>}
                {!isVest && <span>401K Employer: {fmt(parsed.k401Emplr)}</span>}
                {!isVest && <span>ESPP: {fmt(parsed.espp)}</span>}
                <span>Federal: {fmt(parsed.federal)}</span>
                <span>SSN: {fmt(parsed.ssn)}</span>
                <span>Medicare: {fmt(parsed.medicare)}</span>
                <span>State W/H: {fmt(parsed.stateWH)}</span>
                <span>State SDI: {fmt(parsed.stateSDI)}</span>
                <span><strong>Total Tax: {fmt(parsed.totalTax)}</strong></span>
                {!isVest && <span><strong>Net: {fmt(parsed.netPay)}</strong></span>}
              </div>
              {parsed.distribution.length > 0 && (
                <div style={{ fontSize: 12, opacity: 0.8, margin: "0.25rem 0" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                    <span>Distribution:</span>
                    {parsed.distribution.map((d) => (
                      <span key={d.accountLast4} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input
                          value={bankNames[d.accountLast4] ?? ""}
                          onChange={(e) => setBankName(d.accountLast4, e.target.value)}
                          placeholder={`${d.accountType} ...${d.accountLast4}`}
                          title="Name this account (e.g. BofA, Chase) -- remembered for every future paystub"
                          style={{ width: 90, fontSize: 12, padding: "1px 4px" }}
                        />
                        <span className="equity-amt">...{d.accountLast4} {fmt(d.amount)}</span>
                      </span>
                    ))}
                  </div>
                  {parsed.distribution.some((d) => bankNames[d.accountLast4]) && (
                    <p style={{ margin: "0.3rem 0 0" }}>
                      By account: <span className="equity-amt">{Object.entries(
                        parsed.distribution.reduce<Record<string, number>>((groups, d) => {
                          const name = bankNames[d.accountLast4] || `...${d.accountLast4}`;
                          groups[name] = (groups[name] || 0) + d.amount;
                          return groups;
                        }, {})
                      ).map(([name, amount]) => `${name} ${fmt(amount)}`).join(", ")}</span>
                    </p>
                  )}
                </div>
              )}
              {!isVest && (tieOut ? (
                <p className="tax-tieout-msg" style={{ fontSize: 13, fontWeight: 600, color: netMismatch ? "#dc2626" : "#16a34a", margin: "0.4rem 0" }}>
                  {netMismatch
                    ? `⚠ Linked voucher (${tieOut.voucher.type} #${tieOut.voucher.number || "—"}) shows ${fmt(tieOut.voucherNet)} — differs from this paystub's real Net by ${fmt(netVariance)}.`
                    : `✓ Linked voucher (${tieOut.voucher.type} #${tieOut.voucher.number || "—"}) matches this paystub's real Net.`}
                </p>
              ) : (
                <p style={{ fontSize: 13, opacity: 0.7, margin: "0.4rem 0" }}>No voucher linked to this period yet.</p>
              ))}
              {parsed.warnings.length > 0 && (
                <ul style={{ fontSize: 12, color: "#b45309", margin: "0.4rem 0", paddingLeft: "1.2rem" }}>
                  {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button className="equity-refresh" onClick={savePaystubReview} disabled={savingPaystub}>
                  {savingPaystub ? "Saving…" : priorSaved && paystubMode === "add" ? "Add to Tax Tab" : "Save to Tax Tab"}
                </button>
                <button className="equity-refresh" onClick={() => setPaystubReview(null)} disabled={savingPaystub}>
                  Discard
                </button>
              </div>
            </div>
          );
        })()}

        {(() => {
          // A transition year genuinely has TWO+ employers (e.g. 2017: TechM through Aug, then
          // Accrete) -- filtering by either one must still surface that year, and the chip must
          // show/hover both, not just whichever happened to be listed first.
          const employers = Array.from(new Set(years.flatMap((y) => y.employers ?? []))).sort();
          const visibleYears = employerFilter === "All" ? years : years.filter((y) => y.employers?.includes(employerFilter));
          return (
            <div className="equity-grant-filter">
              {employers.length > 0 && (
                <>
                  <span className="equity-grant-filter-label">Employer:</span>
                  <select
                    value={employerFilter}
                    onChange={(e) => {
                      setEmployerFilter(e.target.value);
                      // Jump to the first visible year under the new filter so the chip row and
                      // the figures below it never disagree about which year is showing.
                      const next = e.target.value === "All" ? years : years.filter((y) => y.employers?.includes(e.target.value));
                      if (next.length && !next.some((y) => y.year === activeYearLabel)) {
                        setSelectedYear(next[0].year);
                        setViewPeriod(null);
                      }
                    }}
                  >
                    <option value="All">All employers</option>
                    {employers.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span className="equity-grant-filter-label">Year:</span>
              {visibleYears.map((y) => (
                <button
                  key={y.year}
                  className={`equity-grant-filter-chip${yr.year === y.year ? " equity-grant-filter-chip--active" : ""}`}
                  onClick={() => { setSelectedYear(y.year); setViewPeriod(null); }}
                  title={y.employers?.join(" + ")}
                >
                  {y.year}
                </button>
              ))}
            </div>
          );
        })()}

        {allYearsSummary.length > 1 && (() => {
          const employersByYear = new Map(years.map((y) => [y.year, y.employers]));
          const filteredSummary =
            employerFilter === "All"
              ? allYearsSummary
              : allYearsSummary.filter((r) => employersByYear.get(r.year)?.includes(employerFilter));
          return (
          <details style={{ margin: "0 0 0.75rem" }}>
            <summary className="tax-summary-figure" style={{ fontSize: 12, cursor: "pointer", listStyle: "none", fontWeight: 600 }}>
              All Years — Salary &amp; Tax Summary ({filteredSummary.length} years, click to expand)
            </summary>
            <div className="columnar-report-scroll" style={{ marginTop: "0.5rem" }}>
              <table className="equity-table equity-drilldown-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Employer</th>
                    <th className="right">Gross</th>
                    <th className="right">Total Tax</th>
                    <th className="right">Net</th>
                    <th className="right">After Tax</th>
                    <th className="right">401(k) Self</th>
                    <th className="right">401(k) Employer</th>
                    <th className="right">ESPP</th>
                    <th className="right">RSU Vested</th>
                    <th className="right">Effective</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSummary.map((r) => (
                    <tr key={r.year}>
                      <td>
                        <button type="button" style={linkBtnStyle} onClick={() => { setSelectedYear(r.year); setViewPeriod(null); }}>
                          {r.year}
                        </button>
                      </td>
                      <td>{employersByYear.get(r.year)?.join(" + ") || "—"}</td>
                      <td className="right equity-amt">{fmt(r.gross)}</td>
                      <td className="right equity-amt">{fmt(r.totalTax)}</td>
                      <td className="right equity-amt">{fmt(r.net)}</td>
                      <td className="right equity-amt">{fmt(r.afterTax)}</td>
                      <td className="right equity-amt">{fmt(r.k401Self)}</td>
                      <td className="right equity-amt">{fmt(r.k401Employer)}</td>
                      <td className="right equity-amt">{fmt(r.espp)}</td>
                      <td className="right equity-amt">{fmt(r.rsuVested)}</td>
                      <td className="right equity-amt">{fmt(r.effective)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td></td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.gross, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.totalTax, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.net, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.afterTax, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.k401Self, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.k401Employer, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.espp, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.rsuVested, 0))}</td>
                    <td className="right equity-amt">{fmt(filteredSummary.reduce((s, r) => s + r.effective, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </details>
          );
        })()}

        <div className="equity-summary-row">
          {summaryCards.map((c) => (
            <div key={c.label} className="equity-summary-col">
              <div
                className="equity-summary-card"
                style={c.onClick ? { cursor: "pointer" } : undefined}
                onClick={c.onClick}
              >
                <StatIcon kind={c.icon} color={c.color} />
                <div className="equity-summary-card-body">
                  <span>{c.label}</span>
                  <AutoFitAmount className="equity-amt" text={fmt(c.value)} />
                  <em>{c.sub}</em>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {k401ByYear.length > 0 && (
        <details style={{ margin: "0 0 0.75rem" }}>
          <summary className="tax-summary-figure" style={{ fontSize: 12, cursor: "pointer", listStyle: "none", fontWeight: 600 }}>
            401(k) Contributions by Year — lifetime {fmt(k401LifetimeSelf)} self + {fmt(k401LifetimeEmployer)} employer ={" "}
            {fmt(k401LifetimeSelf + k401LifetimeEmployer)} (click to expand)
          </summary>
          <table className="equity-table equity-drilldown-table" style={{ marginTop: "0.5rem" }}>
            <thead>
              <tr>
                <th>Year</th>
                <th className="right">Your Contribution</th>
                <th className="right">Employer Match</th>
                <th className="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {k401ByYear.map((r) => (
                <tr key={r.year}>
                  <td>{r.year}</td>
                  <td className="right">{fmt(r.self)}</td>
                  <td className="right">{fmt(r.employer)}</td>
                  <td className="right">{fmt(r.self + r.employer)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Lifetime</td>
                <td className="right">{fmt(k401LifetimeSelf)}</td>
                <td className="right">{fmt(k401LifetimeEmployer)}</td>
                <td className="right">{fmt(k401LifetimeSelf + k401LifetimeEmployer)}</td>
              </tr>
            </tfoot>
          </table>
        </details>
      )}

      <div className="equity-section-head">
        <h4>Pay Periods — {yr.year}</h4>
      </div>

      <table className="equity-table equity-drilldown-table">
        <thead>
          <tr>
            <th>Period</th>
            <th className="right">Gross</th>
            <th className="right">Federal</th>
            <th className="right">SSN</th>
            <th className="right">Medicare</th>
            <th className="right">State W/H</th>
            <th className="right">State SDI</th>
            <th className="right">Total Tax</th>
            <th className="right">Net</th>
            <th>ESPP</th>
            <th>Voucher</th>
          </tr>
        </thead>
        <tbody>
          {(() => {
          // Excel-imported periods and voucher-derived manual periods used to render as two
          // separate blocks (all Excel rows, THEN all manual rows) regardless of actual date --
          // for a year with irregular/overlapping historical periods (job changes, old employer
          // bi-weekly cycles) this scattered the table, e.g. "Jan 29" at the top and "Jan 15"
          // stuck in a disconnected block further down. Both kinds now carry a sortEnd (the
          // period's real end date) and get merged into one chronologically-ordered list.
          type Row = { sortEnd: string; node: React.ReactNode };
          const excelEntries = yr.periodLabels.map((label, i): Row | null => {
            // Once a period has a correction overlaid on it, the manual entry below
            // is the sole renderer for it (full edit history, no duplicate row).
            if (overrideByIndex.has(i)) return null;
            const g = at(gross, i);
            const fed = at(federal, i);
            const ssnV = at(ssn, i);
            const med = at(medicare, i);
            const swh = at(stateWH, i);
            const ssdi = at(stateSDI, i);
            const t = at(totalTax, i);
            const net = at(netSalary, i);
            if (!g && !t && !fed) return null; // skip empty future periods
            const key = `excel-${i}`;
            // A period can legitimately have more than one voucher -- e.g. a referral bonus
            // paid the same day as the regular paycheck, as its own separate Receipt. Sum
            // companions into the tie-out check, but only when they're SAME-DAY as the primary
            // voucher and not wildly larger -- otherwise this was sweeping in unrelated large
            // transactions (RSU vest/sale proceeds, etc.) that happen to fall within the same
            // 15-day matching window and loosely match "salary", producing worse false
            // mismatches than the single-voucher check it was meant to improve on.
            const allLinkedTxs = label ? findAllPayrollVouchers(transactions, yr.year, label, yr.periodLabels, claimedTxGuids) : [];
            const linkedTx = allLinkedTxs[0];
            const primaryNet = linkedTx ? voucherNetAmount(linkedTx, accounts) : 0;
            const linkedTxs = linkedTx
              ? allLinkedTxs.filter((tx) => tx === linkedTx || (tx.date === linkedTx.date && voucherNetAmount(tx, accounts) <= primaryNet * 2))
              : [];
            const match = yr.matches?.find((mt) => mt.periodIndex === i);
            // A "Refund" (money paid back to the employer separately, e.g. a bench/no-project
            // arrangement) reduces Net Salary but is never netted into the actual paycheck
            // deposit -- the voucher's real bank amount reflects the PRE-refund figure. Add it
            // back so the tie-out check compares against what actually hit the bank. A no-op
            // everywhere refund is 0 (every employer/year except this one).
            const expectedNet = at(netSalary, i) + at(refundRow, i);
            const variance = match ? match.depositAmount - expectedNet : 0;
            const varianceFlag = match && Math.abs(variance) > 1;
            const linkedNet = linkedTxs.reduce((s, tx) => s + voucherNetAmount(tx, accounts), 0);
            const linkedVariance = linkedTxs.length ? linkedNet - expectedNet : 0;
            const linkedVarianceFlag = linkedTxs.length > 0 && Math.abs(linkedVariance) > 1;
            const range = label ? parsePeriodRange(label, yr.year) : null;
            const isPast = range ? range.end < todayIso : false;
            const periodEspp = range ? yearEspp.filter((e) => e.purchaseDate >= range.start && e.purchaseDate <= range.end) : [];
            const periodEsppShares = periodEspp.reduce((s, e) => s + e.shares, 0);
            const node = (
              <Fragment key={key}>
                <tr onClick={() => setViewPeriod({ type: "excel", index: i })} style={{ cursor: "pointer" }}>
                  <td title={label || undefined}>{label ? periodEndLabel(label, yr.year) : `Period ${i + 1}`}</td>
                  <td className="right">{fmt(g)}</td>
                  <td className="right">{fmt(fed)}</td>
                  <td className="right">{fmt(ssnV)}</td>
                  <td className="right">{fmt(med)}</td>
                  <td className="right">{fmt(swh)}</td>
                  <td className="right">{fmt(ssdi)}</td>
                  <td className="right">{fmt(t)}</td>
                  <td className="right">{fmt(net)}</td>
                  <td>
                    {periodEspp.length > 0 ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); setPeriodEsppModal({ label: label || `Period ${i + 1}`, items: periodEspp }); }}
                        style={linkBtnStyle}
                      >
                        🏷️ <span className="equity-amt">{periodEsppShares.toLocaleString()} sh</span>
                      </button>
                    ) : (
                      <span style={{ opacity: 0.3 }}>—</span>
                    )}
                  </td>
                  <td>
                    {linkedTx ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); openVoucherModal(linkedTx); }}
                        title={
                          privacyMode
                            ? `${linkedTxs.length > 1 ? `${linkedTxs.length} vouchers this period (e.g. regular pay + a bonus), summed for tie-out.` : linkedTx.narration || ""}${linkedVarianceFlag ? " — combined voucher amount differs from expected net." : ""}`
                            : `${linkedTxs.length > 1 ? `${linkedTxs.length} vouchers this period (e.g. regular pay + a bonus), summed for tie-out: ${linkedTxs.map((tx) => `${tx.type} #${tx.number || "—"} ${fmt(voucherNetAmount(tx, accounts))}`).join(", ")}. ` : linkedTx.narration || ""}${linkedVarianceFlag ? ` — combined voucher amount ${fmt(linkedNet)} differs from expected net ${fmt(expectedNet)} by ${fmt(linkedVariance)}` : ""}`
                        }
                        style={{ ...linkBtnStyle, ...(linkedVarianceFlag ? { color: "#dc2626", fontWeight: 600 } : undefined) }}
                      >
                        {linkedVarianceFlag ? "⚠" : "🔗"} {linkedTx.type} #{linkedTx.number || "—"} · {new Date(linkedTx.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                        {linkedTxs.length > 1 && ` +${linkedTxs.length - 1} more`}
                      </button>
                    ) : match ? (
                      <span
                        className="equity-amt"
                        title={`Confirmed via Plaid on ${new Date(match.confirmedAt).toLocaleDateString()}${varianceFlag ? (privacyMode ? " — differs from expected net." : ` — differs from expected net by ${fmt(variance)}`) : ""}`}
                        style={{ color: varianceFlag ? "#dc2626" : "#16a34a" }}
                      >
                        ✓ {fmt(match.depositAmount)} (no voucher link)
                      </span>
                    ) : (
                      <span style={{ opacity: 0.4 }}>{isPast ? "Not posted" : "—"}</span>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
            return { sortEnd: range ? range.end : "9999-99-99", node };
          }).filter((x): x is Row => x !== null);

          const manualEntries: Row[] = allManualPeriods.map((m) => {
            const key = `manual-${m.id}`;
            const isOverride = m.periodIndex !== undefined;
            const tx = m.txGuid ? transactions.find((t) => t.guid === m.txGuid) : findPayrollVoucher(transactions, yr.year, m.label, yr.periodLabels, claimedTxGuids);
            const txNet = tx ? voucherNetAmount(tx, accounts) : 0;
            const txVarianceFlag = !!tx && Math.abs(txNet - m.net) > 1;
            const editing = editingTarget?.id === m.id;
            const mRange = parsePeriodRange(m.label, yr.year);
            const mEspp = mRange ? yearEspp.filter((e) => e.purchaseDate >= mRange.start && e.purchaseDate <= mRange.end) : [];
            const mEsppShares = mEspp.reduce((s, e) => s + e.shares, 0);
            const node = (
              <Fragment key={key}>
                {/* Background only ever flags "still using estimated numbers, needs your input" (amber)
                    -- NOT "this row was edited/corrected at some point," which is permanent history,
                    not an action item, and confusingly looked identical to a still-needs-attention
                    flag when it kept its own background color here. The "(edited)"/"(from voucher,
                    edited)" text label below still records that provenance, just without implying
                    the row needs anything further. */}
                <tr onClick={() => setViewPeriod({ type: "manual", id: m.id })} style={{ cursor: "pointer", background: m.estimated ? "#fffbeb" : undefined }}>
                  <td title={`${m.label} — ${isOverride ? "corrected from the Excel import" : "posted in the vault but not yet in the imported Excel file"}`}>
                    {periodEndLabel(m.label, yr.year)} <em style={{ fontSize: 10, opacity: 0.6 }}>{isOverride ? "(edited)" : m.estimated ? "(from voucher, estimated)" : "(from voucher, edited)"}</em>
                  </td>
                  <td className="right equity-amt">{fmt(m.base + m.telephone)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.federal)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.ssn)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.medicare)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.stateWH)}</td>
                  <td className="right equity-amt" style={m.estimated ? { opacity: 0.6, fontStyle: "italic" } : undefined}>{fmt(m.stateSDI)}</td>
                  <td className="right equity-amt">{fmt(m.totalTax)}</td>
                  <td className="right equity-amt">{fmt(m.net)}</td>
                  <td>
                    {mEspp.length > 0 ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); setPeriodEsppModal({ label: m.label, items: mEspp }); }}
                        style={linkBtnStyle}
                      >
                        🏷️ <span className="equity-amt">{mEsppShares.toLocaleString()} sh</span>
                      </button>
                    ) : (
                      <span style={{ opacity: 0.3 }}>—</span>
                    )}
                  </td>
                  <td>
                    {tx ? (
                      <button
                        className="tax-voucher-link"
                        onClick={(e) => { e.stopPropagation(); openVoucherModal(tx); }}
                        title={`${tx.narration || ""}${txVarianceFlag ? (privacyMode ? " — voucher amount differs from this period's net." : ` — voucher amount ${fmt(txNet)} differs from this period's net ${fmt(m.net)} by ${fmt(txNet - m.net)}`) : ""}`}
                        style={{ ...linkBtnStyle, ...(txVarianceFlag ? { color: "#dc2626", fontWeight: 600 } : undefined) }}
                      >
                        {txVarianceFlag ? "⚠" : "🔗"} {tx.type} #{tx.number || "—"} · {new Date(tx.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                      </button>
                    ) : (
                      <span style={{ opacity: 0.4 }}>{m.txGuid ? "Voucher removed" : "—"}</span>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
            return { sortEnd: mRange ? mRange.end : "9999-99-99", node };
          });

          return [...excelEntries, ...manualEntries]
            .sort((a, b) => a.sortEnd.localeCompare(b.sortEnd))
            .map((entry) => entry.node);
          })()}
          {vestGroups.map(({ date, items, stockIdx }) => {
            const key = `vest-${date}`;
            const anyPending = items.some(({ vest }) => vest.pending);
            const shares = items.reduce((s, { vest }) => s + vest.shares, 0);
            const grossVal = items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
            const vTax = vestTax(date, stockIdx);
            const fed = vTax.federal;
            const ssnV = vTax.ssn;
            const med = vTax.medicare;
            const swh = vTax.stateWH;
            const ssdi = vTax.stateSDI;
            const taxV = vTax.totalTax;
            const hasOverride = vestTaxByDate.has(date);
            // Vest events don't carry a stored "Net" figure the way a paystub period does --
            // compute it the same way the popup's donut does (gross minus everything withheld).
            const netVal = grossVal - (fed ?? 0) - (ssnV ?? 0) - (med ?? 0) - (swh ?? 0) - (ssdi ?? 0);
            const showDash = (v: number | null) => (v === null ? <span style={{ opacity: 0.3 }}>—</span> : fmt(v));
            return (
              <tr
                key={key}
                onClick={() => setViewPeriod({ type: "vest", date })}
                style={{ cursor: "pointer", background: "#eef2ff" }}
              >
                <td
                  style={{ whiteSpace: "nowrap" }}
                  title={hasOverride ? "RSU vesting event — tax entered from real vesting pay-stub(s)" : "Quarterly RSU vesting event, from the payroll Excel's 'Stocks' columns"}
                >
                  {new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} Vesting
                  {anyPending && <em style={{ fontSize: 10, opacity: 0.6 }}> (scheduled)</em>}
                  {hasOverride && <em style={{ fontSize: 10, opacity: 0.6 }}> (pay-stub)</em>}
                </td>
                <td className="right">{anyPending ? <span style={{ opacity: 0.3 }}>—</span> : <span className="equity-amt">{fmt(grossVal)}</span>}</td>
                <td className="right">{showDash(fed)}</td>
                <td className="right">{showDash(ssnV)}</td>
                <td className="right">{showDash(med)}</td>
                <td className="right">{showDash(swh)}</td>
                <td className="right">{showDash(ssdi)}</td>
                <td className="right">{showDash(taxV)}</td>
                <td className="right">{anyPending ? <span style={{ opacity: 0.3 }}>—</span> : <span className="equity-amt" style={{ color: "#16a34a" }}>{fmt(netVal)}</span>}</td>
                <td><span style={{ opacity: 0.3 }}>—</span></td>
                <td>
                  <button
                    className="tax-voucher-link"
                    onClick={(e) => { e.stopPropagation(); setPeriodVestModal({ label: `${new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} Vesting`, items }); }}
                    style={linkBtnStyle}
                  >
                    📈 <span className="equity-amt">{shares.toLocaleString()} sh</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr onClick={() => setViewPeriod({ type: "ytd" })} style={{ cursor: "pointer" }} title="Click for the year-to-date breakdown">
            <th>Total</th>
            <th className="right">{fmt(totalGross)}</th>
            <th className="right">{fmt(totalFederal)}</th>
            <th className="right">{fmt(totalSsn)}</th>
            <th className="right">{fmt(totalMedicare)}</th>
            <th className="right">{fmt(totalStateWH)}</th>
            <th className="right">{fmt(totalStateSDI)}</th>
            <th className="right">{fmt(totalTaxAll)}</th>
            <th className="right">{fmt(totalNet)}</th>
            <th><span className="equity-amt">{(yearEspp.reduce((s, e) => s + e.shares, 0)).toLocaleString()} sh</span></th>
            <th>
              {yr.periodLabels.filter((l) => l && findPayrollVoucher(transactions, yr.year, l, yr.periodLabels, claimedTxGuids)).length + voucherPeriods.length}
              {" / "}
              {yr.periodLabels.filter((l) => l).length + voucherPeriods.length} linked
            </th>
          </tr>
        </tfoot>
      </table>
      {allManualPeriods.length > 0 && (
        <p className="equity-seed-note" style={{ marginTop: "0.5rem" }}>
          {voucherPeriods.length > 0 && `${voucherPeriods.length} pay period(s) auto-added from posted vouchers. `}
          {overrideByIndex.size > 0 && `${overrideByIndex.size} period(s) corrected from the Excel import. `}
          Expand any row (including regular Excel-imported ones) and click "✎ Edit" to enter real paystub
          numbers.
        </p>
      )}
      {allManualPeriods.length > 0 && (
        <details style={{ margin: "0.35rem 0 0" }}>
          <summary style={{ fontSize: 12, opacity: 0.7, cursor: "pointer", listStyle: "none" }}>
            ℹ️ What the row colors mean →
          </summary>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0 0" }}>
            <span style={{ background: "#fffbeb", padding: "0 4px" }}>Amber</span> rows are still using
            estimated numbers — expand and click "✎ Edit" to enter real paystub numbers; the highlight
            clears once saved. <span style={{ background: "#eef2ff", padding: "0 4px" }}>Indigo</span> rows
            below are RSU vesting events, not pay periods — that color is permanent, just marking the row
            type, not something to fix. A row labeled "(edited)" has no highlight — it already has real
            numbers, the label is only a note that it came from a correction rather than the original
            Excel import.
          </p>
        </details>
      )}

      <div className="equity-section-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h4>Estimated Tax Liability — {yr.year} (Federal)</h4>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Filing status
            <select value={filingStatus} onChange={(e) => setFilingStatus(e.target.value as UsFilingStatus)}>
              <option value="mfj">Married filing jointly</option>
              <option value="single">Single</option>
            </select>
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: "0.4rem" }}>
            HSA coverage
            <select value={hsaCoverage} onChange={(e) => setHsaCoverage(e.target.value as HsaCoverage)}>
              <option value="family">Family</option>
              <option value="self-only">Self-only</option>
            </select>
          </label>
          {taxYearIsOpenForPlanning && (
            <label
              style={{ fontSize: 12, display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", color: "#2563eb" }}
              onClick={() => setShowTaxPlanningModal(true)}
            >
              💡 Tax Planning{taxPlanningTotalSavings > 0 && <span className="tp-trigger-amt"> (up to {fmt(taxPlanningTotalSavings)})</span>}
            </label>
          )}
        </div>
      </div>
      <details style={{ margin: "0 0 0.75rem" }}>
        <summary style={{ fontSize: 12, opacity: 0.7, cursor: "pointer", listStyle: "none" }}>
          ℹ️ Estimate only — not tax advice. Click for assumptions &amp; limitations →
        </summary>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0 0" }}>
          Wages = gross pay less your 401(k) employee contribution (assumed traditional/pretax — Roth 401(k)
          contributions are post-tax and wouldn&apos;t reduce this; not distinguished here) and any personal HSA
          contributions found (transactions narrated "HSA", capped at the IRS annual limit for the coverage tier
          selected above). No other pretax deductions (e.g. health premiums) are subtracted since the app
          doesn&apos;t separately track them. Federal: includes Additional Medicare Tax and NIIT (both validated
          against a real return), but not AMT (didn&apos;t apply in that same return despite a large SALT addback —
          not modeled, watch for it changing at materially higher income). NIIT&apos;s net investment income only
          includes realized capital gains — interest/dividends aren&apos;t tracked, so it&apos;s understated if you
          have meaningful amounts of either. ESPP disqualifying-disposition ordinary income isn&apos;t modeled
          (treated as capital gain). {stateResidency.code}: uses federal AGI as a proxy for {stateResidency.code} AGI
          {stateResidency.code !== "AZ" && <> , adding the HSA deduction back since {stateResidency.name} doesn&apos;t
          conform to federal HSA treatment</>}; no other {stateResidency.code}-specific addback/subtraction items
          modeled. Mortgage interest isn&apos;t capped to the $750k acquisition-debt limit (can&apos;t be checked
          from ledger data alone). State of residence for {yr.year} is assumed to be {stateResidency.name}. Based on
          {" "}{taxEstimate.rules.ruleVersion} / {stateTaxEstimate.rules.ruleVersion}.
        </p>
      </details>

      {allYearsTaxEstimate.length > 1 && (
        <details style={{ margin: "0 0 0.75rem" }}>
          <summary className="tax-summary-figure" style={{ fontSize: 12, cursor: "pointer", listStyle: "none", fontWeight: 600 }}>
            All Years — Federal &amp; State Tax ({allYearsTaxEstimate.length} years, click to expand)
          </summary>
          <div className="columnar-report-scroll" style={{ marginTop: "0.5rem" }}>
            <table className="equity-table equity-drilldown-table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="right">AGI</th>
                  <th className="right">Deduction Used</th>
                  <th className="right">LTCG</th>
                  <th className="right">Est. Federal Tax</th>
                  <th className="right">Federal Withheld</th>
                  <th className="right">Federal Refund / (Due)</th>
                  <th>State</th>
                  <th className="right">State Taxable Income</th>
                  <th className="right">Est. State Tax</th>
                  <th className="right">State Withheld</th>
                  <th className="right">State Refund / (Due)</th>
                </tr>
              </thead>
              <tbody>
                {allYearsTaxEstimate.map((r) => (
                  <tr key={r.year}>
                    <td>
                      <button type="button" style={linkBtnStyle} onClick={() => { setSelectedYear(r.year); setViewPeriod(null); }}>
                        {r.year}
                      </button>
                    </td>
                    <td className="right equity-amt">{fmt(r.agi)}</td>
                    <td className="right equity-amt">{fmt(r.deductionUsed)}</td>
                    <td className="right equity-amt">{fmt(r.longTermGain)}</td>
                    <td className="right equity-amt">{fmt(r.estimatedFederalTax)}</td>
                    <td className="right equity-amt">{fmt(r.federalWithheld)}</td>
                    <td className={`right equity-amt ${r.federalRefund > 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>
                      {r.federalRefund > 0 ? fmt(r.federalRefund) : `(${fmt(r.federalBalanceDue)})`}
                    </td>
                    <td>{r.stateCode}</td>
                    <td className="right equity-amt">{fmt(r.stateTaxableIncome)}</td>
                    <td className="right equity-amt">{fmt(r.estimatedStateTax)}</td>
                    <td className="right equity-amt">{fmt(r.stateWithheld)}</td>
                    <td className={`right equity-amt ${r.stateRefund > 0 ? "equity-gain-pos" : "equity-gain-neg"}`}>
                      {r.stateRefund > 0 ? fmt(r.stateRefund) : `(${fmt(r.stateBalanceDue)})`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.agi, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.deductionUsed, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.longTermGain, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.estimatedFederalTax, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.federalWithheld, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.federalRefund - r.federalBalanceDue, 0))}</td>
                  <td />
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.stateTaxableIncome, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.estimatedStateTax, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.stateWithheld, 0))}</td>
                  <td className="right equity-amt">{fmt(allYearsTaxEstimate.reduce((s, r) => s + r.stateRefund - r.stateBalanceDue, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p style={{ fontSize: 11, opacity: 0.6, margin: "0.4rem 0 0" }}>
            Uses the Filing status/HSA coverage selected above for every year. Same estimate/not-tax-advice caveats as the single-year view.
          </p>
        </details>
      )}

      <div className="equity-summary-row">
        {[
          {
            label: "AGI", value: taxEstimate.agi,
            sub: (hsaDeduction > 0
              ? `wages less 401(k) & ${fmt(hsaDeduction)} HSA + net capital gains`
              : `wages less ${fmt(totalK401)} 401(k) + net capital gains`) + " — click for details →",
            icon: "wallet" as IconKind, color: "#1e40af",
            onClick: () => setTaxBreakdownModal({
              title: "AGI — how it's derived",
              lines: [
                { label: "Gross Salary (Base + Bonus + Stock/RSU vested + ESPP + other)", value: totalGross },
                { label: "Less: Employee 401(k) (pre-tax, not in W-2 Box 1)", value: -totalK401 },
                { label: "= Wages (W-2, incl. RSU/ESPP ordinary income)", value: taxableWages, bold: true },
                { label: "+ Taxable Interest & Dividends", value: interestDividendIncome },
                { label: "Short-Term Capital Gain (taxed as ordinary income)", value: gainTotals.shortTermGainTaxable },
                { label: "Less: Capital Loss Deduction", value: -gainTotals.ordinaryLossDeduction },
                {
                  label: hsaContributionTotal > hsaDeduction
                    ? `Less: HSA Deduction (${fmt(hsaContributionTotal)} contributed, capped at IRS annual limit)`
                    : `Less: HSA Deduction (${fmt(hsaContributionTotal)} contributed, under the IRS annual limit)`,
                  value: -hsaDeduction,
                },
                { label: "= Ordinary Income", value: taxEstimate.ordinaryIncome, bold: true },
                { label: "+ Long-Term Capital Gain", value: taxEstimate.longTermGain },
                { label: "= AGI", value: taxEstimate.agi, bold: true },
              ],
            }),
          },
          {
            label: "Deduction Used", value: taxEstimate.deductionUsed,
            sub: deductionMatches.length > 0 || hsaContributions.length > 0
              ? `${taxEstimate.usedItemized ? "itemized" : "standard"} — click for details →`
              : (taxEstimate.usedItemized ? "itemized (beats standard)" : "standard deduction"),
            icon: "cash" as IconKind, color: "#0891b2",
            onClick: deductionMatches.length > 0 || hsaContributions.length > 0 ? () => setShowDeductionsModal(true) : undefined,
          },
          {
            label: gainTotals.ordinaryLossDeduction > 0 ? "Capital Loss Deduction" : "Long-Term Capital Gain",
            value: gainTotals.ordinaryLossDeduction > 0 ? gainTotals.ordinaryLossDeduction : taxEstimate.longTermGain,
            sub: gainEvents.length > 0 ? `${gainEvents.length} sale(s) — click for details →` : "no sales matched",
            icon: "trending-up" as IconKind, color: "#7c3aed",
            onClick: gainEvents.length > 0 ? () => setShowGainEventsModal(true) : undefined,
          },
          {
            label: "Estimated Federal Tax", value: taxEstimate.estimatedTax,
            sub: `ordinary ${fmt(taxEstimate.ordinaryTax)} + LTCG ${fmt(taxEstimate.ltcgTax)} + Medicare ${fmt(taxEstimate.additionalMedicareTax)} + NIIT ${fmt(taxEstimate.niit)} — click for details →`,
            icon: "receipt" as IconKind, color: "#dc2626",
            onClick: () => setTaxBreakdownModal({
              title: "Estimated Federal Tax — how it's derived",
              lines: [
                { label: "Tax on Ordinary Income (brackets)", value: taxEstimate.ordinaryTax },
                { label: "Tax on Long-Term Capital Gain", value: taxEstimate.ltcgTax },
                { label: "Additional Medicare Tax (0.9% over threshold)", value: taxEstimate.additionalMedicareTax },
                { label: "Net Investment Income Tax (NIIT, 3.8%)", value: taxEstimate.niit },
                { label: "= Estimated Federal Tax", value: taxEstimate.estimatedTax, bold: true },
              ],
            }),
          },
          {
            label: "Federal Withheld", value: taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld,
            sub: (taxEstimate.additionalMedicareWithheld > 0
              ? `${fmt(taxEstimate.federalWithheld)} income tax + ${fmt(taxEstimate.additionalMedicareWithheld)} Medicare`
              : "from payroll") + " — click for details →",
            icon: "shield" as IconKind, color: "#16a34a",
            onClick: () => setTaxBreakdownModal({
              title: "Federal Withheld — how it's derived",
              lines: [
                { label: "Federal Income Tax Withheld (payroll)", value: taxEstimate.federalWithheld },
                { label: "Additional Medicare Tax Withheld", value: taxEstimate.additionalMedicareWithheld },
                { label: "= Total Federal Withheld", value: taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld, bold: true },
              ],
            }),
          },
          taxEstimate.refund > 0
            ? {
                label: "Estimated Federal Refund", value: taxEstimate.refund, sub: "withheld exceeds estimated tax — click for details →",
                icon: "scale" as IconKind, color: "#16a34a", amountColor: "#16a34a",
                onClick: () => setTaxBreakdownModal({
                  title: "Estimated Federal Refund — how it's derived",
                  lines: [
                    { label: "Estimated Federal Tax", value: taxEstimate.estimatedTax },
                    { label: "Less: Total Federal Withheld", value: -(taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld) },
                    { label: "= Estimated Refund", value: taxEstimate.refund, bold: true },
                  ],
                }),
              }
            : {
                label: "Estimated Federal Balance Due", value: taxEstimate.balanceDue, sub: "estimated tax exceeds withheld — click for details →",
                icon: "scale" as IconKind, color: "#dc2626", amountColor: "#dc2626",
                onClick: () => setTaxBreakdownModal({
                  title: "Estimated Federal Balance Due — how it's derived",
                  lines: [
                    { label: "Estimated Federal Tax", value: taxEstimate.estimatedTax },
                    { label: "Less: Total Federal Withheld", value: -(taxEstimate.federalWithheld + taxEstimate.additionalMedicareWithheld) },
                    { label: "= Estimated Balance Due", value: taxEstimate.balanceDue, bold: true },
                  ],
                }),
              },
        ].map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div
              className="equity-summary-card"
              style={c.onClick ? { cursor: "pointer" } : undefined}
              onClick={c.onClick}
            >
              <StatIcon kind={c.icon} color={c.color} />
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <AutoFitAmount className="equity-amt" text={fmt(c.value)} style={c.amountColor ? { color: c.amountColor } : undefined} />
                <em>{c.sub}</em>
              </div>
            </div>
          </div>
        ))}
      </div>
      {deductionMatches.length === 0 && (
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
          No deduction ledgers matched (looking for names containing "medical", "mortgage interest"/"interest on
          home loan", "property tax", "state tax", or "donation"/"charity") — using the standard deduction. Rename
          a ledger to match if you track one of these separately.
        </p>
      )}

      <div className="equity-section-head">
        <h4>{stateResidency.name} State Tax — {yr.year}</h4>
      </div>
      <div className="equity-summary-row">
        {[
          {
            label: `${stateResidency.code} Taxable Income`, value: stateTaxEstimate.taxableIncome,
            sub: (stateTaxEstimate.usedItemized ? `itemized (beats ${stateResidency.code} standard)` : `${stateResidency.code} standard deduction`) + " — click for details →",
            icon: "cash" as IconKind, color: "#0891b2",
            onClick: () => setTaxBreakdownModal({
              title: `${stateResidency.code} Taxable Income — how it's derived`,
              lines: [
                { label: "Federal AGI", value: taxEstimate.agi },
                ...(stateResidency.code === "AZ" ? [] : [
                  { label: `+ HSA Deduction Added Back (${stateResidency.name} doesn't conform to federal HSA treatment)`, value: taxEstimate.aboveLineDeduction },
                ]),
                { label: `= ${stateResidency.code} AGI (proxy)`, value: stateAgi, bold: true },
                { label: `Less: Deduction Used (${stateTaxEstimate.usedItemized ? "itemized" : "standard"})`, value: -stateTaxEstimate.deductionUsed },
                { label: `= ${stateResidency.code} Taxable Income`, value: stateTaxEstimate.taxableIncome, bold: true },
              ],
            }),
          },
          {
            label: `Estimated ${stateResidency.code} Tax`, value: stateTaxEstimate.estimatedTax,
            sub: (stateTaxEstimate.mentalHealthTax > 0 ? `incl. ${fmt(stateTaxEstimate.mentalHealthTax)} Mental Health Services Tax` : "brackets only") + " — click for details →",
            icon: "receipt" as IconKind, color: "#dc2626",
            onClick: () => setTaxBreakdownModal({
              title: `Estimated ${stateResidency.code} Tax — how it's derived`,
              lines: [
                { label: "Bracket Tax", value: stateTaxEstimate.bracketTax },
                { label: "Mental Health Services Tax (1% over threshold)", value: stateTaxEstimate.mentalHealthTax },
                { label: `= Estimated ${stateResidency.code} Tax`, value: stateTaxEstimate.estimatedTax, bold: true },
              ],
            }),
          },
          {
            label: `${stateResidency.code} Withheld`, value: stateTaxEstimate.stateWithheld, sub: "from payroll (State W/H) — click for details →",
            icon: "shield" as IconKind, color: "#16a34a",
            onClick: () => setTaxBreakdownModal({
              title: `${stateResidency.code} Withheld — how it's derived`,
              lines: [
                { label: "State Income Tax Withheld (payroll, State W/H)", value: stateTaxEstimate.stateWithheld, bold: true },
              ],
            }),
          },
          stateTaxEstimate.refund > 0
            ? {
                label: `Estimated ${stateResidency.code} Refund`, value: stateTaxEstimate.refund, sub: "withheld exceeds estimated tax — click for details →",
                icon: "scale" as IconKind, color: "#16a34a", amountColor: "#16a34a",
                onClick: () => setTaxBreakdownModal({
                  title: `Estimated ${stateResidency.code} Refund — how it's derived`,
                  lines: [
                    { label: `Estimated ${stateResidency.code} Tax`, value: stateTaxEstimate.estimatedTax },
                    { label: `Less: ${stateResidency.code} Withheld`, value: -stateTaxEstimate.stateWithheld },
                    { label: "= Estimated Refund", value: stateTaxEstimate.refund, bold: true },
                  ],
                }),
              }
            : {
                label: `Estimated ${stateResidency.code} Balance Due`, value: stateTaxEstimate.balanceDue, sub: "estimated tax exceeds withheld — click for details →",
                icon: "scale" as IconKind, color: "#dc2626", amountColor: "#dc2626",
                onClick: () => setTaxBreakdownModal({
                  title: `Estimated ${stateResidency.code} Balance Due — how it's derived`,
                  lines: [
                    { label: `Estimated ${stateResidency.code} Tax`, value: stateTaxEstimate.estimatedTax },
                    { label: `Less: ${stateResidency.code} Withheld`, value: -stateTaxEstimate.stateWithheld },
                    { label: "= Estimated Balance Due", value: stateTaxEstimate.balanceDue, bold: true },
                  ],
                }),
              },
        ].map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div
              className="equity-summary-card"
              style={{ cursor: "pointer" }}
              onClick={c.onClick}
            >
              <StatIcon kind={c.icon} color={c.color} />
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <AutoFitAmount className="equity-amt" text={fmt(c.value)} style={c.amountColor ? { color: c.amountColor } : undefined} />
                <em>{c.sub}</em>
              </div>
            </div>
          </div>
        ))}
      </div>

      {taxYearIsOpenForPlanning && (
        <details style={{ margin: "1rem 0 0" }}>
          <summary className="tax-summary-figure" style={{ fontSize: 13, fontWeight: 600, cursor: "pointer", listStyle: "none" }}>
            📅 Projected Full Year (through Dec 31, {yr.year}) — {taxPlanningProjection.periodsRemaining} paycheck(s)
            {taxPlanningProjection.futureVestShares > 0 && <> + {taxPlanningProjection.futureVestShares.toLocaleString()} scheduled RSU shares</>} still to come, click to expand
          </summary>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0" }}>
            Remaining paychecks modeled on {taxPlanningProjection.modeledOnLastPaystub ? "your most recent paystub" : "a whole-year average"}
            {taxPlanningProjection.futureVestShares > 0 && (
              taxPlanningProjection.livePriceUsed
                ? <>; scheduled RSU shares valued at today's live price (${taxPlanningProjection.livePriceUsed.toFixed(2)})</>
                : <>; no live stock price available, so scheduled RSU value isn't included yet</>
            )}. Click any card below for the full projection detail (assumptions, per-paycheck model, ESPP).
          </p>
          <div className="equity-summary-row">
            {[
              { label: "Projected Gross (full year)", value: taxPlanningProjection.fullYearGross, sub: "YTD + remaining paychecks + scheduled RSU", icon: "cash" as IconKind, color: "#1e40af" },
              { label: "Projected Federal Tax", value: taxPlanningProjection.projectedFederalTax, sub: "full-year estimate", icon: "receipt" as IconKind, color: "#dc2626" },
              { label: "Projected Federal Withheld", value: taxPlanningProjection.fullYearFederalWithheld, sub: "YTD + remaining paychecks", icon: "shield" as IconKind, color: "#16a34a" },
              projectedFederalBalance > 0
                ? { label: "Projected Federal Balance Due", value: projectedFederalBalance, sub: "estimated tax exceeds withheld", icon: "scale" as IconKind, color: "#dc2626", amountColor: "#dc2626" }
                : { label: "Projected Federal Refund", value: -projectedFederalBalance, sub: "withheld exceeds estimated tax", icon: "scale" as IconKind, color: "#16a34a", amountColor: "#16a34a" },
              { label: `Projected ${stateResidency.code} Tax`, value: taxPlanningProjection.projectedStateTax, sub: "full-year estimate", icon: "receipt" as IconKind, color: "#dc2626" },
              { label: `Projected ${stateResidency.code} Withheld`, value: taxPlanningProjection.fullYearStateWithheld, sub: "YTD + remaining paychecks", icon: "shield" as IconKind, color: "#16a34a" },
              projectedStateBalance > 0
                ? { label: `Projected ${stateResidency.code} Balance Due`, value: projectedStateBalance, sub: "estimated tax exceeds withheld", icon: "scale" as IconKind, color: "#dc2626", amountColor: "#dc2626" }
                : { label: `Projected ${stateResidency.code} Refund`, value: -projectedStateBalance, sub: "withheld exceeds estimated tax", icon: "scale" as IconKind, color: "#16a34a", amountColor: "#16a34a" },
            ].map((c) => (
              <div key={c.label} className="equity-summary-col">
                <div className="equity-summary-card" style={{ cursor: "pointer" }} onClick={() => setShowTaxPlanningModal(true)}>
                  <StatIcon kind={c.icon} color={c.color} />
                  <div className="equity-summary-card-body">
                    <span>{c.label}</span>
                    <AutoFitAmount className="equity-amt" text={fmt(c.value)} style={c.amountColor ? { color: c.amountColor } : undefined} />
                    <em>{c.sub} — click for details →</em>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {showRsuModal && (
        <Modal title={`RSU Vesting — ${yr.year}`} onClose={() => setShowRsuModal(false)} wide>
          <VestTable items={yearVests} fmt={fmt} />
          {stockScheduledShares > 0 && (
            <p style={{ fontSize: 12, opacity: 0.7, margin: "0.5rem 0 0" }}><span className="equity-amt">{stockScheduledShares.toLocaleString()} sh</span> still scheduled to vest in {yr.year}.</p>
          )}
          {stockTaxTotal > 0 && (
            <>
              <strong style={{ fontSize: 13, display: "block", marginTop: "1rem" }}>Additional tax withheld on vesting events (Excel import, or a real vesting pay-stub where uploaded)</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 2rem", marginTop: "0.5rem" }}>
                {[
                  ["Federal", stockFederal], ["SSN", stockSsn], ["Medicare", stockMedicare],
                  ["State W/H", stockStateWH], ["State SDI", stockStateSDI], ["Total", stockTaxTotal],
                ].map(([lbl, val]) => (
                  <div key={lbl as string}>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{lbl}</div>
                    <strong className="equity-amt">{fmt(val as number)}</strong>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowRsuModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {periodVestModal && (
        <Modal title={`RSU Vesting — ${periodVestModal.label}`} onClose={() => setPeriodVestModal(null)} wide>
          <VestTable items={periodVestModal.items} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setPeriodVestModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {showEsppModal && (
        <Modal title={`ESPP Purchases — ${yr.year}`} onClose={() => setShowEsppModal(false)} wide>
          <EsppTable items={yearEspp} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowEsppModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {periodBreakdownModal && (() => {
        const { row, field, isGross, total } = periodBreakdownModal;
        type Row = { sortKey: string; key: string; label: string; title?: string; value: number };
        // Same override-substitution rule overriddenGrossTotal()/overriddenTotal() already use
        // for the card's own total -- a period with a manual correction shows the corrected
        // value here too, not the stale raw Excel figure the card no longer counts.
        const valueFor = (i: number): number => {
          const ov = overrideByIndex.get(i);
          if (ov) {
            if (isGross) return ov.base + ov.telephone;
            if (field) return Number(ov[field]) || 0;
          }
          return row?.values[i] ?? 0;
        };
        const anchorFor = (i: number): number => {
          const ov = overrideByIndex.get(i);
          return ov ? ov.base + ov.telephone : (gross?.values[i] ?? 0);
        };
        const excelRows: Row[] = yr.periodLabels.map((label, i) => {
          const v = valueFor(i);
          if (anchorFor(i) === 0 && v === 0) return null; // no pay period recorded yet
          const range = label ? parsePeriodRange(label, yr.year) : null;
          return { sortKey: range?.end ?? "9999-99-99", key: label || String(i), label: label ? periodEndLabel(label, yr.year) : `Period ${i + 1}`, value: v };
        }).filter((r): r is Row => r !== null);
        // Pay periods the Excel import doesn't cover at all (posted from a voucher/paystub) --
        // only these cards' totals actually include them (manualGross/manualTax/etc.), so only
        // show them here when `field`/`isGross` says this card's total does too.
        const manualRows: Row[] = (field || isGross)
          ? voucherPeriods
              .map((m) => {
                const value = isGross ? m.base + m.telephone : field ? Number(m[field]) || 0 : 0;
                const range = parsePeriodRange(m.label, yr.year);
                return { sortKey: range?.end ?? m.label, key: m.id, label: `${periodEndLabel(m.label, yr.year)} (paystub)`, title: `${m.label} — posted from a voucher/paystub, not in the Excel import`, value };
              })
              .filter((r) => Math.abs(r.value) > 0.005)
          : [];
        // A vest's real gross (equity-derived) or real tax (manualVestTax, when entered) overrides
        // the Excel Stocks-column figure the same way the year TOTAL now does -- reading raw
        // row.stockValues here unconditionally, like before, silently dropped a vest (e.g. a
        // brand-new one) the Excel import doesn't have a column for at all yet.
        const vestRows: Row[] = vestGroups.map((g) => {
          let v: number | null;
          if (isGross) v = g.items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
          else if (field) v = (vestTax(g.date, g.stockIdx) as unknown as Record<string, number | null>)[field as string] ?? null;
          else v = row?.stockValues?.[g.stockIdx] ?? null;
          if (v === null || Math.abs(v) < 0.005) return null;
          return { sortKey: g.date, key: g.date, label: `${fmtDate(g.date)} (vesting)`, value: v };
        }).filter((r): r is Row => r !== null);
        const allRows = [...excelRows, ...manualRows, ...vestRows].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        return (
          <Modal title={`${periodBreakdownModal.label} — ${yr.year}`} onClose={() => setPeriodBreakdownModal(null)} wide>
            <table className="equity-table equity-drilldown-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {allRows.map((r) => (
                  <tr key={r.key}>
                    <td title={r.title}>{r.label}</td>
                    <td className="right">{fmt(r.value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="right">{fmt(total)}</td>
                </tr>
              </tfoot>
            </table>
            <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setPeriodBreakdownModal(null)}>Close</button>
            </div>
          </Modal>
        );
      })()}

      {viewPeriod && (() => {
        // Excel-imported and manually-entered (or voucher-derived) periods carry the same
        // fields under different names -- normalize both into one shape so the popup below is
        // written once, not duplicated per period type.
        let period: {
          label: string; gross: number; federal: number; ssn: number; medicare: number;
          stateWH: number; stateSDI: number; totalTax: number; k401: number; k401Emplr: number;
          medical: number; espp: number; base: number; telephone: number;
          isEditing: boolean; onEdit: (() => void) | null; estimated?: boolean;
          isVest?: boolean; shares?: number; onViewShares?: () => void;
          employer?: string; refund?: number;
        } | null = null;

        if (viewPeriod.type === "ytd") {
          period = {
            label: `Year-to-Date Total`,
            gross: totalGross, federal: totalFederal, ssn: totalSsn, medicare: totalMedicare,
            stateWH: totalStateWH, stateSDI: totalStateSDI, totalTax: totalTaxAll,
            k401: totalK401, k401Emplr: totalK401Emplr, medical: totalMedical, espp: totalEsppDeduction,
            base: totalBaseYtd, telephone: totalTelephoneYtd,
            isEditing: false,
            onEdit: null,
          };
        } else if (viewPeriod.type === "vest") {
          const vg = vestGroups.find((g) => g.date === viewPeriod.date);
          if (vg) {
            const shares = vg.items.reduce((s, { vest }) => s + vest.shares, 0);
            const grossVal = vg.items.reduce((s, { vest }) => s + (vest.pending ? 0 : vest.shares * vest.vestPrice), 0);
            const vestLabel = `${new Date(vg.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} Vesting`;
            const vTax = vestTax(vg.date, vg.stockIdx);
            period = {
              label: vestLabel,
              gross: grossVal,
              federal: vTax.federal ?? 0,
              ssn: vTax.ssn ?? 0,
              medicare: vTax.medicare ?? 0,
              stateWH: vTax.stateWH ?? 0,
              stateSDI: vTax.stateSDI ?? 0,
              totalTax: vTax.totalTax ?? 0,
              k401: 0, k401Emplr: 0, medical: 0, espp: 0, base: 0, telephone: 0,
              isEditing: false,
              onEdit: null,
              isVest: true,
              shares,
              onViewShares: () => { setViewPeriod(null); setPeriodVestModal({ label: vestLabel, items: vg.items }); },
            };
          }
        } else if (viewPeriod.type === "excel") {
          const i = viewPeriod.index;
          const lbl = yr.periodLabels[i];
          const linkedTx = lbl ? findPayrollVoucher(transactions, yr.year, lbl, yr.periodLabels, claimedTxGuids) : undefined;
          period = {
            label: lbl ? periodEndLabel(lbl, yr.year) : `Period ${i + 1}`,
            employer: (linkedTx && employerFromVoucher(linkedTx)) || undefined,
            gross: at(gross, i), federal: at(federal, i), ssn: at(ssn, i), medicare: at(medicare, i),
            stateWH: at(stateWH, i), stateSDI: at(stateSDI, i), totalTax: at(totalTax, i),
            k401: at(k401, i), k401Emplr: at(k401Emplr, i), medical: at(medicalRow, i), espp: at(esppRow, i),
            base: at(baseRow, i), telephone: at(telRow, i), refund: at(refundRow, i),
            isEditing: editingTarget?.id === null && editingTarget?.periodIndex === i,
            onEdit: readOnly ? null : () => startEditExcel(i, lbl),
          };
        } else {
          const m = allManualPeriods.find((p) => p.id === viewPeriod.id);
          if (m) {
            const tx = m.txGuid ? transactions.find((t) => t.guid === m.txGuid) : findPayrollVoucher(transactions, yr.year, m.label, yr.periodLabels, claimedTxGuids);
            period = {
              label: periodEndLabel(m.label, yr.year),
              employer: (tx && employerFromVoucher(tx)) || undefined,
              gross: m.base + m.telephone, federal: m.federal, ssn: m.ssn, medicare: m.medicare,
              stateWH: m.stateWH, stateSDI: m.stateSDI, totalTax: m.totalTax,
              k401: m.k401, k401Emplr: m.k401Emplr ?? 0, medical: m.medical, espp: m.espp ?? 0,
              base: m.base, telephone: m.telephone,
              isEditing: editingTarget?.id === m.id,
              onEdit: readOnly ? null : () => startEditExisting(m),
              estimated: m.estimated,
            };
          }
        }

        if (!period) {
          // The period this popup pointed at no longer exists under its old identity (e.g. an
          // Excel period just got saved as a new manual override) -- close rather than show a
          // stale/broken view.
          setViewPeriod(null);
          return null;
        }

        // Green = added to you (earned pay, employer-paid benefits); red = comes out of your
        // paycheck (taxes, your own contributions/premiums) -- same "money in / money out"
        // convention as the donut's Net Take-Home (green) vs. tax/deduction slices (red/warm).
        // Net Take-Home is computed the same way for every period type -- gross minus every
        // other line below -- rather than trusting a separately-stored figure, so it can never
        // silently be missing (a vest event never had one at all) or drift from what's shown.
        const netTakeHome = Math.max(
          0,
          period.gross - period.federal - period.ssn - period.medicare - period.stateWH - period.stateSDI - period.k401 - period.medical - period.espp - (period.refund || 0)
        );
        const grid: { label: string; value: number; kind: "in" | "out" }[] = period.isVest
          ? [
              { label: "Net Take-Home", value: netTakeHome, kind: "in" },
              { label: "Federal", value: period.federal, kind: "out" },
              { label: "SSN", value: period.ssn, kind: "out" },
              { label: "Medicare", value: period.medicare, kind: "out" },
              { label: "State W/H", value: period.stateWH, kind: "out" },
              { label: "State SDI", value: period.stateSDI, kind: "out" },
              { label: "Total Tax", value: period.totalTax, kind: "out" },
            ]
          : [
              { label: "Net Take-Home", value: netTakeHome, kind: "in" },
              { label: "Base", value: period.base, kind: "in" },
              { label: "Telephone", value: period.telephone, kind: "in" },
              { label: "401K Employer Match", value: period.k401Emplr, kind: "in" },
              { label: "Medical", value: period.medical, kind: "out" },
              { label: "401K (employee)", value: period.k401, kind: "out" },
              { label: "ESPP Deduction", value: period.espp, kind: "out" },
              { label: "Federal", value: period.federal, kind: "out" },
              { label: "SSN", value: period.ssn, kind: "out" },
              { label: "Medicare", value: period.medicare, kind: "out" },
              { label: "State W/H", value: period.stateWH, kind: "out" },
              { label: "State SDI", value: period.stateSDI, kind: "out" },
              { label: "Total Tax", value: period.totalTax, kind: "out" },
              // Only shown when non-zero -- specific to a "no active project" bench refund
              // arrangement at one old employer, absent for everyone else.
              ...(period.refund ? [{ label: "Refund to Employer", value: period.refund, kind: "out" as const }] : []),
            ];

        return (
          <Modal
            title={
              <>
                {period.label} — {yr.year}
                {period.employer && (
                  <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 400, opacity: 0.65 }}>{period.employer}</span>
                )}
              </>
            }
            onClose={() => setViewPeriod(null)}
            wide
          >
            {period.isEditing ? (
              <EditFieldsForm
                form={manualForm}
                onChange={setManualForm}
                onSave={async () => { await saveEdit(); setViewPeriod(null); }}
                onCancel={() => setEditingTarget(null)}
                saving={savingManual}
              />
            ) : (
              <>
                {period.estimated && (
                  <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 0.75rem" }}>
                    Federal/SSN/Medicare/State are estimated from your closest matching pay period — replace with your real paystub numbers once you have them.
                  </p>
                )}
                {period.gross > 0 && (
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: "1rem" }}>
                    <DonutChart
                      segments={paystubDonutSegments({
                        gross: period.gross, federal: period.federal, ssn: period.ssn, medicare: period.medicare,
                        state: period.stateWH + period.stateSDI, k401: period.k401, medical: period.medical, espp: period.espp,
                      })}
                      size={170}
                      thickness={24}
                      centerLabel="Gross"
                      centerValue={fmt(period.gross)}
                    />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.75rem 1.25rem" }}>
                  {grid.map((g) => (
                    <div key={g.label}>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>{g.label}</div>
                      <strong className="equity-amt" style={{ color: g.kind === "in" ? "#16a34a" : "#dc2626" }}>{fmt(g.value)}</strong>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                  {period.onViewShares && (
                    <button onClick={period.onViewShares}>View <span className="equity-amt">{period.shares?.toLocaleString()} sh</span> breakdown</button>
                  )}
                  {period.onEdit && (
                    <button onClick={period.onEdit}>Edit with real paystub numbers</button>
                  )}
                  <button onClick={() => setViewPeriod(null)}>Close</button>
                </div>
              </>
            )}
          </Modal>
        );
      })()}

      {taxBreakdownModal && (
        <Modal title={taxBreakdownModal.title} onClose={() => setTaxBreakdownModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {taxBreakdownModal.lines.map((l, i) => (
              <div
                key={i}
                style={{
                  display: "flex", justifyContent: "space-between", gap: "1rem",
                  fontWeight: l.bold ? 700 : 400,
                  borderTop: l.bold ? "1px solid #e2e8f0" : undefined,
                  paddingTop: l.bold ? "0.4rem" : undefined,
                }}
              >
                <span>{l.label}</span>
                <span className="equity-amt">{fmt(l.value)}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, opacity: 0.6, marginTop: "0.75rem" }}>
            Estimate only — not tax advice. See "Estimate only" above for full assumptions & limitations.
          </p>
        </Modal>
      )}

      {showGainEventsModal && (
        <Modal title={`RSU & ESPP Sales — ${yr.year}`} onClose={() => setShowGainEventsModal(false)} wide>
          <table className="equity-table">
            <thead>
              <tr><th>Sale</th><th className="right">Shares</th><th className="right">Cost Basis</th><th className="right">Proceeds</th><th className="right">Gain/(Loss)</th><th>Term</th></tr>
            </thead>
            <tbody>
              {gainEvents.map((g) => (
                <tr key={g.id}>
                  <td>{g.label}</td>
                  <td className="right">{g.shares.toLocaleString()}</td>
                  <td className="right">{fmt(g.costBasis)}</td>
                  <td className="right">{fmt(g.proceeds)}</td>
                  <td className="right equity-amt" style={{ color: g.gain >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(g.gain)}</td>
                  <td>{g.term === "long" ? "Long-term" : "Short-term"}</td>
                </tr>
              ))}
            </tbody>
            {gainEvents.length > 0 && (() => {
              const totalShares = gainEvents.reduce((s, g) => s + g.shares, 0);
              const totalCostBasis = gainEvents.reduce((s, g) => s + g.costBasis, 0);
              const totalProceeds = gainEvents.reduce((s, g) => s + g.proceeds, 0);
              const totalGain = gainEvents.reduce((s, g) => s + g.gain, 0);
              return (
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="right">{totalShares.toLocaleString()}</td>
                    <td className="right">{fmt(totalCostBasis)}</td>
                    <td className="right">{fmt(totalProceeds)}</td>
                    <td className="right equity-amt" style={{ color: totalGain >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(totalGain)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>
          <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.75rem" }}>
            Only lots with an entered sale price count as a realized sale — see Reports → Equity to add one.
            Net short-term {fmt(gainTotals.netShortTerm)}, net long-term {fmt(gainTotals.netLongTerm)}
            (raw totals before netting one against the other).
          </p>
          {gainTotals.ordinaryLossDeduction > 0 ? (
            <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
              Net overall capital loss of {fmt(gainTotals.netShortTerm + gainTotals.netLongTerm).replace("-", "")} — up to $3,000/year is
              deductible against ordinary income; {fmt(gainTotals.ordinaryLossDeduction)} of that is applied above, reducing AGI.
              {gainTotals.lossCarryforward > 0 && ` The remaining ${fmt(gainTotals.lossCarryforward)} isn't tracked as a carryforward to next year by this app — note it yourself.`}
            </p>
          ) : (
            <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
              Taxed as {fmt(gainTotals.shortTermGainTaxable)} ordinary income + {fmt(gainTotals.longTermGainTaxable)} at preferential
              LTCG rates (a loss in one category first offsets a gain in the other before any rate is applied).
            </p>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowGainEventsModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showDeductionsModal && (
        <Modal title={`Itemized Deductions — ${yr.year}`} onClose={() => setShowDeductionsModal(false)} wide>
          <table className="equity-table">
            <thead>
              <tr><th>Category</th><th>Matched Ledger(s)</th><th className="right">Amount</th></tr>
            </thead>
            <tbody>
              {deductionMatches.map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.label}
                    {m.excludedCount ? (
                      <span title="Excluded from this total: transactions whose narration mentions HSA/FSA — those aren't separately deductible as a medical expense (they get their own above-the-line deduction, not modeled here).">
                        {" "}<em style={{ fontSize: 10, opacity: 0.6 }}>({m.excludedCount} HSA/FSA excluded)</em>
                      </span>
                    ) : null}
                  </td>
                  <td>{m.ledgers.map((l) => l.name).join(", ")}</td>
                  <td className="right equity-amt">{fmt(m.total)}</td>
                </tr>
              ))}
            </tbody>
            {deductionMatches.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td className="right equity-amt">{fmt(deductionMatches.reduce((s, m) => s + m.total, 0))}</td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.75rem" }}>
            Federal itemized total {fmt(federalItemized.total)} (medical above 7.5% AGI floor: {fmt(federalItemized.medicalDeductible)};
            SALT capped at {fmt(federalItemized.saltCap)}: {fmt(federalItemized.saltDeductible)}; mortgage interest {fmt(federalItemized.mortgageInterestDeductible)};
            charitable {fmt(federalItemized.charitableDeductible)}) vs. standard deduction {fmt(taxEstimate.rules.standardDeduction)} —
            {taxEstimate.usedItemized ? " itemizing wins, used above." : " standard deduction wins, used above."}
          </p>
          <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
            {stateResidency.code === "NJ" ? (
              <>NJ deduction: {fmt(stateTaxEstimate.rules.standardDeduction)} personal exemption + {fmt(stateItemized)} property
              tax (capped at $15,000) — NJ doesn&apos;t have a standard-vs-itemized choice; both apply together, unlike the
              federal/CA/AZ returns above.</>
            ) : stateResidency.code === "AZ" ? (
              <>Arizona itemized total {fmt(stateItemized)} (SALT-capped at $10,000) vs. AZ standard deduction {fmt(stateTaxEstimate.rules.standardDeduction)} —
              {stateTaxEstimate.usedItemized ? " itemizing wins for AZ." : " AZ standard deduction wins."}</>
            ) : (
              <>California itemized total {fmt(stateItemized)} (no SALT cap, but state income tax paid doesn&apos;t count
              against the CA return) vs. CA standard deduction {fmt(stateTaxEstimate.rules.standardDeduction)} —
              {stateTaxEstimate.usedItemized ? " itemizing wins for CA." : " CA standard deduction wins."}</>
            )}
          </p>
          {hsaContributions.length > 0 && (
            <>
              <h5 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>HSA Contributions (above-the-line, federal only)</h5>
              <table className="equity-table">
                <thead>
                  <tr><th>Date</th><th>Narration</th><th className="right">Amount</th></tr>
                </thead>
                <tbody>
                  {hsaContributions.map((h) => (
                    <tr key={h.txGuid}>
                      <td>{fmtDate(h.date)}</td>
                      <td>{h.narration}</td>
                      <td className="right equity-amt">{fmt(h.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Total</td>
                    <td className="right equity-amt">{fmt(hsaContributionTotal)}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="tax-note-figure" style={{ fontSize: 12, opacity: 0.7, marginTop: "0.5rem" }}>
                Total {fmt(hsaContributionTotal)}, capped at the {hsaCoverage} IRS limit — {fmt(hsaDeduction)} actually deducted from
                federal AGI. {stateResidency.code === "AZ"
                  ? <>{stateResidency.name} conforms to federal HSA treatment, so no addback is needed for the AZ calculation above.</>
                  : <>Not deductible on your {stateResidency.code} return ({stateResidency.name} doesn&apos;t conform to federal HSA treatment),
                  so it&apos;s added back for the {stateResidency.code} calculation above.</>}
              </p>
            </>
          )}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowDeductionsModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showTaxPlanningModal && taxYearIsOpenForPlanning && (
        <Modal title={`Tax Planning — ${yr.year}`} onClose={() => setShowTaxPlanningModal(false)} wide>
          <p className="tp-disclaimer">
            Every number below is computed by this app's own tax-rule tables and formulas — the same ones used
            elsewhere in this report — not by an external AI/LLM, and none of your data leaves the app. These are
            estimates to inform a conversation with a CPA, not tax advice, and not a substitute for one.
          </p>
          <div className="tp-projection">
            <h5 className="tp-cat-label">How this is projected</h5>
            <p className="tp-card-desc">
              You've received {taxPlanningProjection.periodsElapsed} of {taxPlanningProjection.periodsPerYear} paychecks
              this year. {taxPlanningProjection.modeledOnLastPaystub ? (
                <>The {taxPlanningProjection.periodsRemaining} paychecks left before year-end are each modeled on your
                most recent paystub (about {fmt(taxPlanningProjection.perPeriodGross)} gross, not counting stock vests) —
                not a whole-year average, so it reflects your current pay rate and 401(k)/ESPP elections — adding about{" "}
                {fmt(taxPlanningProjection.projectedRemainingGross)}.</>
              ) : (
                <>No recent paystub was found to model from, so the {taxPlanningProjection.periodsRemaining} paychecks
                left before year-end are projected from this year's average instead (about{" "}
                {fmt(taxPlanningProjection.perPeriodGross)} gross each), adding about{" "}
                {fmt(taxPlanningProjection.projectedRemainingGross)}.</>
              )}
              {taxPlanningProjection.futureVestShares > 0 && taxPlanningProjection.livePriceUsed ? (
                <>
                  {" "}
                  {taxPlanningProjection.futureVestShares.toLocaleString()} shares are still scheduled to vest before
                  year-end — valued at today's ${taxPlanningProjection.livePriceUsed.toFixed(2)}, that's about{" "}
                  {fmt(taxPlanningProjection.futureVestValue)} more ordinary income.
                </>
              ) : taxPlanningProjection.futureVestShares > 0 ? (
                <> Shares are still scheduled to vest before year-end, but a live stock price wasn't available to value them here.</>
              ) : (
                <> No further RSU vests are scheduled before year-end.</>
              )}{" "}
              Put together, that's a projected {fmt(taxPlanningProjection.fullYearGross)} gross for {yr.year} — and on
              that basis, if nothing changes, your projected federal tax for the year is about{" "}
              {fmt(taxPlanningProjection.projectedFederalTax)} ({stateResidency.name}: about {fmt(taxPlanningProjection.projectedStateTax)}).
              Every scenario below is measured against this projection, not just what's happened so far.
            </p>
            {taxPlanningProjection.fullYearEspp > 0 && (
              <p className="tp-card-desc" style={{ marginTop: "0.5rem" }}>
                Separately: you're on track to contribute about {fmt(taxPlanningProjection.fullYearEspp)} to ESPP this
                year ({fmt(taxPlanningProjection.totalEsppYtd)} so far, about {fmt(taxPlanningProjection.projectedRemainingEspp)} more
                projected). ESPP is a post-tax payroll deduction — it doesn't change any of the tax numbers above, it just
                buys NVDA shares at a discount on the plan's purchase cycle.
                {taxPlanningProjection.nextEsppPurchaseDate && taxPlanningProjection.projectedEsppByNextPurchase != null && (
                  <> Your next purchase looks to land around {fmtDate(taxPlanningProjection.nextEsppPurchaseDate)}
                  (inferred from the gap between your last purchases), by which you're on track to have put in about{" "}
                  {fmt(taxPlanningProjection.projectedEsppByNextPurchase + taxPlanningProjection.totalEsppYtd)}.</>
                )} The IRS caps ESPP purchases at $25,000 of stock value per calendar year — this app doesn't check that
                cap precisely, so it's worth confirming with your plan administrator if you're contributing near the max.
              </p>
            )}
          </div>
          {(["Contribution Room", "Equity Timing", "Deduction Strategy", "Withholding", "State Tax", "Informational"] as const).map((cat) => {
            const items = taxPlanningScenarios.filter((s) => s.category === cat);
            if (items.length === 0) return null;
            const cards = items.map((s) => (
              <div key={s.id} className={`tp-card${s.actionable ? "" : " tp-card--dim"}`}>
                <div className="tp-card-head">
                  <strong className="tp-card-title">{s.title}</strong>
                  {s.totalSavings > 0 && (
                    <strong className={`tp-card-amount${s.hypothetical ? " tp-card-amount--hypothetical" : ""}`}>
                      {s.hypothetical ? "if sold: " : "up to "}{fmt(s.totalSavings)}
                    </strong>
                  )}
                </div>
                <p className="tp-card-desc">{s.description}</p>
                {s.totalSavings > 0 && (
                  <p className="tp-card-meta">
                    Federal: {fmt(s.fedSavings)} {s.stateSavings > 0 && <>· {stateResidency.name}: {fmt(s.stateSavings)}</>}
                    {s.deadline && <> · by {fmtDate(s.deadline)}</>}
                  </p>
                )}
                {s.caveat && <p className="tp-card-caveat">{s.caveat}</p>}
              </div>
            ));
            // Equity Timing is purely informational (contingent on a sale you're not currently
            // planning) and tends to have the most cards, one per held lot -- collapsed by
            // default so it doesn't dominate the page; the summary line alone tells you whether
            // it's worth opening.
            if (cat === "Equity Timing") {
              const total = items.reduce((s, i) => s + i.totalSavings, 0);
              return (
                <details key={cat} className="tp-cat">
                  <summary className="tp-cat-label tp-cat-label--collapsible">
                    {cat} — {items.length} batch{items.length !== 1 ? "es" : ""} not yet long-term
                    {total > 0 && <span className="tp-trigger-amt"> · up to {fmt(total)} total if each is held to its own anniversary</span>}
                  </summary>
                  <div style={{ marginTop: "0.6rem" }}>{cards}</div>
                </details>
              );
            }
            return (
              <div key={cat} className="tp-cat">
                <h5 className="tp-cat-label">{cat}</h5>
                {cards}
              </div>
            );
          })}
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setShowTaxPlanningModal(false)}>Close</button>
          </div>
        </Modal>
      )}

      {periodEsppModal && (
        <Modal title={`ESPP Purchases — ${periodEsppModal.label}`} onClose={() => setPeriodEsppModal(null)} wide>
          <EsppTable items={periodEsppModal.items} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setPeriodEsppModal(null)}>Close</button>
          </div>
        </Modal>
      )}

      {voucherModalTx && (
        <Modal title={`${voucherModalTx.type} #${voucherModalTx.number || "—"}`} onClose={() => setVoucherModalTx(null)}>
          <VoucherTypeBadge type={voucherModalTx.type} />
          <p style={{ margin: "0.5rem 0 0.75rem", fontSize: 13, opacity: 0.75 }}>
            {new Date(voucherModalTx.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
          </p>
          {voucherModalTx.narration && <p style={{ margin: "0 0 0.75rem", fontSize: 13 }}>{voucherModalTx.narration}</p>}
          <VoucherFlow entries={voucherModalTx.entries} fmt={fmt} />
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button onClick={() => setVoucherModalTx(null)}>Close</button>
            {!readOnly && (
              <button onClick={() => { const tx = voucherModalTx; setVoucherModalTx(null); onViewVoucher(tx); }}>Edit in Daybook →</button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
