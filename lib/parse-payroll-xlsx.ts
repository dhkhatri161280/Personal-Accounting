import type { PayrollData, PayrollYear, PayrollRow } from "@/lib/vault-types";

// "Total Salary Details.xlsx" layout (one sheet per year, named "Yearly <YYYY>"):
//   a "Particulars" header row, followed directly by a "Period" row with date-range
//   labels, followed by data rows (Base, Bonus, ..., Federal, SSN, ..., Total Tax, ...).
// Column/row positions are located by content, not fixed offsets — sheet_to_json's
// array indices are relative to the sheet's used range (`!ref`), which does NOT
// always start at A1/row1 (observed starting at B2 in this file), so hardcoded
// indices silently misalign and can point at the wrong row/column entirely.
function norm(v: unknown): unknown {
  return typeof v === "string" ? v.trim() : v;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseSheet(ws: any, sheetName: string, year: string, XLSX: any): PayrollYear | null {
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  let headerRowIdx = -1;
  let labelCol = -1;
  for (let r = 0; r < grid.length && headerRowIdx === -1; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (norm(row[c]) === "Particulars") {
        headerRowIdx = r;
        labelCol = c;
        break;
      }
    }
  }
  if (headerRowIdx === -1) return null;

  const hRow = grid[headerRowIdx] ?? [];
  let annualCol = -1;
  let cumulativeCol = -1;
  for (let c = 0; c < hRow.length; c++) {
    if (norm(hRow[c]) === "Salary" && annualCol === -1) annualCol = c;
    if (norm(hRow[c]) === "CUMULATIVE") cumulativeCol = c;
  }
  if (annualCol === -1 || cumulativeCol === -1) return null;

  const labelRowIdx = headerRowIdx + 1;
  const dateRow = grid[labelRowIdx] ?? [];

  // This sheet packs a second sub-table (e.g. quarterly "Stocks" vesting events) directly
  // to the right of the pay-period columns, reusing the SAME sequential header numbering
  // (..., 24, 25, 26, 27) with no gap — so the numeric-header scan alone can't tell where
  // the real periods end. The period date-range row ("Mon DD Mon DD") can: stop as soon as
  // a column's label stops looking like a period, even though the number sequence continues.
  const PERIOD_LABEL_RE = /^[A-Za-z]{3}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}$/;
  const periodStartCol = cumulativeCol + 1;
  let lastCol = periodStartCol;
  while (hRow[lastCol] !== undefined && hRow[lastCol] !== null && hRow[lastCol] !== "") {
    const dateLabel = String(dateRow[lastCol] ?? "").trim();
    if (dateLabel && !PERIOD_LABEL_RE.test(dateLabel)) break;
    lastCol++;
  }

  const periodLabels: string[] = [];
  for (let c = periodStartCol; c < lastCol; c++) periodLabels.push(String(dateRow[c] ?? "").trim());

  const rows: PayrollRow[] = [];
  for (let r = labelRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const label = row[labelCol];
    if (typeof label !== "string" || !label.trim() || label.trim() === "Period") continue;
    const values: number[] = [];
    for (let c = periodStartCol; c < lastCol; c++) values.push(toNum(row[c]));
    rows.push({ label: label.trim(), annual: toNum(row[annualCol]), cumulative: toNum(row[cumulativeCol]), values });
  }

  return { year, sheetName, periodLabels, rows };
}

export async function parsePayrollXlsx(file: File): Promise<PayrollData> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  const years: PayrollYear[] = [];
  for (const sheetName of wb.SheetNames) {
    const m = sheetName.match(/^Yearly\s+(\d{4})$/);
    if (!m) continue;
    const y = parseSheet(wb.Sheets[sheetName], sheetName, m[1], XLSX);
    if (y) years.push(y);
  }

  years.sort((a, b) => b.year.localeCompare(a.year));

  return { years, importedAt: new Date().toISOString(), sourceFileName: file.name };
}
