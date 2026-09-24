// Shrinks an oversized PDF to fit a byte limit by dropping trailing pages, not by re-encoding
// image quality -- the real files this exists for (a multi-year stock plan document with a
// scanned prospectus appendix tacked on) are almost always "the part you actually need is the
// first few pages, the rest is boilerplate", so trimming pages is both simpler and safer than
// lossy recompression. Runs entirely client-side (pdf-lib, dynamically imported so it doesn't
// bloat the main bundle) so a user never has to manually pre-trim a file outside the app again.
export type PdfTrimResult = { file: File; originalPages: number; keptPages: number };

const MAX_ATTEMPTS = 6;

export async function trimPdfToFit(file: File, maxBytes: number): Promise<PdfTrimResult | null> {
  const { PDFDocument } = await import("pdf-lib");
  let src;
  try {
    src = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  } catch {
    return null; // not a real/parseable PDF -- let the caller fall back to its own error message
  }
  const totalPages = src.getPageCount();
  if (totalPages <= 1) return null; // nothing left to drop

  // First guess assumes roughly-uniform page weight (true for a scanned document, the case this
  // exists for) with a safety margin; subsequent attempts correct from the ACTUAL trimmed size
  // rather than re-guessing blindly, so this converges in a couple of tries even when page
  // weight varies.
  let keep = Math.max(1, Math.floor(totalPages * (maxBytes / file.size) * 0.85));
  for (let attempt = 0; attempt < MAX_ATTEMPTS && keep >= 1; attempt++) {
    const out = await PDFDocument.create();
    const indices = Array.from({ length: keep }, (_, i) => i);
    const pages = await out.copyPages(src, indices);
    for (const p of pages) out.addPage(p);
    const bytes = await out.save();
    if (bytes.byteLength <= maxBytes) {
      return {
        file: new File([bytes.slice()], file.name, { type: "application/pdf" }),
        originalPages: totalPages,
        keptPages: keep,
      };
    }
    if (keep === 1) break; // already at the minimum and still over -- give up
    keep = Math.max(1, Math.floor(keep * (maxBytes / bytes.byteLength) * 0.9));
  }
  return null; // even the first page alone doesn't fit -- not something trimming can fix
}
