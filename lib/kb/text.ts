import * as mupdf from "mupdf";

/**
 * ponytail: mupdf-based native text extraction for the KB ingest pipeline.
 * Extracts the text layer from each PDF page in-memory (no disk writes).
 * Scanned / image-only PDFs return empty strings per page — callers treat
 * that as "no reference text available" and fall back to vision-only OCR.
 */

export type ExtractedPage = {
  pageIndex: number;
  /** Native text from the PDF text layer. Empty for scanned/image-only pages. */
  text: string;
};

export type ExtractPdfTextOpts = {
  pdfBytes: Buffer;
};

/**
 * Extract the native text layer from each page of a PDF using mupdf.
 * Pages without a text layer (scanned PDFs, image-only pages) return an
 * empty string — callers should treat these as "no reference available".
 * No filesystem writes, pure in-memory.
 */
export async function extractPdfText(opts: ExtractPdfTextOpts): Promise<ExtractedPage[]> {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(opts.pdfBytes, "application/pdf");
  } catch (err) {
    throw new Error(`extractPdfText: not a valid PDF (${(err as Error).message})`);
  }

  const pageCount = doc.countPages();
  const pages: ExtractedPage[] = [];

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const text = page.toStructuredText("preserve-whitespace").asText().trim();
    pages.push({ pageIndex: i, text });
  }

  return pages;
}
