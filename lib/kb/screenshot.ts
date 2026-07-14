import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as mupdf from "mupdf";

/**
 * ponytail: v1 KB uses mupdf server-side to render each PDF page to a
 * PNG, which the VLM step downstream consumes. The choice mirrors the
 * M1 sync-render attempt that was reverted — mupdf is a ~5MB wasm blob
 * with strong layout fidelity. V1 keeps the file-based output (image
 * path stored in the JSON record) so a future "view the page" affordance
 * is free; the v2 DB schema drops the path and stores the binary in
 * R2 alongside the source attachment.
 */

export type ScreenshotPage = {
  pageIndex: number;
  imagePath: string;
};

export type ScreenshotPdfOpts = {
  pdfBytes: Buffer;
  outputDir: string;
  dpi: number;
};

export async function screenshotPdf(opts: ScreenshotPdfOpts): Promise<ScreenshotPage[]> {
  // ponytail: mupdf's "magic" arg lets it auto-detect the format from
  // the bytes. PDF files start with "%PDF-" so detection is reliable
  // without an explicit magic arg, but we pass "application/pdf" for
  // belt-and-suspenders on edge cases (e.g. embedded PDFs without the
  // magic at offset 0).
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(opts.pdfBytes, "application/pdf");
  } catch (err) {
    throw new Error(`screenshotPdf: not a valid PDF (${(err as Error).message})`);
  }

  const pageCount = doc.countPages();
  const pages: ScreenshotPage[] = [];
  // ponytail: mupdf's Matrix is a value, not a class. Matrix.scale(sx, sy)
  // returns a transform matrix that multiplies x by sx and y by sy. We
  // want dpi/72 because PDF pages are 72-DPI by definition; 200 DPI
  // matches the M1 attempt — enough fidelity for VLM OCR without blowing
  // the per-image token budget.
  const scale = opts.dpi / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    const png = pix.asPNG();
    const imagePath = join(opts.outputDir, `page-${i}.png`);
    await writeFile(imagePath, png);
    pages.push({ pageIndex: i, imagePath });
  }

  return pages;
}
