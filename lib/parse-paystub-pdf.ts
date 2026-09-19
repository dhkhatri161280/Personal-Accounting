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
//
// Each PDF PAGE is parsed independently, then summed -- confirmed live: NVIDIA issues a
// multi-page "Pay Statement" PDF for a same-day multi-lot RSU vesting, one full page per lot,
// each with its own Period/Pay dates (identical across pages) and its own Federal/State/
// Medicare withholding on just that lot's value. An earlier version merged every page's text
// into one shared row set before extracting anything, so `rows.find()` (first match only)
// silently returned just ONE page's numbers -- not the total -- for every field.

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
  // Summed across every page of the PDF that looks like its own Pay Statement.
  base: number; // Salary
  telephone: number; // Wireless Device
  medical: number; // Medical + Dental + Vision + Legal Plan (matches the app's existing
                    // combined-bucket convention -- see the PAYROLL_MEDICAL comment history
                    // in components/vault/PlaidImport.tsx)
  k401: number; // 401(k) plan, employee
  k401Emplr: number; // 401k- Employer
  espp: number; // Sum of every "ESPP <n>" row's employee current (NVIDIA rolls the offering
                // number every ~6 months, so which one is actively contributing varies)
  federal: number;
  ssn: number; // Social Security Employee Tax
  medicare: number;
  stateWH: number; // "<State> State Income Tax" -- state name varies by residency
  stateSDI: number; // "<State> Voluntary Plan EE" / SDI -- varies by residency, may not exist
  totalTax: number;
  distribution: ParsedPaystubDistribution[];
  rawText: string;
  pageCount: number; // how many pages looked like a real Pay Statement page (>1 means summed)
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
  // Trimmed and matched anywhere in the string, not anchored to the whole thing -- pdfjs can
  // hand back a cell's text with stray leading/trailing whitespace (including non-breaking
  // spaces some PDF generators use for alignment) that a `^...$` anchor would reject outright.
  const m = s.trim().match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
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

// Sums colIndex across every row whose first column matches `label`, not just the first --
// needed for ESPP, where NVIDIA numbers offering periods sequentially (ESPP 810, 811, 812, ...)
// and rolls to a new number roughly every 6 months, so a paystub can show 2-3 ESPP lines at once
// with the currently-contributing one being whichever number happens to be active that period.
function rowValuesSum(rows: Row[], label: RegExp, colIndex: number): number {
  return rows
    .filter((r) => label.test(r.cols[0] || ""))
    .reduce((sum, r) => sum + toNum(r.cols[colIndex]), 0);
}

function rowExists(rows: Row[], label: RegExp): boolean {
  return rows.some((r) => label.test(r.cols[0] || ""));
}

// The "Pay Statement" header box (Period Start/End Date, Pay Date, Document, Net Pay) sits in
// the top-right corner of the page, at the same Y range as the top-LEFT NVIDIA letterhead/
// address block -- buildRows groups purely by Y, so those two unrelated columns can merge into
// one row, with the address text sorted before the label at cols[0] (confirmed live: a real
// paystub's "Period Start Date" label failed to match cols[0] exactly, even though the parser's
// own flat rawText -- every text item joined with plain spaces in original reading order, no
// column grouping at all -- clearly contained "Period Start Date 09/17/2026" back to back).
// Searching a page's own flat text directly for the label immediately followed by a date
// sidesteps the row/column collision entirely for these three fields.
function findDateNear(pageText: string, label: RegExp): string {
  const unanchored = label.source.replace(/^\^/, "").replace(/\$$/, "");
  const pattern = new RegExp(unanchored + "\\D{0,10}(\\d{1,2}\\s*/\\s*\\d{1,2}\\s*/\\s*\\d{4})", "i");
  const m = pageText.match(pattern);
  return m ? m[1] : "";
}

type PageFields = {
  periodStart: string; periodEnd: string; payDate: string; netPay: number;
  base: number; telephone: number; medical: number; k401: number; k401Emplr: number; espp: number;
  federal: number; ssn: number; medicare: number; stateWH: number; stateSDI: number; totalTax: number;
  distribution: ParsedPaystubDistribution[];
  warnings: string[];
};

// A genuine NVIDIA pay-stub page always has at least one of these anchor rows -- used both to
// decide whether the WHOLE upload is a pay-stub at all, and (per page) whether a given page of
// a multi-page PDF is its own Pay Statement worth including, vs. some unrelated trailing page.
function looksLikePaystubPage(rows: Row[]): boolean {
  return (
    rowExists(rows, /^Period Start Date$/i) ||
    rowExists(rows, /^Period End Date$/i) ||
    rowExists(rows, /^Pay Date$/i) ||
    rowExists(rows, /^Salary$/i) ||
    rowExists(rows, /^Net Pay$/i)
  );
}

function parsePageFields(rows: Row[], pageText: string): PageFields {
  const warnings: string[] = [];

  // ── Header dates + net pay ──────────────────────────────────────────────
  const periodStart = usDateToIso(findDateNear(pageText, /^Period Start Date$/i));
  const periodEnd = usDateToIso(findDateNear(pageText, /^Period End Date$/i));
  const payDate = usDateToIso(findDateNear(pageText, /^Pay Date$/i));
  if (!periodStart || !periodEnd) warnings.push("Could not detect the pay period dates — please check the period this belongs to.");
  if (!payDate) warnings.push("Could not detect the pay date.");

  // Checking row EXISTENCE, not the parsed value, for these "could not detect" warnings -- a
  // stock-only "vesting" pay statement (no regular salary paid that run, taxes withheld entirely
  // via shares) legitimately has $0.00 Net Pay and $0.00 Salary, which isn't a parse failure.
  // rowValue() already returns 0 (not an error) when a row is genuinely absent -- see its own
  // comment -- so testing the number itself can't tell "row missing" apart from "row says $0".
  const netPay = rowValue(rows, /^Net Pay$/i, 1);
  if (!rowExists(rows, /^Net Pay$/i)) warnings.push("Could not detect Net Pay.");

  // ── Earnings ─────────────────────────────────────────────────────────────
  // "Salary" has Hours + Pay Rate before Current (index 3); rows with no hourly rate
  // (Wireless Device, imputed-income lines) go straight to Current at index 1.
  const base = rowValue(rows, /^Salary$/i, 3);
  if (!rowExists(rows, /^Salary$/i)) warnings.push("Could not detect Salary (Base) — please check manually.");
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
  const espp = rowValuesSum(rows, /^ESPP \d+$/i, 2);

  // ── Taxes (Current is column index 1) ─────────────────────────────────────
  const federal = rowValue(rows, /^Federal Income Tax$/i, 1);
  const ssn = rowValue(rows, /Social Security Employee Tax$/i, 1);
  const medicare = rowValue(rows, /^Employee Medicare$/i, 1);
  // State tax line names vary by residency ("CA State Income Tax", "NJ State Income Tax", ...);
  // match on the common suffix instead of hardcoding a state.
  const stateWH = rowValue(rows, /State Income Tax$/i, 1);
  const stateSDIRowExists = rowExists(rows, /Voluntary Plan EE$/i) || rowExists(rows, /\bSDI\b/i);
  const stateSDI = rowValue(rows, /Voluntary Plan EE$/i, 1) || rowValue(rows, /\bSDI\b/i, 1);
  if (!rowExists(rows, /^Federal Income Tax$/i)) warnings.push("Could not detect Federal Income Tax — please check manually.");
  if (!rowExists(rows, /State Income Tax$/i)) warnings.push("Could not detect state income tax withholding — please check manually.");
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
  const distTotal = distribution.reduce((s, d) => s + d.amount, 0);
  if (netPay && distribution.length > 0 && Math.abs(distTotal - netPay) > 0.02) {
    warnings.push(`Net Pay Distribution accounts sum to ${distTotal.toFixed(2)}, which doesn't match Net Pay ${netPay.toFixed(2)} — please double-check.`);
  }

  return {
    periodStart, periodEnd, payDate, netPay,
    base, telephone, medical, k401, k401Emplr, espp,
    federal, ssn, medicare, stateWH, stateSDI, totalTax,
    distribution, warnings,
  };
}

export async function parsePaystubPdf(file: File): Promise<ParsedPaystub> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let rawText = "";
  const pages: PageFields[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as any[]).map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }));
    const pageText = (content.items as any[]).map((item) => item.str).join(" ") + "\n";
    rawText += pageText;

    const rows = buildRows(items);
    if (!looksLikePaystubPage(rows)) continue; // a non-paystub page (cover sheet, etc.) — skip it
    pages.push(parsePageFields(rows, pageText));
  }

  // No page anywhere in the PDF looked like a pay-stub at all -- most likely an RSU vesting/
  // grant confirmation, a different paystub template, or a scanned/image-only PDF (pdfjs only
  // reads embedded text, so a scan yields zero text items and every row lookup comes back
  // empty) -- fail loudly and specifically here instead of stumbling into the vaguer "Could not
  // read the pay period dates" once every single field comes back blank.
  if (pages.length === 0) {
    throw new Error(
      "This doesn't look like an NVIDIA payroll pay-stub — no Period Start/End Date, Salary, or Net Pay rows were found. " +
      "If this is an RSU vesting/grant confirmation, that's a different document and isn't supported by this upload " +
      "(vesting data comes from the payroll Excel import instead). If it IS a pay-stub, it may be a scanned image " +
      "rather than a real PDF with selectable text, which this parser can't read."
    );
  }

  // Dates: every page of a same-day multi-lot vesting PDF shares identical Period/Pay dates --
  // take the first page's, and flag (not fail) if a later page disagrees, since that would mean
  // an unrelated pay-stub got appended to the same file rather than another lot of the same vest.
  const first = pages[0];
  const dateMismatch = pages.some((p) => p.periodEnd && first.periodEnd && p.periodEnd !== first.periodEnd);
  const warnings = [...first.warnings];
  if (dateMismatch) {
    warnings.push(`This PDF's ${pages.length} pages don't all share the same pay period dates — only summing pages that match the first page's period; please check for an unrelated page.`);
  }
  const summedPages = dateMismatch ? pages.filter((p) => p.periodEnd === first.periodEnd) : pages;
  if (pages.length > 1) warnings.push(...pages.slice(1).flatMap((p) => p.warnings));

  const sum = (f: (p: PageFields) => number) => summedPages.reduce((s, p) => s + f(p), 0);
  const netPay = sum((p) => p.netPay);
  const distribution = summedPages.flatMap((p) => p.distribution);
  // Checked once at the aggregate level, not per page -- a $0-net-pay "stock only" vesting page
  // (taxes withheld entirely via shares) legitimately has no distribution row, which isn't worth
  // flagging; only a real nonzero net pay with nowhere identified to land is actually suspicious.
  if (netPay > 0.005 && distribution.length === 0) {
    warnings.push("Could not detect the Net Pay Distribution accounts — please check the bank split manually.");
  }

  return {
    periodStart: first.periodStart, periodEnd: first.periodEnd, payDate: first.payDate,
    netPay,
    base: sum((p) => p.base), telephone: sum((p) => p.telephone), medical: sum((p) => p.medical),
    k401: sum((p) => p.k401), k401Emplr: sum((p) => p.k401Emplr), espp: sum((p) => p.espp),
    federal: sum((p) => p.federal), ssn: sum((p) => p.ssn), medicare: sum((p) => p.medicare),
    stateWH: sum((p) => p.stateWH), stateSDI: sum((p) => p.stateSDI), totalTax: sum((p) => p.totalTax),
    distribution,
    rawText, pageCount: summedPages.length, warnings,
  };
}
