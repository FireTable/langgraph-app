import type { PageResult } from "@/backend/state";
import { screenshotPdf } from "@/lib/kb/screenshot";
import { extractPdfText } from "@/lib/kb/text";
import { getObject, uploadKbImage } from "@/lib/r2/client";
import { OfficeParser } from "officeparser";
import { strFromU8, unzipSync } from "fflate";
import { getIngestKind, type IngestKind } from "@/lib/kb/source-kind";

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
// PPTX splits by `slide`, XLSX splits by `sheet` — each becomes its
// own PageResult so the Pages tab shows N entries (7 slides → 7
// pages, etc.). DOCX has no natural top-level page boundary (Word's
// pagination is dynamic — depends on paper size + margins + font,
// see CLAUDE conversation 2026-07-21), so DOCX stays a single page.
//
// Each page's markdown is generated from a sub-AST (root.content
// = [this page's node]). The MarkdownGenerator emits a leading
// `\n---\n\n` separator for slide/sheet/page types, which we strip
// so each page's markdown starts with the actual content.
//
// Image attachments get uploaded to R2 and referenced inline at
// their original AST position via `![](r2-url)`, so chunked markdown
// preserves "the chart followed this paragraph" context without
// forcing each image through pageToMarkdownNode vision OCR.
//
// ponytail: ocr is OFF even though attachments get extracted. We
// don't run tesseract because we don't OCR images through officeparser
// at all — images stay as inline `![](url)` references in the
// markdown. Skipping officeparser's OCR also avoids the 30MB+
// tesseract trained-data download on first use.
export const officeHandler: IngestHandler = {
  async buildPages({ r2Key, userId, docId, contentType }) {
    const bytes = await getObject(r2Key);
    const ast = await OfficeParser.parseOffice(bytes, {
      extractAttachments: true,
      ocr: false,
    });
    const kind = getIngestKind(contentType);
    const slices = paginateAst(ast, kind ?? "docx");

    // ponytail: index all eligible attachments once (filter by
    // vision-OK mime + minimum size so SVG/TIFF/BMP/empty/stub
    // attachments never reach R2 — they'd produce broken refs
    // or are just decoration). Built up front so the per-page
    // walker can do a Map.get instead of scanning ast.attachments
    // every time. Note: we intentionally keep `attachmentByName`
    // in this scope (not module scope) because it carries the
    // parsed bytes of the current upload.
    const attachmentByName = new Map<string, AstAttachmentShape>();
    for (const att of ast.attachments as unknown as AstAttachmentShape[]) {
      if (att.type !== "image") continue;
      if (!VISION_OK_MIME.has(att.mimeType.toLowerCase())) continue;
      const buf = Buffer.from(att.data ?? "", "base64");
      if (buf.length < MIN_ATTACHMENT_BYTES) continue;
      attachmentByName.set(att.name, att);
    }

    // ponytail: cross-page dedup — an image referenced by multiple
    // pages (e.g. logo reused across slides) is only PUT once.
    // Keyed by attachment name, which is stable across pages.
    // Holds `Promise<string>` so concurrent page walks pick up the
    // same in-flight upload instead of racing to PUT separately.
    const uploadedUrls = new Map<string, Promise<string>>();

    // ponytail: reverse lookup URL → attachment name. Populated by
    // both the AST walker (when it uploads a content image) and the
    // orphan pre-pass (when it uploads a layout image). The page
    // loop uses this to scan the rendered markdown's `![...](url)`
    // refs and find each content image's attachment name, which is
    // needed to position orphans in attachment-order.
    const urlToName = new Map<string, string>();

    // ponytail: attachment-order index. officeparser returns
    // `ast.attachments[]` in zip entry order (fflate unzipSync
    // preserves insertion order, the parser doesn't sort media).
    // For PPTX this is the order PowerPoint wrote the files —
    // typically back-to-front z-order. Stable across ingests, so
    // we can use it as a deterministic heuristic for where to
    // insert orphans relative to content images.
    const attachmentIndex = new Map<string, number>();
    for (let i = 0; i < (ast.attachments as unknown as AstAttachmentShape[]).length; i++) {
      attachmentIndex.set((ast.attachments as unknown as AstAttachmentShape[])[i].name, i);
    }

    // ponytail: layout-image backfill pass. officeparser 7.4.0 doesn't
    // walk `ppt/slideLayouts/*`, so images that live on a slide layout
    // (e.g. background art, decorative logo) end up in `ast.attachments[]`
    // but no AST image node references them. We unzip the PPTX/XLSX
    // ourselves, parse each slide's rels to find which layout it uses,
    // then parse that layout's rels to find images it references. For
    // each orphan image attachment, append `![](r2-url)` to the markdown
    // of every slide that inherits the layout. Cached: each layout's
    // rels is only parsed once even when N slides share it.
    const orphanByPage = await collectOrphanImagesByPage({
      bytes,
      ast,
      kind: kind ?? "docx",
      slicesCount: slices.length,
    });

    // Pre-upload orphans so the per-page loop only awaits URLs (no
    // extra R2 roundtrip in the page generator). Deduped across pages
    // — a logo referenced from every slide's shared layout is PUT once.
    for (const orphans of orphanByPage.values()) {
      for (const att of orphans) {
        if (uploadedUrls.has(att.name)) continue;
        const buf = Buffer.from(att.data, "base64");
        const ext = att.extension || "png";
        const baseName = att.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
          ? att.name.slice(0, -(ext.length + 1))
          : att.name;
        const key = `kb-tmp/${userId}/${docId}/${baseName}.${ext}`;
        // ponytail: register the in-flight Promise before awaiting so
        // concurrent pages reading the same orphan (shared layout) hit
        // the same upload instead of starting a second one. Attach a
        // .then to populate `urlToName` once the upload resolves —
        // the page loop can then scan the rendered markdown for
        // content image URLs and look up their attachment names.
        const p = uploadKbImage({ key, body: buf, contentType: att.mimeType }).then((url) => {
          urlToName.set(url, att.name);
          return url;
        });
        uploadedUrls.set(att.name, p);
      }
    }

    return Promise.all(
      slices.map(async ({ node, pageIndex }) => {
        // ponytail: build a sub-AST with only this page's content.
        // The MarkdownGenerator emits a leading `\n---\n\n` for
        // slide/sheet/page node types; we strip it after. For
        // single-page slices (docx / fallback), keep the full AST
        // so we don't have to special-case the wrapper.
        const subAst =
          node === null
            ? ast
            : ({ ...ast, content: [node] } as unknown as Awaited<
                ReturnType<typeof OfficeParser.parseOffice>
              >);
        // ponytail: walk this page's subtree and rewrite each
        // `image` node's metadata so the markdown generator
        // emits `![](r2-url)` instead of an inline base64 data URI.
        // The generator's URL-precedence rule
        // (`meta?.url || meta?.attachmentName`) means setting
        // `metadata.url` short-circuits the attachment lookup
        // entirely.
        await injectAttachmentUrls(
          subAst.content as unknown as AstNodeShape[],
          attachmentByName,
          uploadedUrls,
          urlToName,
          { userId, docId },
        );

        // ponytail: includeImages: true keeps the `![](...)` refs
        // the generator emits (R2 URLs after the walk above).
        // generateIds: false skips officeparser's auto-slug
        // `{#test-docx-document}` block on headings (the chunking
        // pipeline doesn't read anchor IDs).
        const { value: raw } = await subAst.to("md", {
          includeImages: true,
          generateIds: false,
        });
        // ponytail: strip two things officeparser emits that don't
        // belong on each page:
        //   1. The leading `\n---\n\n` separator for slide/sheet/
        //      page node types (we render our own "Page #N" header).
        //   2. The YAML frontmatter (`---\nkey: val\n...\n---\n\n`)
        //      that officeparser emits at the START of every
        //      `generate()` call. With one big AST it shows once;
        //      with per-page sub-ASTs it shows on every page and
        //      the Markdown tab ends up repeating core props N
        //      times. The user can read metadata from the dialog
        //      header (status, contentType, dates).
        let markdown = (raw ?? "")
          .replace(/^\n---\n\n?/, "")
          .replace(/^---\n(?:[^\n]*\n)+?---\n\n?/, "");

        // ponytail: position-based orphan insertion. For each orphan
        // on this page, find the first content image (in the
        // rendered markdown) whose `attachmentIndex` is greater
        // than the orphan's. Insert the orphan ref right before
        // that content image. If no content image has a higher
        // index, append at the end (the legacy fallback).
        // This relies on `attachmentIndex` being deterministic —
        // see the comment on its declaration.
        const pageOrphans = orphanByPage.get(pageIndex) ?? [];
        if (pageOrphans.length > 0) {
          const urls = await Promise.all(
            pageOrphans.map((att: AstAttachmentShape) => uploadedUrls.get(att.name)!),
          );
          const insertions = planOrphanInsertions(
            markdown,
            pageOrphans,
            urls,
            attachmentIndex,
            urlToName,
          );
          // ponytail: apply insertions in reverse markdown order so
          // earlier positions stay valid (inserting at offset N
          // doesn't shift offsets < N).
          for (let i = insertions.length - 1; i >= 0; i--) {
            const { position, text } = insertions[i];
            markdown = markdown.slice(0, position) + text + markdown.slice(position);
          }
        }

        return {
          pageIndex,
          imageUrl: "",
          markdown,
          status: "success" as const,
        };
      }),
    );
  },
};

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

type AstAttachmentShape = {
  type: string;
  name: string;
  data: string;
  mimeType: string;
  extension: string;
};

// ponytail: filter constants at module scope so tests can reference
// them without duplicating the allowlist.
const VISION_OK_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIN_ATTACHMENT_BYTES = 100;

// ponytail: split AST top-level nodes into per-page slices.
// PPTX splits by `slide`, XLSX by `sheet`. DOCX has no natural
// top-level page boundary (Word pagination is dynamic — see CLAUDE
// 2026-07-21), so DOCX falls through to a single "use the whole
// AST" slice. If a kind the caller expects to paginate has zero
// slide/sheet nodes (unexpected AST shape), also fall through so
// the doc still gets a single page rather than zero pages.
function paginateAst(
  ast: Awaited<ReturnType<typeof OfficeParser.parseOffice>>,
  kind: IngestKind,
): Array<{ node: AstNodeShape | null; pageIndex: number }> {
  const top = ast.content as unknown as AstNodeShape[];
  if (kind === "pptx") {
    const slides = top.filter((n) => n.type === "slide");
    if (slides.length > 0) {
      return slides.map((node, pageIndex) => ({ node, pageIndex }));
    }
  } else if (kind === "xlsx") {
    const sheets = top.filter((n) => n.type === "sheet");
    if (sheets.length > 0) {
      return sheets.map((node, pageIndex) => ({ node, pageIndex }));
    }
  }
  // docx, or fallback for unexpected AST shapes
  return [{ node: null, pageIndex: 0 }];
}

// ponytail: walks a page's sub-AST, finds image nodes, uploads
// referenced attachments to R2, and rewrites `metadata.url` so the
// markdown generator emits `![](r2-url)` instead of a base64 data
// URI. `attachmentByName` indexes all eligible attachments from
// `ast.attachments[]` (built once in `buildPages`); `uploadedUrls`
// is the per-name dedup cache — an image referenced by multiple
// pages (logos reused across slides) is only PUT once.
//
// ponytail: the cache holds `Promise<string>` not `string`, because
// pages run concurrently via Promise.all. A plain string cache would
// race: page 2's `get` returns undefined while page 1's upload is
// still in-flight, so page 2 fires its own PUT. With a Promise cache
// the SECOND `get` returns the same in-flight Promise — both pages
// `await` the same upload and the second one is free.
async function injectAttachmentUrls(
  nodes: AstNodeShape[],
  attachmentByName: Map<string, AstAttachmentShape>,
  uploadedUrls: Map<string, Promise<string>>,
  urlToName: Map<string, string>,
  ctx: { userId: string; docId: string },
): Promise<void> {
  for (const node of nodes) {
    await walkNode(node, attachmentByName, uploadedUrls, urlToName, ctx);
  }
}

async function walkNode(
  node: AstNodeShape,
  attachmentByName: Map<string, AstAttachmentShape>,
  uploadedUrls: Map<string, Promise<string>>,
  urlToName: Map<string, string>,
  ctx: { userId: string; docId: string },
): Promise<void> {
  if (node.type === "image" && node.metadata?.attachmentName && !node.metadata.url) {
    const name = node.metadata.attachmentName;
    let uploadPromise = uploadedUrls.get(name);
    if (!uploadPromise) {
      const att = attachmentByName.get(name);
      if (att) {
        const buf = Buffer.from(att.data, "base64");
        // ponytail: `att.name` often already includes an extension
        // ("image1.png"), so re-appending `att.extension` produces
        // "image1.png.png". Strip the trailing ext from the name
        // and re-attach the canonical one — or skip if identical.
        const ext = att.extension || "png";
        const baseName = att.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
          ? att.name.slice(0, -(ext.length + 1))
          : att.name;
        const key = `kb-tmp/${ctx.userId}/${ctx.docId}/${baseName}.${ext}`;
        // ponytail: set the Promise in the cache BEFORE awaiting
        // so concurrent pages pick up the same in-flight upload
        // (the awaited Promise resolves once for everyone). Populate
        // `urlToName` once the URL resolves so the page loop can
        // scan the rendered markdown for content image URLs and
        // reverse-lookup their attachment names.
        const p = uploadKbImage({ key, body: buf, contentType: att.mimeType });
        uploadPromise = p.then((url) => {
          urlToName.set(url, name);
          return url;
        });
        uploadedUrls.set(name, uploadPromise);
      }
    }
    if (uploadPromise) {
      // ponytail: rewrite in place — the generator's URL-precedence
      // rule (`meta?.url || meta?.attachmentName`) picks this up
      // and skips the data-URI fallback.
      node.metadata.url = await uploadPromise;
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      await walkNode(child as AstNodeShape, attachmentByName, uploadedUrls, urlToName, ctx);
    }
  }
}

// ponytail: decide where each orphan `![](url)` ref should land in
// the rendered page markdown. We scan the rendered markdown for
// content image `![alt](url)` refs, reverse-lookup each URL's
// attachment name, and pick the first content image whose
// `attachmentIndex` is greater than the orphan's. Insert the
// orphan right before that content image. If no such content
// image exists, the orphan appends at the end of the page.
//
// Returns a list of `{ position, text }` insertions, sorted by
// `position` ascending. The caller applies them in REVERSE order
// so each insertion's `position` stays valid against the
// not-yet-edited prefix of the markdown.
function planOrphanInsertions(
  markdown: string,
  orphans: AstAttachmentShape[],
  urls: string[],
  attachmentIndex: Map<string, number>,
  urlToName: Map<string, string>,
): Array<{ position: number; text: string }> {
  // ponytail: scan markdown for content image refs. Each ref is
  // `![alt](url)`; the URL lets us recover the attachment name via
  // `urlToName` (populated by the AST walker as it uploads each
  // content image). Content images whose URL isn't in `urlToName`
  // are skipped (defensive — should never happen since the walker
  // populates the map for every image it uploads).
  const contentRefs: Array<{ name: string; attachmentIndex: number; position: number }> = [];
  const re = /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const name = urlToName.get(m[1]);
    if (name === undefined) continue;
    contentRefs.push({
      name,
      attachmentIndex: attachmentIndex.get(name) ?? Number.POSITIVE_INFINITY,
      position: m.index,
    });
  }

  // ponytail: sort by markdown position so `find` returns the
  // first-by-position content image with a higher attachment index.
  contentRefs.sort((a, b) => a.position - b.position);

  const out: Array<{ position: number; text: string }> = [];
  for (let i = 0; i < orphans.length; i++) {
    const att = orphans[i];
    const url = urls[i];
    const alt = (att as { altText?: string }).altText ?? att.name;
    const orphanIndex = attachmentIndex.get(att.name) ?? Number.POSITIVE_INFINITY;
    const next = contentRefs.find((c) => c.attachmentIndex > orphanIndex);
    if (next) {
      // ponytail: orphan sits on its own paragraph BEFORE the next
      // content image. Need a leading AND trailing `\n\n` so the
      // orphan doesn't glue onto the previous line OR onto the
      // content image that follows. Trailing `\n\n` is critical —
      // without it, `...image1.png)![content]...` rendered as
      // one continuous line because the orphan's closing `)` is
      // adjacent to the content's opening `![`.
      out.push({ position: next.position, text: `\n\n![${alt}](${url})\n\n` });
    } else {
      // ponytail: no content image with a higher index — append
      // at the end of the page. Only need a leading `\n\n` since
      // the orphan is the last thing in the markdown.
      out.push({ position: markdown.length, text: `\n\n![${alt}](${url})` });
    }
  }
  out.sort((a, b) => a.position - b.position);
  return out;
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

// ponytail: walk the AST and collect every attachment name that's
// already referenced from an image node. Used by the orphan pass
// to find attachments the AST walker wouldn't have uploaded.
function collectAstReferencedImageNames(nodes: AstNodeShape[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.type === "image" && node.metadata?.attachmentName) {
      out.add(node.metadata.attachmentName);
    }
    if (Array.isArray(node.children)) {
      collectAstReferencedImageNames(node.children as AstNodeShape[], out);
    }
  }
}

// ponytail: image-references recovery pass. Two cases where
// officeparser's AST walker misses an image that's actually in the
// doc:
//   1. Image inside a group shape (`<p:grpSp>`). officeparser
//      walks the AST's tree but appears to skip nested
//      `<p:pic>` inside group shapes — the image ends up in
//      `ast.attachments[]` but no AST image node references it.
//   2. Image on a slide layout (`<p:slideLayout>` referenced via
//      slide→layout rels). officeparser 7.4.0 doesn't walk layout
//      files at all, so layout images are completely absent from
//      the AST tree.
// In both cases the image IS referenced from the PPTX zip's `.rels`
// files — either `ppt/slides/_rels/slideN.xml.rels` (case 1) or
// `ppt/slideLayouts/_rels/slideLayoutN.xml.rels` (case 2). We
// unzip the doc and parse the rels ourselves as the source of
// truth, then for each attachment NOT referenced from the AST,
// figure out which page(s) reference it via the rels chain and
// upload + append to those pages.
//
// ponytail: PPTX-only for now. XLSX sheets don't have a layout
// inheritance model (drawings are sheet-local), and DOCX has no
// "page" concept we paginate by. Returns an empty map for those
// kinds — the rest of the handler behaves as before.
async function collectOrphanImagesByPage({
  bytes,
  ast,
  kind,
  slicesCount,
}: {
  bytes: Buffer;
  ast: Awaited<ReturnType<typeof OfficeParser.parseOffice>>;
  kind: IngestKind;
  slicesCount: number;
}): Promise<Map<number, AstAttachmentShape[]>> {
  const result = new Map<number, AstAttachmentShape[]>();
  if (kind !== "pptx") return result;

  // ponytail: find AST-referenced attachment names so we can tell
  // which attachments are missed by the walker.
  const astReferenced = new Set<string>();
  collectAstReferencedImageNames(ast.content as unknown as AstNodeShape[], astReferenced);

  // ponytail: candidates = image attachments with vision-OK mime +
  // minimum size, NOT referenced from the AST. Same filter the
  // main upload path uses so we don't waste R2 on SVGs / stubs.
  const orphans = (ast.attachments as unknown as AstAttachmentShape[]).filter((att) => {
    if (att.type !== "image") return false;
    if (!VISION_OK_MIME.has(att.mimeType.toLowerCase())) return false;
    const buf = Buffer.from(att.data ?? "", "base64");
    if (buf.length < MIN_ATTACHMENT_BYTES) return false;
    return !astReferenced.has(att.name);
  });
  if (orphans.length === 0) return result;

  // ponytail: unzip once, parse slide rels to build the slide→images
  // map AND the slide→layout map. Layout rels are parsed on
  // demand and cached per layout file (N slides sharing a layout
  // only trigger one parse).
  const zip = unzipSync(new Uint8Array(bytes));
  const slideImages = new Map<number, Set<string>>(); // 0-indexed pageIndex → image names
  const slideToLayout = new Map<number, string>(); // 0-indexed pageIndex → layoutFile
  const layoutImages = new Map<string, Set<string>>(); // layoutFile → image names

  // ponytail: regex that matches an image Relationship's Target.
  // PPTX rels use two shapes:
  //   `<Relationship Id="rId1" Type=".../image" Target="../media/image1.png"/>`
  //   (attributes in any order, depending on writer)
  // and external rels have `TargetMode="External"` with `file://`
  // or http URLs — we skip those (Target doesn't start with
  // `../media/`). The `Type` may appear before or after `Target`
  // so we use two anchored checks instead of one combined regex.
  const reImageType = /Type="[^"]*\/image"\s+Target="(\.\.\/media\/([^"]+))"/g;
  const reTargetType = /Target="(\.\.\/media\/([^"]+))"\s+Type="[^"]*\/image"/g;

  for (let i = 1; i <= slicesCount; i++) {
    const slideRelsPath = `ppt/slides/_rels/slide${i}.xml.rels`;
    const slideRelsBuf = zip[slideRelsPath];
    if (!slideRelsBuf) continue;
    const slideRels = strFromU8(slideRelsBuf);

    // ponytail: collect image names referenced directly from this
    // slide's rels (case 1: group-shape images).
    const images = new Set<string>();
    let m: RegExpExecArray | null;
    reImageType.lastIndex = 0;
    while ((m = reImageType.exec(slideRels)) !== null) {
      images.add(m[2]);
    }
    reTargetType.lastIndex = 0;
    while ((m = reTargetType.exec(slideRels)) !== null) {
      images.add(m[2]);
    }
    slideImages.set(i - 1, images);

    // ponytail: also resolve which layout this slide uses, for
    // case 2 (layout-only images). Layouts are dedup'd via the
    // `layoutImages` cache so N slides sharing one layout only
    // parse its rels once.
    const layoutMatch = slideRels.match(/Target="([^"]*slideLayout\d+\.xml)"/);
    if (!layoutMatch) continue;
    const layoutFile = layoutMatch[1].split("/").pop()!;
    slideToLayout.set(i - 1, layoutFile);

    if (layoutImages.has(layoutFile)) continue;
    const layoutRelsPath = `ppt/slideLayouts/_rels/${layoutFile}.rels`;
    const layoutRelsBuf = zip[layoutRelsPath];
    const layoutSet = new Set<string>();
    if (layoutRelsBuf) {
      const layoutRels = strFromU8(layoutRelsBuf);
      reImageType.lastIndex = 0;
      while ((m = reImageType.exec(layoutRels)) !== null) {
        layoutSet.add(m[2]);
      }
      reTargetType.lastIndex = 0;
      while ((m = reTargetType.exec(layoutRels)) !== null) {
        layoutSet.add(m[2]);
      }
    }
    layoutImages.set(layoutFile, layoutSet);
  }

  // ponytail: for each orphan, find every page that references it
  // (slide's own image refs ∪ slide's layout's image refs). Build
  // a name→attachment lookup once for O(1) image→attachment
  // resolution.
  const orphanByName = new Map<string, AstAttachmentShape>();
  for (const att of orphans) orphanByName.set(att.name, att);

  for (let i = 0; i < slicesCount; i++) {
    const directImages = slideImages.get(i);
    const layoutFile = slideToLayout.get(i);
    const layoutSet = layoutFile ? layoutImages.get(layoutFile) : undefined;
    const pageOrphans: AstAttachmentShape[] = [];
    const seen = new Set<string>();
    const consider = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const att = orphanByName.get(name);
      if (att) pageOrphans.push(att);
    };
    if (directImages) for (const n of directImages) consider(n);
    if (layoutSet) for (const n of layoutSet) consider(n);
    if (pageOrphans.length > 0) result.set(i, pageOrphans);
  }

  return result;
}

// ponytail: re-export the front-end-safe helpers so callers can
// import the whole ingest surface from one place. The actual
// implementations live in source-kind.ts so the client bundle
// doesn't pull in mupdf / R2 / jina transitively.
export { getIngestKind, hasPageImages, hasReferenceText } from "@/lib/kb/source-kind";
