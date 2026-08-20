export interface ParsedVest {
  vestDate: string; // YYYY-MM-DD
  shares: number;
}

export interface ParsedGrant {
  ticker: string;
  grantDate: string; // YYYY-MM-DD
  totalShares: number;
  grantPrice: number;
  vests: ParsedVest[];
  rawText: string;
  warnings: string[];
}

function usDate(s: string): string {
  // MM/DD/YYYY or M/D/YYYY → YYYY-MM-DD
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

export async function parseGrantPdf(file: File): Promise<ParsedGrant> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let rawText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    rawText += content.items.map((item: any) => item.str).join(" ") + "\n";
  }

  const warnings: string[] = [];

  // ── Grant date ──────────────────────────────────────────────────────────
  let grantDate = "";
  const grantDatePatterns = [
    /(?:Grant|Award|Date of Grant|Date of Award)\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Grant\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Award\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /Date\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ];
  for (const pat of grantDatePatterns) {
    const m = rawText.match(pat);
    if (m) { grantDate = usDate(m[1]); break; }
  }
  if (!grantDate) warnings.push("Could not detect grant date — please fill in manually.");

  // ── Total shares ─────────────────────────────────────────────────────────
  let totalShares = 0;
  const sharesPatterns = [
    /Number\s+of\s+(?:Restricted\s+)?(?:Stock\s+)?Units?\s*[:\-]?\s*([\d,]+)/i,
    /(?:Total\s+)?(?:RSUs?|Restricted\s+Stock\s+Units?)\s*[:\-]?\s*([\d,]+)/i,
    /Award\s*[:\-]\s*([\d,]+)\s+(?:Restricted\s+)?(?:Stock\s+)?Units?/i,
    /([\d,]+)\s+Restricted\s+Stock\s+Units?/i,
    /([\d,]+)\s+RSUs?/i,
  ];
  for (const pat of sharesPatterns) {
    const m = rawText.match(pat);
    if (m) { totalShares = parseNum(m[1]); break; }
  }
  if (!totalShares) warnings.push("Could not detect total shares — please fill in manually.");

  // ── Grant price ──────────────────────────────────────────────────────────
  let grantPrice = 0;
  const pricePatterns = [
    /(?:Award|Grant)\s*(?:Price|Value)\s*(?:per\s*(?:Share|Unit))?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2,4})/i,
    /Fair\s*Market\s*Value\s*(?:per\s*(?:Share|Unit))?\s*(?:on\s*(?:the\s*)?(?:Grant|Award)\s*Date)?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2,4})/i,
    /FMV\s*(?:per\s*(?:Share|Unit))?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2,4})/i,
    /\$\s*([\d,]+\.\d{2,4})\s+(?:per\s+)?(?:share|unit)/i,
  ];
  for (const pat of pricePatterns) {
    const m = rawText.match(pat);
    if (m) { grantPrice = parseNum(m[1]); break; }
  }
  if (!grantPrice) warnings.push("Could not detect award price — please fill in manually.");

  // ── Vest schedule ─────────────────────────────────────────────────────────
  // Find all MM/DD/YYYY dates in the text paired with a nearby integer (shares)
  const vestMap = new Map<string, number>();

  // Pattern 1: date followed by number on same line or nearby
  const vestLinePattern = /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d[\d,]*(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = vestLinePattern.exec(rawText)) !== null) {
    const d = usDate(m[1]);
    const n = parseNum(m[2]);
    // Skip obviously wrong numbers (prices, years, etc.)
    if (d && n > 0 && n < 100000 && !String(m[2]).includes(".")) {
      // Exclude the grant date itself from vest dates
      if (d !== grantDate) vestMap.set(d, n);
    }
  }

  // Pattern 2: number followed by date (some PDFs reverse the order)
  const vestLinePattern2 = /(\d[\d,]+)\s+(\d{1,2}\/\d{1,2}\/\d{4})/g;
  while ((m = vestLinePattern2.exec(rawText)) !== null) {
    const n = parseNum(m[1]);
    const d = usDate(m[2]);
    if (d && n > 0 && n < 100000 && !String(m[1]).includes(".")) {
      if (d !== grantDate && !vestMap.has(d)) vestMap.set(d, n);
    }
  }

  const vests: ParsedVest[] = [...vestMap.entries()]
    .map(([vestDate, shares]) => ({ vestDate, shares }))
    .sort((a, b) => a.vestDate.localeCompare(b.vestDate));

  // If vest total doesn't add up to totalShares, warn
  if (vests.length > 0 && totalShares > 0) {
    const vestTotal = vests.reduce((s, v) => s + v.shares, 0);
    if (Math.abs(vestTotal - totalShares) > 5) {
      warnings.push(
        `Vest total (${vestTotal}) differs from total shares (${totalShares}) — please review the schedule.`
      );
    }
  }

  if (vests.length === 0) {
    warnings.push("Could not detect vesting schedule — add vest dates manually after saving the grant.");
  }

  return {
    ticker: "NVDA",
    grantDate,
    totalShares,
    grantPrice,
    vests,
    rawText,
    warnings,
  };
}
