import type { PageResult } from "@/backend/state";
import { screenshotPdf } from "@/lib/kb/screenshot";
import { extractPdfText } from "@/lib/kb/text";
import { getObject, uploadKbImage } from "@/lib/r2/client";
import { OfficeParser } from "officeparser";
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

// Office (DOCX/XLSX/PPTX): single officeparser handles all three.
// Returns a 1-page text result + one vision-OCR PageResult per image
// attachment. Charts are skipped — they're rare, and the markdown
// generator emits them via the same attachment pipeline that we're
// bypassing by setting `includeImages: false`.
// ponytail: ocr is OFF even though attachments get extracted. We don't
// run tesseract on DOCX/PPTX images because vision OCR downstream
// (pageToMarkdownNode) produces strictly better quality text for our
// Claude-based pipeline. Skipping officeparser's OCR also avoids the
// 30MB+ tesseract trained-data download on first use.
export const officeHandler: IngestHandler = {
  async buildPages({ r2Key, userId, docId }) {
    const bytes = await getObject(r2Key);
    const ast = await OfficeParser.parseOffice(bytes, {
      extractAttachments: true,
      ocr: false,
    });
    // ponytail: includeImages: false strips inline `data:` base64 from
    // the markdown body — images land on separate vision-OCR pages
    // below. generateIds: false skips officeparser's auto-slug
    // `{#test-docx-document}` block on headings (the chunking pipeline
    // doesn't read anchor IDs; they're noise that bloats the
    // chunkable text).
    const { value: markdown } = await ast.to("md", {
      includeImages: false,
      generateIds: false,
    });

    const pages: PageResult[] = [
      {
        pageIndex: 0,
        imageUrl: "",
        markdown: markdown ?? "",
        status: "success" as const,
      },
    ];

    // ponytail: only `image` attachments go through vision OCR; charts
    // get dropped (their structured chartData isn't surfaced in
    // markdown anyway, and we don't have a code path to use it).
    let pageIndex = 1;
    for (const att of ast.attachments) {
      if (att.type !== "image") continue;
      const buf = Buffer.from(att.data, "base64");
      const ext = att.extension || "png";
      const key = `kb-tmp/${userId}/${docId}/office-${pageIndex}.${ext}`;
      const imageUrl = await uploadKbImage({ key, body: buf, contentType: att.mimeType });
      pages.push({
        pageIndex,
        imageUrl,
        markdown: "",
        status: "pending" as const,
      });
      pageIndex++;
    }

    return pages;
  },
};

const handlers: Record<IngestKind, IngestHandler> = {
  pdf: pdfHandler,
  markdown: textHandler,
  plain: textHandler,
  image: imageHandler,
  docx: officeHandler,
  xlsx: officeHandler,
  pptx: officeHandler,
};

export function getIngestHandler(mimeType: string): IngestHandler | null {
  const mt = mimeType.toLowerCase();
  if (mt === "application/pdf") return handlers.pdf;
  if (mt === "text/markdown") return handlers.markdown;
  if (mt === "text/plain") return handlers.plain;
  if (mt.startsWith("image/")) return handlers.image;
  if (
    mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return handlers.docx; // any of the three — same handler
  }
  return null;
}

// ponytail: re-export the front-end-safe helpers so callers can
// import the whole ingest surface from one place. The actual
// implementations live in source-kind.ts so the client bundle
// doesn't pull in mupdf / R2 / jina transitively.
export { getIngestKind, hasPageImages, hasReferenceText } from "@/lib/kb/source-kind";
