import type { IndiaItrYear } from "./vault-types";

// Every computation-table line on an ITR-V/Acknowledgement follows "<line-index> <label>
// <line-index-repeated> <value>" (e.g. "1 Gross Total Income 1 492578"), where the line-index
// is a small number, optionally letter-suffixed (e.g. "7a" for the row under item 7), that
// gets printed a SECOND time right before the real value. A letter-suffixed token (matched as
// a whole, e.g. "7c") is always an index, never a value, and is excluded outright -- some
// years print no value at all for a zero field (e.g. TCS), leaving only that index fragment,
// which would otherwise be mistaken for "0". Among the remaining bare-digit tokens, the
// second one is the value (the first is the bare-digit index, e.g. "4" for item 4); falls
// back to the only token found if just one remains. Bounded to the rest of the CURRENT line
// (not a fixed character count) -- layoutText already reconstructs one row per field, so
// reading further would risk bleeding into the next field's own index+value pair.
function lineItem(text: string, labelPattern: string): number | undefined {
  const re = new RegExp(labelPattern, "gi");
  // A label can legitimately appear more than once -- e.g. "Gross Total Income" shows up
  // both as a bare section heading ("Part B Gross Total Income", nothing after it on that
  // row) and again on the real data row further down ("B4 Gross Total Income (...) 432072").
  // Try every occurrence in order and use the first one that actually yields a value, rather
  // than committing to whichever comes first in reading order.
  for (const m of text.matchAll(re)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const lineEnd = text.indexOf("\n", m.index);
    const before = text.slice(lineStart, m.index);
    let after = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd);
    // Some legacy rows spell the formula out inline right after the label -- e.g.
    // "Refund (15d-14) if 15d is greater than 14 17" -- where both the parenthetical and the
    // conditional clause are packed with small digits (cross-references to OTHER line items,
    // not this row's own value) that would otherwise be mistaken for the real value. Strip
    // both before scanning for numbers; a row like this genuinely has no printed value when
    // its condition doesn't apply, which correctly falls through to "not found" below.
    after = after.replace(/^(\s*\([^)]*\))+/, "").replace(/\bif\s+\S+\s+is\s+(greater|less)\s+than\s+\S+/i, "");
    // A coincidental prose mention of a label shouldn't count as a data row -- e.g. the SAHAJ
    // form's own title says "...having total income upto Rs.50 lakh]", which contains the
    // literal phrase "total income" right before an unrelated descriptive number. Reject a
    // match if real prose (2+ words) sits between the label and the first digit; legitimate
    // rows have at most a short connector ("=", ":", a stripped formula) in between.
    const words = (after.match(/^[^\d]*/)?.[0].match(/[A-Za-z]{2,}/g) ?? []).length;
    if (words >= 2) continue;
    const tokens = [...after.matchAll(/\d[\d,]*([a-zA-Z]?)/g)];
    const values = tokens.filter((t) => !t[1]).map((t) => t[0]);
    if (values.length === 0) continue;
    // Some rows repeat their own leading item-number again at the very end of the line with
    // no real value in between (a "17 Refund ... 17" row when that year's refund was blank,
    // not actually zero-with-a-typo) -- if the only candidate left exactly matches this row's
    // own leading index, it's that repeat, not a value; move on to the next occurrence.
    if (values.length === 1) {
      const leadingIndex = before.match(/(\d+[a-zA-Z]?)\s*$/)?.[1];
      if (leadingIndex && leadingIndex === values[0]) continue;
    }
    const raw = values.length >= 2 ? values[1] : values[0];
    const n = parseFloat(raw.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Reconstructs the page's visual layout from each text item's (x, y) position rather than
 * pdfjs's raw reading order -- ITR-V/Acknowledgement PDFs lay the computation table out in a
 * grid the raw text stream doesn't preserve (label and value can be far apart in reading
 * order despite sitting on the same visual row). Drops rotated text (transform[1]/[2] non-zero
 * -- these PDFs print vertical sidebar labels like "INCOME"/"TAX"/"THEREON" down the left
 * margin purely for visual decoration; their y-coordinates land inside the data rows and would
 * otherwise inject unrelated words into the label/value search window).
 *
 * Groups the remaining items into rows by chaining: sort top-to-bottom, then start a new row
 * whenever the gap to the PREVIOUS item exceeds a threshold, rather than snapping every y to a
 * fixed grid. A fixed grid can't fit every layout era seen here -- some print a row's label and
 * its own number column several points apart (a real same-row gap up to ~4pt), while others
 * pack consecutive table rows only ~9pt apart -- so a bucket wide enough to survive the first
 * ends up merging the second. Chaining only needs a threshold comfortably between "biggest
 * real same-row gap" and "smallest real row-to-row gap", which held for every era tested here. */
function layoutText(items: { str: string; x: number; y: number; transform: number[] }[]): string {
  const filtered = items
    .filter((it) => it.str.trim() && it.transform[1] === 0 && it.transform[2] === 0)
    .sort((a, b) => b.y - a.y);
  const rows: { str: string; x: number }[][] = [];
  let current: { str: string; x: number }[] = [];
  let lastY: number | null = null;
  for (const it of filtered) {
    if (lastY !== null && lastY - it.y > 5) {
      rows.push(current);
      current = [];
    }
    current.push(it);
    lastY = it.y;
  }
  if (current.length > 0) rows.push(current);
  return rows.map((row) => row.sort((a, b) => a.x - b.x).map((r) => r.str).join(" ")).join("\n");
}

/** Form 26AS (the tax-credit statement, not a return) -- has nothing worth extracting here and
 * shouldn't be treated as an error when it turns up in a batch of ITR PDFs. */
export function isForm26AS(text: string): boolean {
  return /Form\s*26\s*AS|Annual\s*Tax\s*Statement/i.test(text);
}

/** Parses one ITR-V / Acknowledgement / Receipt / full ITR Form PDF's positionally-
 * reconstructed text. Handles every layout era seen across AY 2008-09 through AY 2026-27: the
 * oldest ITR-V ("FORM ITR-V", spaced-out assessment year digits like "2 0 0 8 - 0 9"), the
 * mid-era Acknowledgement ("INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT", "Gross total income"),
 * the newest Receipt (no separate Gross Total Income / Deductions -- just "Total Income"), the
 * older full ITR Form ("Gross Total Income (1+2+3)"/"(1+2c)", a "Taxes Paid" section on a
 * later page using the same wording as the Acknowledgement), and the newer SAHAJ full ITR
 * Form (multi-page "Part B/C/D", "Taxable Total Income", "Tax after Rebate", "Total TDS
 * Claimed" etc.). Field labels vary in case, punctuation, and section numbering year to year,
 * so every match is case-insensitive and most fields try more than one phrasing. */
export function parseIndiaItrText(text: string): Omit<IndiaItrYear, "id"> | null {
  const ayMatch =
    text.match(/Assessment\s*Year[\s\S]{0,40}?(\d\s*\d\s*\d\s*\d)\s*-\s*(\d\s*\d)/i) ??
    text.match(/(\d{4})\s*-\s*(\d{2})\b/);
  if (!ayMatch) return null;
  const startYear = ayMatch[1].replace(/\s/g, "");
  const endYear = ayMatch[2].replace(/\s/g, "");
  const assessmentYear = `${startYear}-${endYear}`;

  // The newest receipt format (AY 2026-27 on) drops the separate Gross Total Income /
  // Deductions lines entirely and prints only "Total Income" -- whichever of the two this
  // document actually has covers for the other being absent.
  const grossTotalIncomeRaw = lineItem(text, "Gross\\s*[Tt]otal\\s*[Ii]ncome");
  const deductionsChapterVIA =
    lineItem(text, "Deductions\\s*under\\s*Chapter[\\s-]*VI[\\s-]*A") ??
    lineItem(text, "C1\\s*Total\\s*Deductions") ??
    // A lookahead, not a consuming match -- "Deductions (Total of C1 to C18) C19 166308" needs
    // its own opening paren left intact in the post-label text so the generic parenthetical
    // stripper above can remove the whole "(Total of ...)" formula as one unit. Consuming the
    // paren as part of the label itself (as an earlier version of this pattern did) leaves the
    // stripper nothing to grab, and its inner "C1"/"C18" references leak through as false values.
    lineItem(text, "Deductions(?=\\s*\\(Total\\s*of)") ??
    lineItem(text, "Deductions\\s*:?\\s*Suggested\\s*Value");
  const totalIncomeRaw =
    lineItem(text, "(?<!Gross\\s{0,3})Total\\s*Income\\b(?!\\s*and)") ??
    lineItem(text, "Taxable\\s*Total\\s*Income");
  const grossTotalIncome = grossTotalIncomeRaw ?? totalIncomeRaw;
  const totalIncome = totalIncomeRaw ?? grossTotalIncomeRaw;
  const taxPayable =
    lineItem(text, "Net\\s*[Tt]ax\\s*[Pp]ayable") ??
    lineItem(text, "Tax\\s*after\\s*Rebate") ??
    lineItem(text, "Balance\\s*Tax\\s*Payable") ??
    // A third full-Form era (roughly AY 2014-15/2015-16) settles on neither of the above --
    // its own final, cess-inclusive figure (matching the Acknowledgement's "Net Tax Payable")
    // is this "Total Tax, Surcharge and/& Cess" line instead.
    lineItem(text, "Total\\s*Tax,?\\s*Surcharge\\s*(?:and|&)\\s*Cess") ??
    0;
  const advanceTax =
    lineItem(text, "a\\s*Advance\\s*Tax") ??
    lineItem(text, "Advance\\s*Tax") ??
    lineItem(text, "Total\\s*Advance\\s*Tax\\s*Paid") ??
    0;
  const tds =
    lineItem(text, "b\\s*TDS") ??
    lineItem(text, "\\bTDS\\b") ??
    lineItem(text, "Total\\s*TDS\\s*Claimed") ??
    0;
  const tcs =
    lineItem(text, "c\\s*TCS") ??
    lineItem(text, "\\bTCS\\b") ??
    lineItem(text, "Total\\s*TCS\\s*Collected") ??
    0;
  const selfAssessmentTax = lineItem(text, "Self\\s*Assessment\\s*Tax") ?? 0;
  const refund =
    lineItem(text, "Refund\\s*\\(7e-6\\)") ??
    lineItem(text, "\\bRefund\\b");
  const balanceDue =
    lineItem(text, "Tax\\s*Payable\\s*\\(6-7[ed]\\)") ??
    lineItem(text, "Amount\\s*payable"); // e.g. "Amount payable (D11 -D12)(if D11 > D12) 0" -- the
    // generic parenthetical-stripping above handles "(D10 ...)" or "(D11 ...)" either way; the
    // item numbers these formulas reference shift by year, so the label itself can't hardcode one
  const refundOrDemand = refund && refund > 0 ? refund : balanceDue ? -balanceDue : 0;

  const dateMatch =
    text.match(/Date\s*of\s*filing\s*:?\s*(\d{1,2})-(\w{3})-(\d{4})/i) ??
    text.match(/Date\s*\(DD[\/-]MM[\/-]YYYY\)[\s\S]{0,15}?(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i) ??
    text.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  let filingDate: string | undefined;
  if (dateMatch) {
    const MONTHS: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const mm = MONTHS[dateMatch[2]] ?? dateMatch[2].padStart(2, "0");
    filingDate = `${dateMatch[3]}-${mm}-${dateMatch[1].padStart(2, "0")}`;
  }

  return {
    assessmentYear,
    grossTotalIncome: grossTotalIncome ?? 0,
    deductionsChapterVIA: deductionsChapterVIA ?? 0,
    totalIncome: totalIncome ?? 0,
    taxPayable,
    advanceTax,
    tds,
    tcs,
    selfAssessmentTax,
    refundOrDemand,
    filingDate,
  };
}

/** Opens (decrypting if needed) and extracts an ITR PDF in the browser -- an ITR-V,
 * Acknowledgement, Receipt, or full ITR Form. Older filings (pre-~2016) are password-protected
 * (PAN + DOB); newer portal downloads generally aren't -- tries with no password first, and
 * only asks for one if the PDF actually needs it, so a mixed batch of old and new files works
 * in one import. Returns null (not an error) for a Form 26AS PDF that ends up in the batch --
 * it's a tax-credit statement, not a return, and has nothing to extract. */
export async function parseIndiaItrFile(file: File, password: string): Promise<Omit<IndiaItrYear, "id"> | null> {
  // Filename check first, before attempting to open at all -- a 26AS PDF often uses a
  // different password than the ITR filings in the same batch (usually DOB alone), so
  // content-based detection can't help if it never successfully decrypts in the first place.
  if (/26\s*AS/i.test(file.name)) return null;

  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  } catch {
    if (!password) throw new Error("password-protected — enter the ITR PDF password and retry");
    doc = await pdfjsLib.getDocument({ data: arrayBuffer, password }).promise;
  }

  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.map((it: any) => ({ str: it.str, x: it.transform[4], y: it.transform[5], transform: it.transform }));
    text += layoutText(items) + "\n";
  }

  if (isForm26AS(text)) return null;

  const parsed = parseIndiaItrText(text);
  if (!parsed) throw new Error(`Could not find an Assessment Year in ${file.name} — is this an ITR-V/Acknowledgement/Form PDF?`);
  return parsed;
}
