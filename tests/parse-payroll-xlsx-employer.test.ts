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

function buildWorkbook(summaryRows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearlySheetRows(100000)), "Yearly 2017");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearlySheetRows(110000)), "Yearly 2018");
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
  assert.equal(y2017?.employer, "TechM");
  assert.equal(y2018?.employer, "Accrete");
});

test("parsePayrollXlsx: a year column with no explicit label in the Summary sheet is left unlabeled, not guessed", async () => {
  const file = buildWorkbook([
    [null, null],
    [null, "Summary Statement"],
    [null, null],
    // Only 2017 is explicitly labeled; the 2018 column intentionally has no Year value (a
    // transition-employer stub in the real file) and must NOT inherit "TechM" by proximity.
    [null, "Year", "%", "Total", 2017, null],
    [null, "Employer", null, null, "TechM", "Accrete"],
  ]);
  const data = await parsePayrollXlsx(file);
  const y2017 = data.years.find((y) => y.year === "2017");
  const y2018 = data.years.find((y) => y.year === "2018");
  assert.equal(y2017?.employer, "TechM");
  assert.equal(y2018?.employer, undefined);
});

test("parsePayrollXlsx: no Summary sheet at all leaves every year's employer undefined, not an error", async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearlySheetRows(100000)), "Yearly 2017");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const file = new File([buf], "Total Salary Details.xlsx");
  const data = await parsePayrollXlsx(file);
  assert.equal(data.years.length, 1);
  assert.equal(data.years[0].employer, undefined);
});
