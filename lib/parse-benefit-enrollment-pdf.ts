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
// 0 text items across all 10 pages). For that case this falls back to OCR (tesseract.js --
// free, open-source, runs entirely in the browser; no paid API, no server round-trip) instead of
// just failing outright. OCR is inherently less reliable than real embedded text (a misread digit
// is possible), so the OCR path always carries a warning telling the caller to have the user
// double-check every number -- the UI's existing "review before save" table is the real safety
// net here, not blind trust in what OCR produced.

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
  source: "text" | "ocr";
}

type Item = { str: string; x: number; y: number };

function toNum(s: string): number {
  // Strips whitespace too, not just "$,"  -- confirmed live OCR can split a number with a stray
  // internal space ("$1 93.50"); harmless for the real-text path, which never produces one.
  const n = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function usDateToIso(s: string): string {
  const m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function isMeaningfulText(s: string): boolean {
  return s.trim().length > 0;
}

// Shared across both the real-text and OCR paths: the "Your Benefits as of" date, and a
// self-check that every category's cost sums to the page's own printed total.
function finalizeResult(
  rawText: string,
  totalCostPerPayPeriod: number,
  categories: ParsedBenefitCategory[],
  warnings: string[],
  source: "text" | "ocr"
): ParsedBenefitEnrollment {
  const asOfMatch = rawText.match(/Your Benefits as of\s*(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})/i);
  const asOfDate = asOfMatch ? usDateToIso(asOfMatch[1]) : "";
  if (!asOfDate) warnings.push("Could not detect the \"Your Benefits as of\" date.");

  const sumOfCategories = categories.reduce((s, c) => s + c.costPerPayPeriod, 0);
  if (totalCostPerPayPeriod > 0 && Math.abs(sumOfCategories - totalCostPerPayPeriod) > 0.5) {
    warnings.push(
      `The sum of every category's cost ($${sumOfCategories.toFixed(2)}) doesn't match the page's own total ` +
      `($${totalCostPerPayPeriod.toFixed(2)}) -- a category may have been missed or misread; please check against the PDF.`
    );
  }
  return { asOfDate, totalCostPerPayPeriod, categories, rawText, warnings, source };
}

// ── Real-text path (pdfjs text items) ───────────────────────────────────────────────────────

// The category-title column -- confirmed live at x=54 across every card (Medical, Vision,
// Hospital Insurance, Accident Insurance, ...) on a real statement. A couple points of slop for
// PDF-to-PDF rendering variance.
const CATEGORY_TITLE_X = 54;
const CATEGORY_TITLE_X_TOLERANCE = 3;
const SAME_ROW_Y_TOLERANCE = 4;
const PLAN_NAME_Y_RANGE: [number, number] = [20, 45]; // how far BELOW the title to look

function parseFromTextItems(pageItems: Item[][], rawText: string): ParsedBenefitEnrollment {
  const warnings: string[] = [];

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

      const sameRow = items.filter((it) => Math.abs(it.y - title.y) <= SAME_ROW_Y_TOLERANCE && it !== title);
      const dollarItem = sameRow.find((it) => /^\$[\d,]+\.\d{2}$/.test(it.str.trim()));
      const waivedItem = sameRow.find((it) => /^Waived$/i.test(it.str.trim()));

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

      if (!dollarItem && !waivedItem && !planItem) continue; // not a real card title, a stray x=54 match

      categories.push({ category, planName, costPerPayPeriod });
    }
  }

  if (categories.length === 0) {
    throw new Error(
      "No benefit categories were found on this PDF -- it doesn't look like an NVIDIA/bswift " +
      "Benefits Enrollment Confirmation Statement. Please check the file, or enter this year's costs manually."
    );
  }

  return finalizeResult(rawText, totalCostPerPayPeriod, categories, warnings, "text");
}

// ── OCR path (scanned/image-only PDF, no extractable text) ─────────────────────────────────

// Every category name confirmed live on a real statement (2027) -- used as search anchors for
// OCR text. Confirmed live against a real scanned 2026 statement: category TITLES are
// unreliable -- the card's colored icon inconsistently eats leading letters of one or more words
// ("Medical" -> "edical", "Basic Employee Life" -> "asic mployee ife"), and a naive "search for
// this known category name" approach found barely a third of the real cards. But "Employer Cost"
// and "Your Cost" (the Cost Details box every priced card has) read PERFECTLY on every single
// card, every time -- zero corruption observed. So this doesn't search for category names at
// all: it collects every "Employer Cost $N.NN" and every "Your Cost $N.NN" occurrence separately,
// in document order, and pairs them by INDEX (1st with 1st, 2nd with 2nd, ...), not by textual
// proximity. That distinction matters: two cards sitting side-by-side get their OCR text
// interleaved (page order literally reads "Employer $19.05 Employer $75.65 Your $8.00 Your
// $33.00" for two side-by-side cards, not "Employer $19.05 Your $8.00 Employer $75.65 Your
// $33.00"), so nearest-neighbor proximity matching mis-pairs them -- index pairing gets both
// right, confirmed live (sum of every paired "Your Cost" landed on $193.50, exactly matching the
// real statement's own printed total, across all 9 real cost cards). The CATEGORY LABEL is still
// just a best-effort guess from whatever text sits before each card's Employer Cost line --
// correspondingly unreliable, which is exactly why every OCR row ships with a "please
// double-check" warning and lands in the same editable review table a real-text parse does.
function parseFromOcrText(ocrText: string): ParsedBenefitEnrollment {
  const warnings: string[] = [
    "Read via OCR (this PDF has no real embedded text, so it was recognized from the page images instead). Dollar amounts are generally reliable (cross-checked against the page's own total), but category LABELS are a rough guess -- please rename any that look wrong before saving.",
  ];

  // "Your Total Cost" specifically, not just "Your Cost" (every card's own Cost Details box also
  // says "Your Cost") -- confirmed live this is the one occurrence of the word "Total" near it.
  // Internal whitespace allowed in the digits ("$1 93.50") -- confirmed live OCR sometimes splits
  // a number with a stray space.
  const totalMatch = ocrText.match(/Your Total Cost\s*\$?\s*([\d,\s]*\d\.\d{2})/i);
  const totalCostPerPayPeriod = totalMatch ? toNum(totalMatch[1]) : 0;
  if (totalCostPerPayPeriod === 0) warnings.push("Could not detect the total cost per pay period -- please verify and enter it manually.");

  const employerCosts = findAllDollarMatches(ocrText, /Employer Cost\s*\$?\s*([\d,\s]*\d\.\d{2})/gi);
  const yourCosts = findAllDollarMatches(ocrText, /Your Cost\s*\$?\s*([\d,\s]*\d\.\d{2})/gi);
  if (employerCosts.length !== yourCosts.length) {
    warnings.push(
      `Found ${employerCosts.length} "Employer Cost" line(s) but ${yourCosts.length} "Your Cost" line(s) -- these should always come in matched pairs, so one card's cost may be missing or misread. Please check against the PDF.`
    );
  }
  const pairCount = Math.min(employerCosts.length, yourCosts.length);

  const categories: ParsedBenefitCategory[] = [];
  let windowStart = 0;
  for (let i = 0; i < pairCount; i++) {
    const planName = guessLabel(ocrText.slice(Math.max(windowStart, employerCosts[i].index - 250), employerCosts[i].index)) || `Benefit ${i + 1}`;
    categories.push({ category: planName, planName, costPerPayPeriod: yourCosts[i].value });
    windowStart = yourCosts[i].index;
  }

  if (categories.length === 0) {
    throw new Error(
      "OCR ran, but no \"Employer Cost\"/\"Your Cost\" lines were found in the result -- the scan " +
      "quality may be too low to read automatically. Please enter this year's costs manually instead."
    );
  }

  return finalizeResult(ocrText, totalCostPerPayPeriod, categories, warnings, "ocr");
}

function findAllDollarMatches(text: string, re: RegExp): { value: number; index: number }[] {
  const out: { value: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ value: toNum(m[1]), index: m.index });
  return out;
}

// Best-effort card label from whatever text sits just before its Employer Cost line -- real
// plan names ("Kaiser CA HMO", "NVIDIA PPO Dental Plan", "LegalEase") usually land in here
// uncorrupted (only the CATEGORY title, with its colored icon, gets garbled), but this is
// explicitly a guess; the review table lets the user retype it.
function guessLabel(window: string): string {
  return window
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Coverage|Effective Date|Who will be covered|Name\s+Relationship|No Coverage|Cost Details)/i.test(l))
    .slice(-2)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ocrPdf(pdf: any, onProgress?: (msg: string) => void): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  let combined = "";
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`Reading page ${i} of ${pdf.numPages} (OCR)…`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const { data } = await worker.recognize(canvas);
      combined += data.text + "\n";
    }
  } finally {
    await worker.terminate();
  }
  return combined;
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

export async function parseBenefitEnrollmentPdf(file: File, onProgress?: (msg: string) => void): Promise<ParsedBenefitEnrollment> {
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
    onProgress?.("No embedded text found -- falling back to OCR…");
    const ocrText = await ocrPdf(pdf, onProgress);
    return parseFromOcrText(ocrText);
  }

  return parseFromTextItems(pageItems, rawText);
}
