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
  const re = new RegExp(labelPattern, "i");
  const m = re.exec(text);
  if (!m) return undefined;
  const lineEnd = text.indexOf("\n", m.index);
  const after = text.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd);
  const tokens = [...after.matchAll(/\d[\d,]*([a-eA-E]?)/g)];
  const values = tokens.filter((t) => !t[1]).map((t) => t[0]);
  if (values.length === 0) return undefined;
  const raw = values.length >= 2 ? values[1] : values[0];
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
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

/** Parses one ITR-V / ITR Acknowledgement PDF's positionally-reconstructed text. Handles the
 * three layout eras seen across AY 2008-09 through AY 2026-27: the oldest ("FORM ITR-V",
 * spaced-out assessment year digits like "2 0 0 8 - 0 9"), the mid-era ("INDIAN INCOME TAX
 * RETURN ACKNOWLEDGEMENT", "Gross total income"), and the newest receipt format (no separate
 * Gross Total Income / Deductions lines -- just "Total Income"). Field labels vary in case
 * and punctuation year to year, so every match is case-insensitive. */
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
  const deductionsChapterVIA = lineItem(text, "Deductions\\s*under\\s*Chapter[\\s-]*VI[\\s-]*A");
  const totalIncomeRaw = lineItem(text, "(?<!Gross\\s{0,3})Total\\s*Income\\b(?!\\s*and)");
  const grossTotalIncome = grossTotalIncomeRaw ?? totalIncomeRaw;
  const totalIncome = totalIncomeRaw ?? grossTotalIncomeRaw;
  const taxPayable = lineItem(text, "Net\\s*[Tt]ax\\s*[Pp]ayable") ?? 0;
  const advanceTax = lineItem(text, "a\\s*Advance\\s*Tax") ?? lineItem(text, "Advance\\s*Tax") ?? 0;
  const tds = lineItem(text, "b\\s*TDS") ?? lineItem(text, "\\bTDS\\b") ?? 0;
  const tcs = lineItem(text, "c\\s*TCS") ?? lineItem(text, "\\bTCS\\b") ?? 0;
  const selfAssessmentTax = lineItem(text, "Self\\s*Assessment\\s*Tax") ?? 0;
  const refund = lineItem(text, "Refund\\s*\\(7e-6\\)") ?? lineItem(text, "\\bRefund\\b");
  const balanceDue = lineItem(text, "Tax\\s*Payable\\s*\\(6-7[ed]\\)");
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

/** Opens (decrypting if needed) and extracts an ITR-V/Acknowledgement PDF in the browser.
 * Older filings (pre-~2016) are password-protected (PAN + DOB); newer portal downloads
 * generally aren't -- tries with no password first, and only asks for one if the PDF actually
 * needs it, so a mixed batch of old and new files works in one import. */
export async function parseIndiaItrFile(file: File, password: string): Promise<Omit<IndiaItrYear, "id">> {
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

  const parsed = parseIndiaItrText(text);
  if (!parsed) throw new Error(`Could not find an Assessment Year in ${file.name} — is this an ITR-V/Acknowledgement PDF?`);
  return parsed;
}
