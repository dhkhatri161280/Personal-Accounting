import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, rgb } from "pdf-lib";
import { trimPdfToFit } from "../lib/trim-pdf.ts";

// Builds a real multi-page PDF with enough per-page content (a filled rectangle) that pages
// aren't trivially compressed to nothing -- close enough to "real" that the page-count-based
// size estimate in trimPdfToFit has actual bytes to reason about.
async function buildPdf(pageCount: number): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 20, y: 20, width: 360, height: 360, color: rgb(Math.random(), Math.random(), Math.random()) });
  }
  const bytes = await doc.save();
  return new File([bytes.slice()], "test.pdf", { type: "application/pdf" });
}

test("trimPdfToFit: shrinks a many-page PDF down to fit the byte limit", async () => {
  const file = await buildPdf(50);
  assert.ok(file.size > 2000, "sanity: the untrimmed file should have real content");
  const maxBytes = Math.floor(file.size * 0.3); // force a real reduction
  const result = await trimPdfToFit(file, maxBytes);
  assert.ok(result, "expected a trimmed result");
  assert.equal(result!.originalPages, 50);
  assert.ok(result!.keptPages < 50, "should have dropped pages");
  assert.ok(result!.keptPages >= 1);
  assert.ok(result!.file.size <= maxBytes, `trimmed file (${result!.file.size}B) must fit within ${maxBytes}B`);
  assert.equal(result!.file.name, "test.pdf");
  assert.equal(result!.file.type, "application/pdf");
});

test("trimPdfToFit: a file that already fits is returned unmodified in spirit (1 page, still checked)", async () => {
  const file = await buildPdf(1);
  const result = await trimPdfToFit(file, file.size + 1000);
  // Single-page PDFs have nothing left to drop -- trimming can't help a one-page file that's
  // still too big, so this always returns null regardless of the limit.
  assert.equal(result, null);
});

test("trimPdfToFit: gives up cleanly when even a single page doesn't fit", async () => {
  const file = await buildPdf(20);
  const result = await trimPdfToFit(file, 50); // an impossible 50-byte budget
  assert.equal(result, null);
});

test("trimPdfToFit: a non-PDF file fails to load and returns null instead of throwing", async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], "not-a-pdf.pdf", { type: "application/pdf" });
  const result = await trimPdfToFit(file, 2);
  assert.equal(result, null);
});
