import type { PayrollData, PayrollYear } from "@/lib/vault-types";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// Only handles the "Mon DD Mon DD" period-label format used by the NVIDIA-era sheets
// (2024+). Older/prior-employer sheets use inconsistent labels ("Dec 2021", etc.) —
// those simply fail to parse here and are skipped, which is fine since Plaid's
// payroll auto-detection is NVIDIA-specific anyway.
function parsePeriodRange(label: string, year: string): { start: string; end: string } | null {
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2})$/);
  if (!m) return null;
  const mo1 = MONTHS[m[1]];
  const mo2 = MONTHS[m[3]];
  if (!mo1 || !mo2) return null;
  let endYear = year;
  if (mo1 === "12" && mo2 === "01") endYear = String(Number(year) + 1);
  return {
    start: `${year}-${mo1}-${m[2].padStart(2, "0")}`,
    end: `${endYear}-${mo2}-${m[4].padStart(2, "0")}`,
  };
}

export type PayrollPeriodRef = { yearIdx: number; periodIndex: number };

// Bank deposits (payday) typically post a few days after the pay period ends.
const PAYDAY_LAG_DAYS = 5;

export function matchPayrollPeriod(payroll: PayrollData | undefined, txDate: string): PayrollPeriodRef | null {
  if (!payroll) return null;
  for (let yi = 0; yi < payroll.years.length; yi++) {
    const y = payroll.years[yi];
    for (let pi = 0; pi < y.periodLabels.length; pi++) {
      const range = parsePeriodRange(y.periodLabels[pi], y.year);
      if (!range) continue;
      const endPlus = new Date(range.end + "T00:00:00Z");
      endPlus.setUTCDate(endPlus.getUTCDate() + PAYDAY_LAG_DAYS);
      const endPlusStr = endPlus.toISOString().slice(0, 10);
      if (txDate >= range.start && txDate <= endPlusStr) return { yearIdx: yi, periodIndex: pi };
    }
  }
  return null;
}

export function rowValue(year: PayrollYear, label: string, periodIndex: number, occurrence = 0): number {
  const r = year.rows.filter((x) => x.label === label)[occurrence];
  return r?.values[periodIndex] ?? 0;
}
