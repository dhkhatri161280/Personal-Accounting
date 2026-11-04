// Parses an NVIDIA/bswift "Benefits Enrollment Confirmation Statement" PDF directly in the
// browser (pdfjs-dist, same approach as lib/parse-paystub-pdf.ts -- see that file's own header
// comment for why text-item (x, y) position is used instead of a flattened text blob).
//
// Confirmed live against a real 2027 confirmation PDF: every benefit "card" has its category
// title ("Medical", "Vision", "Legal Services", ...) at a fixed x=54 column, with either a
// "Your cost per pay period $N.NN" pair or a "Waived" marker on (almost) the same Y -- a small
// vertical offset (up to ~4pt) between the title and its cost, confirmed live, is why this
// clusters by Y PROXIMITY rather than exact/rounded Y match. The plan name (or "No Coverage")
// consistently sits ~20-40pt below the title, in the card's own left column.
//
// NOT every bswift PDF has real text at all -- a "print/save as PDF" capture of the confirmation
// page can be a pure image with zero extractable text (confirmed live: a real 2026 statement had
// 0 text items across all 10 pages). parseBenefitEnrollmentPdf() throws a clear, specific error
// for that case so the caller can fall back to manual entry -- same pattern as parse-paystub-pdf's
// own "looks like a scanned image" failure, and deliberately NOT OCR (no paid API calls here).

export interface ParsedBenefitCategory {
  category: string; // e.g. "Medical", "Legal Services"
  planName: string; // e.g. "Kaiser CA HMO", or "Waived"/"No Coverage"
  costPerPayPeriod: number;
}

export interface ParsedBenefitEnrollment {
  asOfDate: string; // YYYY-MM-DD, from "Your Benefits as of M/D/YYYY"
  totalCostPerPayPeriod: number; // from the page-1 "TOTAL COST PER PAY PERIOD / Your Cost" box
  categories: ParsedBenefitCategory[];
  rawText: string;
  warnings: string[];
}

type Item = { str: string; x: number; y: number };

function toNum(s: string): number {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function usDateToIso(s: string): string {
  const m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// The category-title column -- confirmed live at x=54 across every card (Medical, Vision,
// Hospital Insurance, Accident Insurance, ...) on a real statement. A couple points of slop for
// PDF-to-PDF rendering variance.
const CATEGORY_TITLE_X = 54;
const CATEGORY_TITLE_X_TOLERANCE = 3;
const SAME_ROW_Y_TOLERANCE = 4;
const PLAN_NAME_Y_RANGE: [number, number] = [20, 45]; // how far BELOW the title to look

function isMeaningfulText(s: string): boolean {
  return s.trim().length > 0;
}

export async function parseBenefitEnrollmentPdf(file: File): Promise<ParsedBenefitEnrollment> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let rawText = "";
  const pageItems: Item[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as any[])
      .map((item) => ({ str: item.str as string, x: item.transform[4] as number, y: item.transform[5] as number }))
      .filter((it) => isMeaningfulText(it.str));
    pageItems.push(items);
    rawText += items.map((it) => it.str).join(" ") + "\n";
  }

  const totalItems = pageItems.reduce((s, p) => s + p.length, 0);
  if (totalItems === 0) {
    throw new Error(
      "This PDF has no extractable text at all -- it's almost certainly a scanned image or a " +
      "\"print/save as PDF\" screen capture rather than a real text PDF. This parser can't read " +
      "that (and deliberately doesn't attempt OCR); please enter this year's benefit costs manually instead."
    );
  }

  const warnings: string[] = [];
  const asOfMatch = rawText.match(/Your Benefits as of\s*(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})/i);
  const asOfDate = asOfMatch ? usDateToIso(asOfMatch[1]) : "";
  if (!asOfDate) warnings.push("Could not detect the \"Your Benefits as of\" date.");

  // "TOTAL COST PER PAY PERIOD" box: a "Your Cost" label near a "$N.NN" a few points above/below
  // it (same card-style layout as every category), always on page 1.
  const totalLabelItem = pageItems[0]?.find((it) => /^Your Cost$/i.test(it.str.trim()));
  let totalCostPerPayPeriod = 0;
  if (totalLabelItem) {
    const amt = pageItems[0].find(
      (it) => Math.abs(it.y - totalLabelItem.y) <= 8 && /^\$[\d,]+\.\d{2}$/.test(it.str.trim())
    );
    if (amt) totalCostPerPayPeriod = toNum(amt.str);
  }
  if (totalCostPerPayPeriod === 0) warnings.push("Could not detect the total cost per pay period on page 1 -- please verify.");

  const categories: ParsedBenefitCategory[] = [];
  for (const items of pageItems) {
    const titleItems = items.filter(
      (it) => Math.abs(it.x - CATEGORY_TITLE_X) <= CATEGORY_TITLE_X_TOLERANCE && isMeaningfulText(it.str)
    );
    for (const title of titleItems) {
      const category = title.str.trim().replace(/\*$/, ""); // trailing * just flags "changed this year"

      // Cost: either a dollar amount or "Waived", on (almost) the same row as the title.
      const sameRow = items.filter((it) => Math.abs(it.y - title.y) <= SAME_ROW_Y_TOLERANCE && it !== title);
      const dollarItem = sameRow.find((it) => /^\$[\d,]+\.\d{2}$/.test(it.str.trim()));
      const waivedItem = sameRow.find((it) => /^Waived$/i.test(it.str.trim()));

      // Plan name / status: the first meaningful left-column item a bit below the title.
      const planItem = items
        .filter((it) => it.x < 100 && title.y - it.y >= PLAN_NAME_Y_RANGE[0] && title.y - it.y <= PLAN_NAME_Y_RANGE[1])
        .sort((a, b) => b.y - a.y)[0];

      let costPerPayPeriod = 0;
      let planName: string;
      if (dollarItem) {
        costPerPayPeriod = toNum(dollarItem.str);
        planName = planItem?.str.trim() || category;
      } else if (waivedItem) {
        planName = "Waived";
      } else {
        planName = planItem?.str.trim() || "No Coverage";
      }

      // Skip an obvious false-positive match (e.g. a stray x=54 item that isn't really a card
      // title) -- real category titles are always followed by either a cost or a plan/status line.
      if (!dollarItem && !waivedItem && !planItem) continue;

      categories.push({ category, planName, costPerPayPeriod });
    }
  }

  if (categories.length === 0) {
    throw new Error(
      "No benefit categories were found on this PDF -- it doesn't look like an NVIDIA/bswift " +
      "Benefits Enrollment Confirmation Statement. Please check the file, or enter this year's costs manually."
    );
  }

  const sumOfCategories = categories.reduce((s, c) => s + c.costPerPayPeriod, 0);
  if (totalCostPerPayPeriod > 0 && Math.abs(sumOfCategories - totalCostPerPayPeriod) > 0.5) {
    warnings.push(
      `The sum of every category's cost ($${sumOfCategories.toFixed(2)}) doesn't match the page's own total ` +
      `($${totalCostPerPayPeriod.toFixed(2)}) -- a category may have been missed or misread; please check against the PDF.`
    );
  }

  return { asOfDate, totalCostPerPayPeriod, categories, rawText, warnings };
}
