import * as mupdf from "mupdf";

/**
 * ponytail: PDF image extraction for the KB ingest pipeline. Walks
 * each page's content stream via a custom mupdf Device, capturing
 * every embedded raster image with its placement bbox (in PDF points,
 * 72 dpi). Callers upload each PNG to R2 and surface the URLs in the
 * OCR prompt so the vision LLM can reference real images instead of
 * hallucinating URLs.
 *
 * Unlike the Office path (which recovers orphan images via rels
 * self-extraction), PDFs need a Device walk because every embedded
 * image is referenced from the page's content stream — there's no
 * "page-level rels" equivalent to a slide layout.
 *
 * Per-page-instance extraction: same logo embedded 5x across pages
 * produces 5 separate R2 objects (one per page position). Cross-page
 * dedup is a future optimization if storage costs matter.
 */

export type ExtractedPdfImage = {
  pageIndex: number;
  /** Stable name per page-instance, e.g. "img-p3-2". */
  name: string;
  /** PNG bytes, ready to upload to R2. */
  png: Buffer;
  /** Bbox in PDF points (72 dpi), in page coords: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Native pixel dimensions of the embedded image (pre-transform). */
  width: number;
  height: number;
};

export type ExtractPdfImagesOpts = {
  pdfBytes: Buffer;
};

export async function extractPdfImages(opts: ExtractPdfImagesOpts): Promise<ExtractedPdfImage[]> {
  const doc = mupdf.Document.openDocument(opts.pdfBytes, "application/pdf");
  const out: ExtractedPdfImage[] = [];
  const pageCount = doc.countPages();

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    let idx = 0;
    // ponytail: capture into closure — mupdf's Device walks the page's
    // content stream and invokes fillImage() for every embedded raster
    // image, passing the placement transform (ctm) and the Image handle.
    // We extract the bbox from the ctm + the image's native dims, then
    // export the image to PNG via Image.toPixmap().asPNG().
    const device = new mupdf.Device({
      fillImage(image: mupdf.Image, ctm: mupdf.Matrix) {
        const width = image.getWidth();
        const height = image.getHeight();
        const bbox = ctmToBbox(ctm, width, height);
        const png = Buffer.from(image.toPixmap().asPNG());
        out.push({
          pageIndex: i,
          name: `img-p${i}-${idx}`,
          png,
          bbox,
          width,
          height,
        });
        idx++;
      },
    });
    // ponytail: identity matrix — we want bbox in page coords (PDF
    // points), not in screen coords. The OCR prompt passes the raw
    // page-point coordinates to the LLM as relative position hints.
    page.run(device, mupdf.Matrix.identity);
  }

  return out;
}

// ponytail: convert a PDF transform matrix to the axis-aligned bbox
// of the (0,0)–(w,h) image rect after transform. PDF ctm is the
// 6-element affine [a b c d e f]; we transform all 4 corners and
// take min/max. Handles rotations + reflections correctly because
// we don't assume axis alignment.
function ctmToBbox(
  ctm: mupdf.Matrix,
  width: number,
  height: number,
): [number, number, number, number] {
  const [a, b, c, d, e, f] = ctm;
  // ponytail: 2×3 CTM matrix multiplied by (0,0), (w,0), (w,h), (0,h)
  // to find the transformed bbox corners. oxlint flags `m * 0` as an
  // erasing op but the form is intentional — matrix math reads cleaner
  // than the equivalent `e`, `c * height + e`, etc.
  const corners: Array<[number, number]> = [
    // oxlint-disable-next-line erasing-op -- intentional matrix transform
    [a * 0 + c * 0 + e, b * 0 + d * 0 + f],
    // oxlint-disable-next-line erasing-op -- intentional matrix transform
    [a * width + c * 0 + e, b * width + d * 0 + f],
    // oxlint-disable-next-line erasing-op -- intentional matrix transform
    [a * width + c * height + e, b * width + d * height + f],
    // oxlint-disable-next-line erasing-op -- intentional matrix transform
    [a * 0 + c * height + e, b * 0 + d * height + f],
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
