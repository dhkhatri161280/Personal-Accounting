import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parsePayrollXlsx } from "../lib/parse-payroll-xlsx.ts";

// Mirrors the real "Total Salary Details.xlsx" layout enough to exercise parseEmployerMap:
// a "Yearly <YYYY>" sheet (Particulars/Period/Base rows) plus a "Summary" sheet whose Year
// row is immediately followed by an Employer row, both located by content, not position.
function yearlySheetRows(salary: number) {
  return [
    [null, null],
    [null, "Salary Syncup"],
    [null, null],
    [null, "Particulars", "Salary", "%", "CUMULATIVE", 1, 2],
    [null, "Period", null, null, null, "Jan 01 Jan 15", "Jan 16 Jan 31"],
    [null, "Base", salary, null, salary, salary / 24, salary / 24],
  ];
}

function buildWorkbook(summaryRows: unknown[][], years = ["Yearly 2017", "Yearly 2018"]) {
  const wb = XLSX.utils.book_new();
  for (const name of years) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearlySheetRows(100000)), name);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new File([buf], "Total Salary Details.xlsx");
}

test("parsePayrollXlsx: tags each year with its employer from the Summary sheet's Year/Employer rows", async () => {
  const file = buildWorkbook([
    [null, null],
    [null, "Summary Statement"],
    [null, null],
    [null, "Year", "%", "Total", 2017, 2018],
    [null, "Employer", null, null, "TechM", "Accrete"],
  ]);
  const data = await parsePayrollXlsx(file);
  const y2017 = data.years.find((y) => y.year === "2017");
  const y2018 = data.years.find((y) => y.year === "2018");
  assert.deepEqual(y2017?.employers, ["TechM"]);
  assert.deepEqual(y2018?.employers, ["Accrete"]);
});

test("parsePayrollXlsx: a transition year (job change mid-year) collects BOTH employers, not just the first", async () => {
  // Mirrors the real file exactly: 2017 is explicitly labeled TechM, then an unlabeled stub
  // column (no Year value of its own) is labeled Accrete -- that stub belongs to 2017 too
  // (forward-filled), and "Yearly 2017" already folds both employers' periods into one sheet.
  const file = buildWorkbook([
    [null, null],
    [null, "Summary Statement"],
    [null, null],
    [null, "Year", "%", "Total", 2017, null],
    [null, "Employer", null, null, "TechM", "Accrete"],
  ]);
  const data = await parsePayrollXlsx(file);
  const y2017 = data.years.find((y) => y.year === "2017");
  assert.deepEqual(y2017?.employers, ["TechM", "Accrete"]);
});

test("parsePayrollXlsx: stops at the workbook's second Gross/Net-by-year table instead of misreading it as more employers", async () => {
  // The real file reuses the same row for a second, unrelated table further right (a literal
  // "FY" label followed by more year numbers and dollar figures, not employer names). Once
  // collection has started, hitting a non-empty non-year cell must stop the scan, not keep
  // forward-filling into it.
  const file = buildWorkbook(
    [
      [null, null],
      [null, "Summary Statement"],
      [null, null],
      [null, "Year", "%", "Total", 2017, null, "FY", 2017],
      [null, "Employer", null, null, "TechM", "Accrete", null, "Gross"],
    ],
    ["Yearly 2017"]
  );
  const data = await parsePayrollXlsx(file);
  const y2017 = data.years.find((y) => y.year === "2017");
  assert.deepEqual(y2017?.employers, ["TechM", "Accrete"]);
});

test("parsePayrollXlsx: no Summary sheet at all leaves every year's employers undefined, not an error", async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearlySheetRows(100000)), "Yearly 2017");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const file = new File([buf], "Total Salary Details.xlsx");
  const data = await parsePayrollXlsx(file);
  assert.equal(data.years.length, 1);
  assert.equal(data.years[0].employers, undefined);
});
