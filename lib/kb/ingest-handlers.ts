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
// Returns a single pre-baked markdown page (same shape as
// textHandler / URL flow). Image attachments get uploaded to R2 and
// referenced inline at their original AST position via
// `![](r2-url)`, so chunked markdown preserves "the chart followed
// this paragraph" context without forcing each image through
// pageToMarkdownNode vision OCR.
//
// ponytail: ocr is OFF even though attachments get extracted. We
// don't run tesseract because we don't OCR images through officeparser
// at all — images stay as inline `![](url)` references in the
// markdown. Skipping officeparser's OCR also avoids the 30MB+
// tesseract trained-data download on first use.
export const officeHandler: IngestHandler = {
  async buildPages({ r2Key, userId, docId }) {
    const bytes = await getObject(r2Key);
    const ast = await OfficeParser.parseOffice(bytes, {
      extractAttachments: true,
      ocr: false,
    });
    // ponytail: walk the AST and rewrite each `image` node's metadata
    // so the markdown generator emits `![](r2-url)` instead of an
    // inline base64 data URI. The generator's URL-precedence rule
    // (`meta?.url || meta?.attachmentName`) means setting
    // `metadata.url` short-circuits the attachment lookup entirely.
    //
    // Filter aggressively: SVG/TIFF/BMP/empty/stub images produce
    // broken refs or are just decoration.
    await injectAttachmentUrls(ast, { userId, docId });

    // ponytail: includeImages: true keeps the `![](...)` refs the
    // generator emits (R2 URLs after the walk above). generateIds:
    // false skips officeparser's auto-slug `{#test-docx-document}`
    // block on headings (the chunking pipeline doesn't read anchor
    // IDs).
    const { value: markdown } = await ast.to("md", {
      includeImages: true,
      generateIds: false,
    });

    return [
      {
        pageIndex: 0,
        imageUrl: "",
        markdown: markdown ?? "",
        status: "success" as const,
      },
    ];
  },
};

// ponytail: filter constants at module scope so tests can reference
// them without duplicating the allowlist.
const VISION_OK_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIN_ATTACHMENT_BYTES = 100;

async function injectAttachmentUrls(
  ast: Awaited<ReturnType<typeof OfficeParser.parseOffice>>,
  ctx: { userId: string; docId: string },
): Promise<void> {
  // ponytail: build an attachment lookup once, then walk the AST.
  // Indexing by `name` matches the generator's lookup pattern.
  const attachmentByName = new Map<string, (typeof ast.attachments)[number]>();
  for (const att of ast.attachments) {
    if (att.type !== "image") continue;
    if (!VISION_OK_MIME.has(att.mimeType.toLowerCase())) continue;
    const buf = Buffer.from(att.data ?? "", "base64");
    if (buf.length < MIN_ATTACHMENT_BYTES) continue;
    attachmentByName.set(att.name, att);
  }
  if (attachmentByName.size === 0) return;

  for (const node of ast.content) {
    await walkNode(node as AstNodeShape, attachmentByName, ctx);
  }
}

// ponytail: deliberately typed as a duck-typed shape rather than the
// discriminated `OfficeContentNode` union — TypeScript can't narrow
// `metadata` from `SlideMetadata | HeadingMetadata | ... | undefined`
// down to `{ attachmentName?, url? }` at the call site without an
// assertion at every step. The walker only ever reads
// `node.type === "image"` and `node.metadata.{attachmentName,url}`,
// so the duck-typed shape captures what we touch.
type AstNodeShape = {
  type?: string;
  metadata?: { attachmentName?: string; url?: string };
  children?: unknown[];
};

async function walkNode(
  node: AstNodeShape,
  attachmentByName: Map<
    string,
    { data: string; mimeType: string; extension: string; name: string }
  >,
  ctx: { userId: string; docId: string },
): Promise<void> {
  if (node.type === "image" && node.metadata?.attachmentName && !node.metadata.url) {
    const att = attachmentByName.get(node.metadata.attachmentName);
    if (att) {
      const buf = Buffer.from(att.data, "base64");
      // ponytail: `att.name` often already includes an extension
      // ("image1.png"), so re-appending `att.extension` produces
      // "image1.png.png". Strip the trailing ext from the name and
      // re-attach the canonical one — or skip if they're identical.
      const ext = att.extension || "png";
      const baseName = att.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
        ? att.name.slice(0, -(ext.length + 1))
        : att.name;
      const key = `kb-tmp/${ctx.userId}/${ctx.docId}/${baseName}.${ext}`;
      const url = await uploadKbImage({ key, body: buf, contentType: att.mimeType });
      // ponytail: rewrite in place — the generator's URL-precedence
      // rule (`meta?.url || meta?.attachmentName`) picks this up
      // and skips the data-URI fallback.
      node.metadata.url = url;
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      await walkNode(child as AstNodeShape, attachmentByName, ctx);
    }
  }
}

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
