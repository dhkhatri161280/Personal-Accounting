import { cessRateFor } from "./india-tax-slabs";

export interface EquityCapitalGainsTax {
  stcgRate: number;
  stcgTax: number; // pre-cess
  ltcgTaxable: boolean; // false = exempt under Section 10(38)
  ltcgRate: number; // 0 when exempt
  ltcgExemption: number; // 0 when exempt
  ltcgTax: number; // pre-cess
  totalTaxInclCess: number;
  notes: string;
}

/** Section 111A short-term capital gains rate on STT-paid listed equity shares / equity-oriented
 * mutual funds -- 10% from AY2005-06, raised to 15% from AY2009-10, raised again to 20% from
 * AY2025-26 (Budget 2024, effective FY2024-25). No exemption threshold: taxed from Rs 1. */
function equityStcgRate(assessmentYear: string): number {
  const y = Number(assessmentYear.slice(0, 4));
  if (y <= 2008) return 0.1; // AY2005-06 to AY2008-09
  if (y <= 2024) return 0.15; // AY2009-10 to AY2024-25
  return 0.2; // AY2025-26 onward
}

/** Section 10(38) exempted LTCG on STT-paid listed equity/equity-oriented mutual funds entirely
 * through AY2018-19. Withdrawn by Budget 2018 -- Section 112A taxes it at 10% above a
 * Rs 1,00,000/year exemption from AY2019-20, raised to 12.5%/Rs 1,25,000 from AY2025-26 (Budget
 * 2024, effective FY2024-25). Returns null for years where it's still fully exempt. */
function equityLtcgRateAndExemption(assessmentYear: string): { rate: number; exemption: number } | null {
  const y = Number(assessmentYear.slice(0, 4));
  if (y <= 2018) return null; // AY2018-19 and earlier -- exempt under 10(38)
  if (y <= 2024) return { rate: 0.1, exemption: 100000 }; // AY2019-20 to AY2024-25
  return { rate: 0.125, exemption: 125000 }; // AY2025-26 onward
}

/** Estimated tax on short-term and long-term capital gains from listed equity shares /
 * equity-oriented mutual funds where STT was paid (the common brokerage-account case) --
 * Sections 111A and 112A. Does NOT apply to non-equity capital gains (debt funds, property,
 * gold, unlisted shares) -- those have different rates and need indexation, which isn't modeled
 * here. Chapter VI-A deductions (80C, 80D, etc.) can't be claimed against gains taxed under
 * these sections, so this is computed on the raw STCG/LTCG figures, not a deduction-reduced
 * amount. Returns null for an AY this app doesn't have slab/cess data for. */
export function estimateEquityCapitalGainsTax(assessmentYear: string, stcg: number, ltcg: number): EquityCapitalGainsTax | null {
  const cessRate = cessRateFor(assessmentYear);
  if (cessRate == null) return null;

  const stcgRate = equityStcgRate(assessmentYear);
  const stcgTax = Math.max(0, stcg) * stcgRate;

  const ltcgConfig = equityLtcgRateAndExemption(assessmentYear);
  const ltcgTaxable = ltcgConfig !== null;
  const ltcgRate = ltcgConfig?.rate ?? 0;
  const ltcgExemption = ltcgConfig?.exemption ?? 0;
  const ltcgTax = ltcgConfig ? Math.max(0, Math.max(0, ltcg) - ltcgConfig.exemption) * ltcgConfig.rate : 0;

  const totalTaxInclCess = Math.round((stcgTax + ltcgTax) * (1 + cessRate));

  const notes = ltcgTaxable
    ? `Equity STCG @ ${(stcgRate * 100).toFixed(0)}% (Sec 111A); LTCG @ ${(ltcgRate * 100).toFixed(1)}% above ₹${ltcgExemption.toLocaleString("en-IN")} exemption (Sec 112A)`
    : `Equity STCG @ ${(stcgRate * 100).toFixed(0)}% (Sec 111A); LTCG exempt (Sec 10(38), withdrawn from AY2019-20)`;

  return { stcgRate, stcgTax, ltcgTaxable, ltcgRate, ltcgExemption, ltcgTax, totalTaxInclCess, notes };
}
