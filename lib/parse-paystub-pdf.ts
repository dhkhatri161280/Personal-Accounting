// Parses an NVIDIA "Pay Statement" PDF directly in the browser (pdfjs-dist, already a
// dependency -- see lib/parse-grant-pdf.ts for the same pattern applied to RSU grant letters).
//
// Unlike parse-grant-pdf.ts, this reconstructs the PDF's actual table rows from each text
// item's (x, y) position instead of just joining every string on the page -- validated against
// several real paystubs (node probe script, not committed) because the naive "join everything
// then regex the whole blob" approach is genuinely ambiguous here: e.g. the "Salary" row is
// "Salary | 86.670000 | $117.3032 | $10,166.67 | $149,416.69" (Hours, Pay Rate, Current, YTD --
// TWO dollar amounts before the one that matters), so a plain "first $ after the label" regex
// would silently grab the Pay Rate instead of the actual earning. Reconstructing rows by Y
// position and reading a specific column INDEX avoids that whole class of mistake.

export interface ParsedPaystubDistribution {
  accountLast4: string;
  accountType: string;
  amount: number;
}

export interface ParsedPaystub {
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  payDate: string;
  netPay: number;
  // Mapped to the same fields the Tax tab's manual-period form (MANUAL_FIELDS in
  // components/reports/TaxReport.tsx) already uses -- so this can pre-fill that exact form.
  base: number; // Salary
  telephone: number; // Wireless Device
  medical: number; // Medical + Dental + Vision + Legal Plan (matches the app's existing
                    // combined-bucket convention -- see the PAYROLL_MEDICAL comment history
                    // in components/vault/PlaidImport.tsx)
  k401: number; // 401(k) plan, employee
  k401Emplr: number; // 401k- Employer
  espp: number; // ESPP 811 + ESPP 812, employee current
  federal: number;
  ssn: number; // Social Security Employee Tax
  medicare: number;
  stateWH: number; // "<State> State Income Tax" -- state name varies by residency
  stateSDI: number; // "<State> Voluntary Plan EE" / SDI -- varies by residency, may not exist
  totalTax: number;
  distribution: ParsedPaystubDistribution[];
  rawText: string;
  warnings: string[];
}

function toNum(s: string | undefined): number {
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s.trim());
  const n = parseFloat(s.replace(/[$,()]/g, "").trim());
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function usDateToIso(s: string): string {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

type Row = { y: number; cols: string[]; text: string };

// Groups text items into table rows by rounded Y position (items on the same visual line land
// on the same PDF-space Y almost exactly), sorted left-to-right within each row -- this is what
// makes reading a specific COLUMN reliable instead of guessing from a flattened string.
function buildRows(items: { str: string; x: number; y: number }[]): Row[] {
  const byY = new Map<number, { str: string; x: number }[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.y);
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y)!.push({ str: it.str, x: it.x });
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, its]) => {
      const cols = its.slice().sort((a, b) => a.x - b.x).map((i) => i.str);
      return { y, cols, text: cols.join(" | ") };
    });
}

// Finds the first row whose first column matches `label`, and returns column[colIndex] parsed
// as a dollar amount. Returns 0 (not an error) when the row is entirely absent -- a $0 deduction
// or benefit often just doesn't appear as a row at all on a given paystub.
function rowValue(rows: Row[], label: RegExp, colIndex: number): number {
  const row = rows.find((r) => label.test(r.cols[0] || ""));
  return row ? toNum(row.cols[colIndex]) : 0;
}

function rowExists(rows: Row[], label: RegExp): boolean {
  return rows.some((r) => label.test(r.cols[0] || ""));
}

export async function parsePaystubPdf(file: File): Promise<ParsedPaystub> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const allItems: { str: string; x: number; y: number }[] = [];
  let rawText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items as any[]) {
      allItems.push({ str: item.str, x: item.transform[4], y: item.transform[5] });
    }
    rawText += content.items.map((item: any) => item.str).join(" ") + "\n";
  }
  const rows = buildRows(allItems);
  const warnings: string[] = [];

  // ── Header dates + net pay ──────────────────────────────────────────────
  const periodStartRaw = rowValueRaw(rows, /^Period Start Date$/i, 1);
  const periodEndRaw = rowValueRaw(rows, /^Period End Date$/i, 1);
  const payDateRaw = rowValueRaw(rows, /^Pay Date$/i, 1);
  const periodStart = usDateToIso(periodStartRaw);
  const periodEnd = usDateToIso(periodEndRaw);
  const payDate = usDateToIso(payDateRaw);
  if (!periodStart || !periodEnd) warnings.push("Could not detect the pay period dates — please check the period this belongs to.");
  if (!payDate) warnings.push("Could not detect the pay date.");

  const netPay = rowValue(rows, /^Net Pay$/i, 1);
  if (!netPay) warnings.push("Could not detect Net Pay.");

  // ── Earnings ─────────────────────────────────────────────────────────────
  // "Salary" has Hours + Pay Rate before Current (index 3); rows with no hourly rate
  // (Wireless Device, imputed-income lines) go straight to Current at index 1.
  const base = rowValue(rows, /^Salary$/i, 3);
  if (!base) warnings.push("Could not detect Salary (Base) — please check manually.");
  const telephone = rowValue(rows, /^Wireless Device$/i, 1);

  // ── Deductions (Employee Current is column index 2 for every deduction row) ──
  const dedCurrent = (label: RegExp) => rowValue(rows, label, 2);
  const medicalCore = dedCurrent(/^Medical$/i);
  const dental = dedCurrent(/^Dental$/i);
  const vision = dedCurrent(/^Vision$/i);
  const legalPlan = dedCurrent(/^Legal Plan$/i);
  const medical = medicalCore + dental + vision + legalPlan;
  const k401 = dedCurrent(/^401\(k\) plan$/i);
  const k401Emplr = rowValue(rows, /^401k-\s*Employer$/i, 4); // Employer Current, not Employee Current
  const espp = dedCurrent(/^ESPP 811$/i) + dedCurrent(/^ESPP 812$/i);

  // ── Taxes (Current is column index 1) ─────────────────────────────────────
  const federal = rowValue(rows, /^Federal Income Tax$/i, 1);
  const ssn = rowValue(rows, /Social Security Employee Tax$/i, 1);
  const medicare = rowValue(rows, /^Employee Medicare$/i, 1);
  // State tax line names vary by residency ("CA State Income Tax", "NJ State Income Tax", ...);
  // match on the common suffix instead of hardcoding a state.
  const stateWH = rowValue(rows, /State Income Tax$/i, 1);
  const stateSDIRowExists = rowExists(rows, /Voluntary Plan EE$/i) || rowExists(rows, /\bSDI\b/i);
  const stateSDI = rowValue(rows, /Voluntary Plan EE$/i, 1) || rowValue(rows, /\bSDI\b/i, 1);
  if (!federal) warnings.push("Could not detect Federal Income Tax — please check manually.");
  if (!stateWH) warnings.push("Could not detect state income tax withholding — please check manually.");
  if (!stateSDIRowExists) warnings.push("No state SDI/Voluntary Plan line found — defaulted to $0; confirm that's correct for this state/period.");

  const totalTax = federal + ssn + medicare + stateWH + stateSDI;

  // ── Net Pay Distribution (one or more bank accounts) ──────────────────────
  // This table can share a row with an unrelated left-side "Paid Time Off" table at the same Y
  // position -- search within each row's text for the masked-account pattern rather than
  // requiring it to be the whole row.
  const distribution: ParsedPaystubDistribution[] = [];
  const distPattern = /(x{4,}\d{3,4})\s*\|\s*(Checking|Savings)\s*\|\s*\$?([\d,]+\.\d{2})/gi;
  for (const row of rows) {
    let m: RegExpExecArray | null;
    distPattern.lastIndex = 0;
    while ((m = distPattern.exec(row.text)) !== null) {
      distribution.push({ accountLast4: m[1].replace(/^x+/i, ""), accountType: m[2], amount: toNum(m[3]) });
    }
  }
  if (distribution.length === 0) warnings.push("Could not detect the Net Pay Distribution accounts — please check the bank split manually.");
  const distTotal = distribution.reduce((s, d) => s + d.amount, 0);
  if (netPay && distribution.length > 0 && Math.abs(distTotal - netPay) > 0.02) {
    warnings.push(`Net Pay Distribution accounts sum to ${distTotal.toFixed(2)}, which doesn't match Net Pay ${netPay.toFixed(2)} — please double-check.`);
  }

  return {
    periodStart, periodEnd, payDate, netPay,
    base, telephone, medical, k401, k401Emplr, espp,
    federal, ssn, medicare, stateWH, stateSDI, totalTax,
    distribution, rawText, warnings,
  };
}

// Same lookup as rowValue() but returns the raw string instead of parsing it as a dollar
// amount -- used for the date fields.
function rowValueRaw(rows: Row[], label: RegExp, colIndex: number): string {
  const row = rows.find((r) => label.test(r.cols[0] || ""));
  return row ? (row.cols[colIndex] || "") : "";
}
