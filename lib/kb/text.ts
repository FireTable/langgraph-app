import * as mupdf from "mupdf";

/**
 * ponytail: mupdf-based native text extraction for the KB ingest pipeline.
 * Extracts the text layer from each PDF page in-memory (no disk writes).
 * Scanned / image-only PDFs return empty strings per page — callers treat
 * that as "no reference text available" and fall back to vision-only OCR.
 */

export type ExtractedBlock = {
  /** Joined text of all lines in the block, with newlines between lines. */
  text: string;
  /** Bbox in PDF points (72 dpi), in page coords: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
};

export type ExtractedPage = {
  pageIndex: number;
  /** Native text from the PDF text layer. Empty for scanned/image-only pages. */
  text: string;
  // ponytail: structured text blocks with bboxes. Used by the OCR prompt
  // to tell the LLM where each paragraph lives on the page so it can
  // correlate inline images with their captions / surrounding context.
  // Empty when the page has no text layer (scanned PDFs).
  blocks: ExtractedBlock[];
};

export type ExtractPdfTextOpts = {
  pdfBytes: Buffer;
};

/**
 * Extract the native text layer from each page of a PDF using mupdf.
 * Pages without a text layer (scanned PDFs, image-only pages) return an
 * empty string — callers should treat these as "no reference available".
 * No filesystem writes, pure in-memory.
 *
 * ponytail: `text` is the legacy plain-string field (preserved for
 * backward compatibility with callers that just want a quick text dump
 * or downstream consumers that join chunks by raw text). `blocks` is
 * the new structured form — block bbox + joined text — that the OCR
 * prompt consumes. Both come from the same `toStructuredText()` walk,
 * so callers pay the parsing cost once.
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
    const stext = page.toStructuredText("preserve-whitespace");
    const { text, blocks } = walkStructuredText(stext);
    pages.push({ pageIndex: i, text, blocks });
  }

  return pages;
}

// ponytail: walk mupdf's structured text tree. mupdf emits three
// block types — text blocks (`beginTextBlock`/`endTextBlock`), image
// blocks (`onImageBlock`), and vector shapes (`onVector`). We only
// keep text blocks for the OCR prompt; image blocks are captured
// separately by `extractPdfImages`. Lines join chars (with \n between
// lines), and the block's bbox is the union of its line bboxes.
export function walkStructuredText(stext: mupdf.StructuredText): {
  text: string;
  blocks: ExtractedBlock[];
} {
  const blocks: ExtractedBlock[] = [];
  let currentLines: Array<{ text: string; bbox: [number, number, number, number] }> = [];
  let currentBlockBbox: [number, number, number, number] | null = null;
  let currentLine: { chars: string[]; bbox: [number, number, number, number] } | null = null;

  const flushLine = () => {
    if (!currentLine) return;
    if (currentLine.chars.length > 0) {
      const text = currentLine.chars.join("");
      currentLines.push({ text, bbox: currentLine.bbox });
      currentBlockBbox ??= [Infinity, Infinity, -Infinity, -Infinity];
      expandBbox(currentLine.bbox, currentBlockBbox);
    }
    currentLine = null;
  };
  const flushBlock = () => {
    flushLine();
    if (currentLines.length === 0 || !currentBlockBbox) {
      currentLines = [];
      currentBlockBbox = null;
      return;
    }
    const text = currentLines.map((l) => l.text).join("\n");
    blocks.push({ text, bbox: currentBlockBbox });
    currentLines = [];
    currentBlockBbox = null;
  };

  stext.walk({
    beginTextBlock(_bbox: mupdf.Rect) {
      flushBlock();
    },
    endTextBlock() {
      flushBlock();
    },
    beginLine(bbox: mupdf.Rect, _wmode: number, _direction: mupdf.Point) {
      flushLine();
      currentLine = { chars: [], bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] };
    },
    endLine() {
      flushLine();
    },
    onChar(c: string) {
      if (!currentLine) return;
      currentLine.chars.push(c);
    },
    // ponytail: image blocks and vector shapes are ignored here —
    // extractPdfImages handles image positions; vectors aren't text.
    onImageBlock() {
      flushBlock();
    },
    onVector() {
      flushBlock();
    },
  });

  flushBlock();
  return {
    text: blocks
      .map((b) => b.text)
      .join("\n\n")
      .trim(),
    blocks,
  };
}

function expandBbox(
  child: [number, number, number, number],
  into: [number, number, number, number],
): void {
  into[0] = Math.min(into[0], child[0]);
  into[1] = Math.min(into[1], child[1]);
  into[2] = Math.max(into[2], child[2]);
  into[3] = Math.max(into[3], child[3]);
}
