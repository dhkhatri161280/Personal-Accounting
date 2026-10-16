import type { PayrollYear, PayrollRow, Tx, EquityData, Account, Trade, ManualPayrollPeriod } from "./vault-types.ts";
import { normalizePayrollYear } from "./payroll-match.ts";
import { classifyRsuSales, classifyEsppSales, classifyTradingSales, summarizeCapitalGains, sumInterestDividendIncome } from "./tax-classify.ts";
import { estimateUsFederalTax, computeItemizedDeduction, computeHsaDeduction, type HsaCoverage } from "./tax-usa-engine.ts";
import { listUsTaxYears, type UsFilingStatus } from "./tax-usa-rules.ts";
import { matchDeductionLedgers, deductionTotal, findHsaContributions } from "./tax-deductions.ts";
import { estimateCaStateTax, computeCaItemizedDeduction } from "./tax-ca-engine.ts";
import { resolveCaTaxRules } from "./tax-ca-rules.ts";
import { estimateNjStateTax, computeNjPropertyTaxDeduction } from "./tax-nj-engine.ts";
import { estimateAzStateTax, computeAzItemizedDeduction } from "./tax-az-engine.ts";
import { resolveStateResidency } from "./tax-state-residency.ts";
import { averageMortgageBalanceForYear, deductibleMortgageInterest, CA_MORTGAGE_ACQUISITION_DEBT_CAP } from "./mortgage-amortization.ts";

// VERBATIM copy of components/reports/TaxReport.tsx's own private computeYearAggregates/
// computeYearTaxEstimate/employerTickerSet/row (as of the commit that added lib/assistant-tools.ts's
// get_tax_estimate tool) -- NOT a refactor/extraction that also updated TaxReport.tsx to call this
// instead of its own copy. That would be the architecturally cleaner, single-source-of-truth fix,
// but this report's own math has real tax-filing consequences and this environment has no way to
// live-test TaxReport.tsx's UI after a change to it -- copying instead of moving means this new
// file can be wrong without the existing, working report being put at any risk at all. If
// TaxReport.tsx's own versions of these functions are ever changed, this file needs the same
// change made here too, or the two will silently drift -- same class of risk this app has hit
// before with duplicated logic, accepted deliberately here given the alternative's regression risk.
function row(rows: PayrollRow[], label: string, occurrence = 0): PayrollRow | undefined {
  return rows.filter((r) => r.label === label)[occurrence];
}

export function employerTickerSet(equity: EquityData | undefined): Set<string> {
  const tickers = new Set<string>();
  for (const g of equity?.grants ?? []) tickers.add(g.ticker);
  for (const e of equity?.esppPurchases ?? []) tickers.add(e.ticker);
  return tickers;
}

export function computeYearAggregates(rawYr: PayrollYear, equity?: EquityData) {
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

export function computeYearTaxEstimate(
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
  const rawMortgageInterest = deductionTotal(deductionMatches, "mortgageInterest");
  const avgMortgageBalance = averageMortgageBalanceForYear({ accounts, transactions }, taxEstimateYear);
  const federalMortgageInterest = deductibleMortgageInterest(avgMortgageBalance, rawMortgageInterest).deductible;
  const federalItemized = computeItemizedDeduction(taxEstimateYear, preliminaryAgi, {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    stateIncomeTaxPaid: deductionTotal(deductionMatches, "stateIncomeTax"),
    mortgageInterest: federalMortgageInterest,
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
  const stateMortgageInterest =
    stateResidency.code === "CA"
      ? deductibleMortgageInterest(avgMortgageBalance, rawMortgageInterest, CA_MORTGAGE_ACQUISITION_DEBT_CAP).deductible
      : rawMortgageInterest;
  const stateItemizedInputs = {
    medicalExpenses: deductionTotal(deductionMatches, "medical"),
    propertyTax: deductionTotal(deductionMatches, "propertyTax"),
    mortgageInterest: stateMortgageInterest,
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
