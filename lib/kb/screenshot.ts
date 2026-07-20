import * as mupdf from "mupdf";

/**
 * ponytail: v2 KB uses mupdf server-side to render each PDF page to a
 * PNG Buffer; the kbAgent uploads it to R2 (`kb-tmp/<userId>/<docId>/`)
 * and feeds the resulting URL to the OCR model. Returns Buffers only —
 * no filesystem writes, no tmpdir cleanup.
 */

export type ScreenshotPage = {
  pageIndex: number;
  png: Buffer;
};

export type ScreenshotPdfOpts = {
  pdfBytes: Buffer;
  dpi: number;
};

export async function screenshotPdf(opts: ScreenshotPdfOpts): Promise<ScreenshotPage[]> {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(opts.pdfBytes, "application/pdf");
  } catch (err) {
    throw new Error(`screenshotPdf: not a valid PDF (${(err as Error).message})`);
  }

  const pageCount = doc.countPages();
  const pages: ScreenshotPage[] = [];
  const scale = opts.dpi / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    pages.push({ pageIndex: i, png: Buffer.from(pix.asPNG()) });
  }

  return pages;
}
