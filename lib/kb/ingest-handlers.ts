import type { PageResult } from "@/backend/state";
import { screenshotPdf } from "@/lib/kb/screenshot";
import { extractPdfText } from "@/lib/kb/text";
import { getObject, uploadKbImage } from "@/lib/r2/client";
import type { IngestKind } from "@/lib/kb/source-kind";

// ponytail: per-source-type ingest strategy. Each handler turns R2
// bytes into the PageResult[] shape the rest of kbAgent consumes.
// The pdf handler keeps the existing mupdf render + extract pipeline
// intact; text + image handlers are pre-baked (markdown already known,
// or vision-OCR via pageToMarkdownNode).
//
// Adding a new kind = one entry in `handlers` + one mime match in
// getIngestHandler. The orchestrator (splitFileToPageNode) doesn't
// change.

export type { IngestKind } from "@/lib/kb/source-kind";

export interface IngestBuildArgs {
  r2Key: string;
  userId: string;
  docId: string;
  name: string;
  contentType: string;
}

export interface IngestHandler {
  buildPages(args: IngestBuildArgs): Promise<PageResult[]>;
}

// PDF: render each page to a PNG screenshot + extract the native text
// layer as reference text. pageToMarkdownNode OCRs each page later.
export const pdfHandler: IngestHandler = {
  async buildPages({ r2Key, userId, docId }) {
    const pdfBytes = await getObject(r2Key);
    const [rendered, extracted] = await Promise.all([
      screenshotPdf({ pdfBytes, dpi: 250 }),
      extractPdfText({ pdfBytes }),
    ]);
    const textByPage = Object.fromEntries(extracted.map((e) => [e.pageIndex, e.text]));
    return Promise.all(
      rendered.map(async (p) => {
        const key = `kb-tmp/${userId}/${docId}/page-${p.pageIndex}.png`;
        const imageUrl = await uploadKbImage({ key, body: p.png });
        return {
          pageIndex: p.pageIndex,
          imageUrl,
          markdown: "",
          referenceText: textByPage[p.pageIndex] ?? "",
          status: "pending" as const,
        };
      }),
    );
  },
};

// Markdown / plain text: bytes are already the source content. No
// OCR, no LLM call — splitter handles chunking. Single "page" carrying
// the full text.
export const textHandler: IngestHandler = {
  async buildPages({ r2Key }) {
    const bytes = await getObject(r2Key);
    const markdown = bytes.toString("utf-8");
    return [
      {
        pageIndex: 0,
        imageUrl: "",
        markdown,
        status: "success" as const,
      },
    ];
  },
};

// Image: upload as a KB-tmp PNG/JPEG, set imageUrl on a single page.
// pageToMarkdownNode's vision OCR runs over it.
export const imageHandler: IngestHandler = {
  async buildPages({ r2Key, userId, docId, contentType }) {
    const bytes = await getObject(r2Key);
    const ext = contentType.split("/")[1] ?? "png";
    const key = `kb-tmp/${userId}/${docId}/image.${ext}`;
    const imageUrl = await uploadKbImage({ key, body: bytes, contentType });
    return [
      {
        pageIndex: 0,
        imageUrl,
        markdown: "",
        status: "pending" as const,
      },
    ];
  },
};

const handlers: Record<IngestKind, IngestHandler> = {
  pdf: pdfHandler,
  markdown: textHandler,
  plain: textHandler,
  image: imageHandler,
};

export function getIngestHandler(mimeType: string): IngestHandler | null {
  const mt = mimeType.toLowerCase();
  if (mt === "application/pdf") return handlers.pdf;
  if (mt === "text/markdown") return handlers.markdown;
  if (mt === "text/plain") return handlers.plain;
  if (mt.startsWith("image/")) return handlers.image;
  return null;
}

// ponytail: re-export the front-end-safe helpers so callers can
// import the whole ingest surface from one place. The actual
// implementations live in source-kind.ts so the client bundle
// doesn't pull in mupdf / R2 / jina transitively.
export { getIngestKind, hasPageImages, hasReferenceText } from "@/lib/kb/source-kind";
