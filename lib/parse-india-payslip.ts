import type { IndiaPayslipMonth } from "./vault-types";

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function num(text: string, pattern: RegExp): number | undefined {
  const m = text.match(pattern);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Earnings columns are laid out "Arrears (INR)  Current (INR)" -- most months only print the
 * Current figure (one number after the label), but a month with an arrears adjustment prints
 * BOTH (e.g. "Basic Salary   1,800.00   21,600.00"), and the actual salary for that month is
 * always the SECOND (Current) number, not the first. Captures up to two numbers after the
 * label and returns the last one found, so both cases land on the right value. */
function numCurrent(text: string, label: string): number | undefined {
  const m = text.match(new RegExp(`${label}\\s+([\\d,]+\\.\\d{2})(?:\\s+([\\d,]+\\.\\d{2}))?`));
  if (!m) return undefined;
  const n = parseFloat((m[2] ?? m[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parses one TCS-style payslip's extracted text. PDF text extraction keeps each label
 * immediately adjacent to its own value even though the on-page layout is two columns side
 * by side (label/value pairs stay intact in the linear text stream), so simple `label -> next
 * number` regexes work despite the visual column interleaving. Where a label appears more
 * than once (e.g. "Provident Fund" also appears later as a cumulative retiral balance, not
 * this month's deduction), the FIRST match in reading order is always the one we want, since
 * the Deductions section always precedes the retiral/annual sections on these slips. */
export function parseIndiaPayslipText(text: string, sourceFile: string): IndiaPayslipMonth | null {
  const header = text.match(/Payslip\s+([A-Z]{3})\s+(\d{4})/);
  if (!header) return null;
  const mm = MONTHS[header[1]];
  if (!mm) return null;
  const year = header[2];
  const label = `${header[1][0]}${header[1].slice(1).toLowerCase()} ${year}`;
  const date = `${year}-${mm}-01`;

  const basic = numCurrent(text, "Basic Salary") ?? 0;
  const hra = numCurrent(text, "House Rent Allowance") ?? 0;
  const conveyanceNonTax = num(text, /Conveyance Non Taxable\s+([\d,]+\.\d{2})/) ?? 0;
  const conveyanceTax = num(text, /(?<!Non\s)Conveyance Taxable\s+([\d,]+\.\d{2})/) ?? 0;
  const conveyance = conveyanceNonTax + conveyanceTax;
  const grossEarnings = num(text, /Total Earnings \(Current \+ Arrears\)\s+([\d,]+\.\d{2})/) ?? 0;
  const otherAllowances = Math.max(0, grossEarnings - basic - hra - conveyance);

  let pf = num(text, /Provident Fund\s+([\d,]+\.\d{2})/) ?? 0;
  const professionalTax = num(text, /Professional Tax\s+([\d,]+\.\d{2})/) ?? 0;
  const incomeTax = num(text, /Income Tax\s+([\d,]+\.\d{2})/) ?? 0;
  const totalDeductions = num(text, /Total Deductions\s+([\d,]+\.\d{2})/) ?? 0;
  // Sanity guard on the first-match-wins assumption above: "Provident Fund" appears a second
  // time later on these slips as a cumulative retiral balance, which can be far larger than
  // this month's deduction. A monthly PF deduction can never exceed total deductions -- if it
  // does, the regex almost certainly grabbed the cumulative balance instead (a future template
  // reordering sections would trigger this). Zero it out rather than silently keep a wrong
  // figure 10-50x too large; the true deduction still surfaces (lumped into otherDeductions)
  // instead of vanishing.
  if (pf > totalDeductions) pf = 0;
  const otherDeductions = Math.max(0, totalDeductions - pf - professionalTax - incomeTax);

  const netPay = num(text, /Net Pay \(INR\)\s+([\d,]+\.\d{2})/) ?? 0;

  const genMatch = text.match(/Payslip generated on\s*:\s*(\d{1,2}\s+\w+\s+\d{4}),?\s*([\d:]+)?/);
  let generatedAt: string | undefined;
  if (genMatch) {
    const d = new Date(`${genMatch[1]} ${genMatch[2] ?? "00:00:00"}`);
    if (!Number.isNaN(d.getTime())) generatedAt = d.toISOString();
  }

  return {
    label,
    date,
    basic,
    hra,
    conveyance,
    otherAllowances,
    grossEarnings,
    pf,
    professionalTax,
    incomeTax,
    otherDeductions,
    totalDeductions,
    netPay,
    annualIncome: num(text, /Annual Income\*?\s+([\d,]+\.\d{2})/),
    netTaxIncome: num(text, /Net Tax Income r\/o\s+([\d,]+\.\d{2})/),
    section80C: num(text, /80C(?:-Max 1 Lac)?\s+([\d,]+\.\d{2})/),
    section80D: num(text, /\b80D\b\s+([\d,]+\.\d{2})/),
    hsgLoanInterest: num(text, /Hsg Loan Interest\s+([\d,]+\.\d{2})/),
    chapterVIARelief: num(text, /Chapter VIA relief\s+([\d,]+\.\d{2})/),
    totalTaxPayable: num(text, /Total Tax Payable\s+([\d,]+\.\d{2})/),
    taxDeductedTillDate: num(text, /Tax Deducted till date\s+([\d,]+\.\d{2})/),
    balanceTax: num(text, /Balance Tax\s+(-?[\d,]+\.\d{2})/),
    sourceFile,
    generatedAt,
  };
}

/** Combines newly-parsed months into an existing set, replacing same-month entries with
 * whichever slip was generated later -- a reissued/corrected slip (e.g. a bonus payout that
 * revises an earlier month's numbers) should win over the original. When neither slip has a
 * comparable generation timestamp (the "Payslip generated on:" line can fail to match a
 * differently-worded/formatted slip), keeps the EXISTING record rather than blindly trusting
 * the incoming one -- a stale re-upload of an old file should not be able to silently clobber
 * a correct record just because this one detail failed to parse. */
export function mergeIndiaPayslipMonths(existing: IndiaPayslipMonth[], incoming: IndiaPayslipMonth[]): IndiaPayslipMonth[] {
  const byDate = new Map(existing.map((m) => [m.date, m]));
  for (const m of incoming) {
    const prev = byDate.get(m.date);
    if (!prev || (prev.generatedAt && m.generatedAt && m.generatedAt >= prev.generatedAt)) {
      byDate.set(m.date, m);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Decrypts (if needed) and extracts text from a password-protected payslip PDF, in the
 * browser, using the same pdfjs-dist build already used for other PDF imports in this app. */
export async function parseIndiaPayslipFile(file: File, password: string): Promise<IndiaPayslipMonth> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer, password: password || undefined }).promise;

  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item: any) => item.str).join(" ") + "\n";
  }

  const parsed = parseIndiaPayslipText(text, file.name);
  if (!parsed) throw new Error(`Could not find a "Payslip <MON> <YYYY>" header in ${file.name} — is this a TCS-style payslip?`);
  return parsed;
}
