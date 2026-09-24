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
  // First space is optional (not just \s+) -- a transcription typo like "Jul17 Jul 30"
  // (missing space after the first month) must still count as a real period, or this scan
  // stops right there and everything after gets misread as the Stocks sub-table, silently
  // dropping the rest of the year's periods.
  const PERIOD_LABEL_RE = /^[A-Za-z]{3}\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}$/;
  // A transition year can lead with a whole-month label ("Dec 2021", "Jan 2021") before the
  // normal bi-monthly date-range columns start (seen in the 2022 sheet). That label doesn't
  // match PERIOD_LABEL_RE, and since it's the very FIRST column checked -- not a trailing one --
  // the loop used to break immediately and silently import zero periods for the whole year.
  const MONTH_YEAR_RE = /^[A-Za-z]{3}\s+\d{4}$/;
  // A standalone "Bonus" sub-column (e.g. header "4-B" next to period "4") is a real payroll
  // column with real Gross/Tax/Net figures, just with no date range of its own -- also seen
  // only on the 2022 sheet. It must not be mistaken for the Stocks sub-table boundary either.
  const BONUS_LABEL_RE = /^Bonus$/i;
  const periodStartCol = cumulativeCol + 1;
  let lastCol = periodStartCol;
  while (hRow[lastCol] !== undefined && hRow[lastCol] !== null && hRow[lastCol] !== "") {
    const dateLabel = String(dateRow[lastCol] ?? "").trim();
    if (dateLabel && !PERIOD_LABEL_RE.test(dateLabel) && !MONTH_YEAR_RE.test(dateLabel) && !BONUS_LABEL_RE.test(dateLabel)) break;
    lastCol++;
  }

  // The trailing "Stocks" sub-table is one column per quarterly RSU vesting event — real
  // tax withheld on that specific vest, not tied to a regular pay period. Keep scanning the
  // same contiguous numeric-header run to find where THAT block ends, and keep each column's
  // value separately (not summed) so it can still be matched back to its specific vest date.
  let stockColEnd = lastCol;
  while (hRow[stockColEnd] !== undefined && hRow[stockColEnd] !== null && hRow[stockColEnd] !== "") stockColEnd++;

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
    const stockValues: number[] = [];
    for (let c = lastCol; c < stockColEnd; c++) stockValues.push(toNum(row[c]));
    // Some employer sheets (e.g. a prior employer's "<year> RCS" tab) use the tax's official
    // name "OASDI" instead of "SSN" -- same Social Security withholding, different label. The
    // rest of the app looks it up as "SSN" specifically, so normalize at parse time rather
    // than teach every lookup site both spellings.
    const normalizedLabel = label.trim() === "OASDI" ? "SSN" : label.trim();
    rows.push({ label: normalizedLabel, annual: toNum(row[annualCol]), cumulative: toNum(row[cumulativeCol]), values, stockValues });
  }

  return { year, sheetName, periodLabels, rows };
}

// Reads the workbook's own "Summary" sheet, when present, to find which employer(s) paid each
// year -- located by content (a "Year" header row immediately followed by an "Employer" row),
// not fixed cell coordinates, same defensive approach as parseSheet's "Particulars" search.
//
// A job change mid-calendar-year gets its OWN column in this table with no Year value of its
// own (a transition employer's partial-year stub) -- e.g. real columns read
// [2017:TechM, blank:Accrete, 2018:Accrete, 2019:Accrete, blank:Katerra, 2020:Katerra, ...].
// The blank Year cells are forward-filled from the last explicit year seen (so the "Accrete"
// stub after 2017 IS 2017, matching how "Yearly 2017" already folds both employers' periods
// into one sheet) -- and BOTH employers for that year are kept, not just the first, or a real
// job change would silently disappear from whichever year it happened in.
//
// The scan stops the moment it hits a non-empty, non-year Year-row value once collection has
// started (e.g. a literal "FY" label) -- the real file reuses these same columns for a second,
// unrelated Gross/Net-by-year table further right, and forward-filling into THAT would
// misattribute dollar figures as employer names.
function parseEmployerMap(wb: any, XLSX: any): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const summarySheetName = wb.SheetNames.find((n: string) => n.trim().toLowerCase() === "summary");
  if (!summarySheetName) return map;
  const grid: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[summarySheetName], { header: 1, raw: true, defval: null });

  let yearRowIdx = -1;
  for (let r = 0; r < grid.length - 1; r++) {
    const row = grid[r] ?? [];
    if (row.some((v) => norm(v) === "Year") && (grid[r + 1] ?? []).some((v) => norm(v) === "Employer")) {
      yearRowIdx = r;
      break;
    }
  }
  if (yearRowIdx === -1) return map;

  const yearRow = grid[yearRowIdx] ?? [];
  const employerRow = grid[yearRowIdx + 1] ?? [];
  let started = false;
  let lastYear: string | null = null;
  for (let c = 0; c < yearRow.length; c++) {
    const yearVal = norm(yearRow[c]);
    const isYear = (typeof yearVal === "number" || typeof yearVal === "string") && /^\d{4}$/.test(String(yearVal).trim());
    if (isYear) {
      started = true;
      lastYear = String(yearVal).trim();
    } else if (yearVal !== null && yearVal !== undefined && yearVal !== "") {
      if (started) break; // left the Year/Employer table (e.g. hit "FY")
      continue; // still in the leading "Year"/"%"/"Total" label columns
    }
    if (!started || !lastYear) continue;
    const employerVal = norm(employerRow[c]);
    if (typeof employerVal !== "string" || !employerVal.trim()) continue;
    const list = map.get(lastYear) ?? [];
    if (!list.includes(employerVal.trim())) list.push(employerVal.trim());
    map.set(lastYear, list);
  }
  return map;
}

export async function parsePayrollXlsx(file: File): Promise<PayrollData> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const employerMap = parseEmployerMap(wb, XLSX);

  const years: PayrollYear[] = [];
  // A sheet whose NAME matches the expected year pattern but whose CONTENT parseSheet couldn't
  // locate (missing "Particulars" header, or a renamed "Salary"/"CUMULATIVE" column) used to
  // just silently return null and vanish -- the whole year missing from the imported data with
  // no indication why. Track these so the caller can tell the user exactly which year(s) failed
  // and that it's a template mismatch, not "nothing to import."
  const unparsedSheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    // Most years are "Yearly <YYYY>" (current employer). A prior employer's year, before that
    // naming convention started, is instead named "<YYYY> RCS" -- same internal layout
    // (Particulars/Period header, Base/Gross Salary/Federal/.../Net Salary rows), just a
    // different tab name and no "Yearly" prefix.
    const m = sheetName.match(/^Yearly\s+(\d{4})$/) ?? sheetName.match(/^(\d{4})\s+RCS$/i);
    if (!m) continue;
    const y = parseSheet(wb.Sheets[sheetName], sheetName, m[1], XLSX);
    if (y) years.push(employerMap.has(y.year) ? { ...y, employers: employerMap.get(y.year) } : y);
    else unparsedSheets.push(sheetName);
  }

  years.sort((a, b) => b.year.localeCompare(a.year));

  return {
    years,
    importedAt: new Date().toISOString(),
    sourceFileName: file.name,
    ...(unparsedSheets.length
      ? { warnings: [`Could not parse sheet(s): ${unparsedSheets.join(", ")} -- expected a "Particulars" header row with "Salary"/"CUMULATIVE" columns; check for a renamed header.`] }
      : {}),
  };
}
