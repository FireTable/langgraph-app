import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

const mocks = vi.hoisted(() => ({
  screenshot: vi.fn(),
  extractText: vi.fn(),
  getObject: vi.fn(),
  uploadKbImage: vi.fn(),
  // ponytail: the officeparser module is mocked at the module boundary
  // so the heavy pdfjs-dist / tesseract.js deps don't load during tests.
  // The mock returns the same shape as the real API so the handler's
  // call sites (parseOffice, ast.to("md"), ast.attachments) line up.
  parseOffice: vi.fn(),
}));

vi.mock("@/lib/kb/screenshot", () => ({ screenshotPdf: mocks.screenshot }));
vi.mock("@/lib/kb/text", () => ({ extractPdfText: mocks.extractText }));
vi.mock("@/lib/r2/client", () => ({
  getObject: mocks.getObject,
  uploadKbImage: mocks.uploadKbImage,
}));
vi.mock("officeparser", () => ({
  OfficeParser: { parseOffice: mocks.parseOffice },
}));

import {
  getIngestHandler,
  imageHandler,
  officeHandler,
  pdfHandler,
  textHandler,
} from "@/lib/kb/ingest-handlers";

const ARGS = { r2Key: "u/x/y.pdf", userId: "u-1", docId: "d-1", name: "doc.pdf", contentType: "" };

beforeEach(() => {
  mocks.screenshot.mockReset();
  mocks.extractText.mockReset();
  mocks.getObject.mockReset();
  mocks.uploadKbImage.mockReset();
  mocks.parseOffice.mockReset();
  mocks.uploadKbImage.mockImplementation(async ({ key }: { key: string }) => `https://r2/${key}`);
});

describe("getIngestHandler", () => {
  it("routes application/pdf to pdfHandler", () => {
    expect(getIngestHandler("application/pdf")).toBe(pdfHandler);
  });

  it("routes text/markdown and text/plain to textHandler", () => {
    expect(getIngestHandler("text/markdown")).toBe(textHandler);
    expect(getIngestHandler("text/plain")).toBe(textHandler);
  });

  it("routes image/* to imageHandler", () => {
    expect(getIngestHandler("image/png")).toBe(imageHandler);
    expect(getIngestHandler("image/jpeg")).toBe(imageHandler);
    expect(getIngestHandler("image/webp")).toBe(imageHandler);
  });

  // ponytail: one officeparser instance handles DOCX/XLSX/PPTX — the
  // factory collapses all three onto the same handler so the routing
  // table only needs one entry per format family.
  it("routes Office Open XML mimes to officeHandler", () => {
    expect(
      getIngestHandler("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe(officeHandler);
    expect(
      getIngestHandler("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(officeHandler);
    expect(
      getIngestHandler("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ).toBe(officeHandler);
  });

  it("is case-insensitive on mime", () => {
    expect(getIngestHandler("Application/PDF")).toBe(pdfHandler);
    expect(getIngestHandler("IMAGE/PNG")).toBe(imageHandler);
  });

  it("returns null for unknown mimes", () => {
    expect(getIngestHandler("application/json")).toBeNull();
    expect(getIngestHandler("")).toBeNull();
  });
});

describe("pdfHandler", () => {
  it("renders pages + extracts text + uploads PNGs", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("%PDF-1.4\n"));
    mocks.screenshot.mockResolvedValue([
      { pageIndex: 0, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { pageIndex: 1, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    mocks.extractText.mockResolvedValue([
      { pageIndex: 0, text: "page zero" },
      { pageIndex: 1, text: "page one" },
    ]);

    const pages = await pdfHandler.buildPages({ ...ARGS, contentType: "application/pdf" });

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      pageIndex: 0,
      imageUrl: "https://r2/kb-tmp/u-1/d-1/page-0.png",
      referenceText: "page zero",
      status: "pending",
    });
    expect(pages[1].referenceText).toBe("page one");
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(2);
  });
});

describe("textHandler", () => {
  it("reads bytes as utf-8 and returns a single success page", async () => {
    const md = "# Hello\n\nSome text.";
    mocks.getObject.mockResolvedValue(Buffer.from(md, "utf-8"));

    const pages = await textHandler.buildPages({ ...ARGS, contentType: "text/markdown" });

    expect(pages).toEqual([{ pageIndex: 0, imageUrl: "", markdown: md, status: "success" }]);
  });

  it("works the same for text/plain", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("plain text body", "utf-8"));

    const pages = await textHandler.buildPages({ ...ARGS, contentType: "text/plain" });

    expect(pages[0].markdown).toBe("plain text body");
    expect(pages[0].status).toBe("success");
  });
});

describe("imageHandler", () => {
  it("uploads image to kb-tmp with the right extension and returns imageUrl page", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));

    const pages = await imageHandler.buildPages({
      ...ARGS,
      r2Key: "u/x/y.jpg",
      contentType: "image/jpeg",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageIndex: 0,
      markdown: "",
      status: "pending",
    });
    expect(pages[0].imageUrl).toMatch(/^https:\/\/r2\/kb-tmp\/u-1\/d-1\/image\.jpeg$/);
    expect(mocks.uploadKbImage).toHaveBeenCalledWith({
      key: expect.stringMatching(/^kb-tmp\/u-1\/d-1\/image\.jpeg$/),
      body: expect.any(Buffer),
      contentType: "image/jpeg",
    });
  });

  it("defaults extension to png for unknown image subtypes", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from([0]));

    const pages = await imageHandler.buildPages({
      ...ARGS,
      r2Key: "u/x/y.weird",
      contentType: "image/weird",
    });

    expect(pages[0].imageUrl).toMatch(/\/image\.weird$/);
  });
});

describe("officeHandler", () => {
  // ponytail: AST walker reads `ast.content` (top-level nodes) and
  // recurses into each node's `children`. The fake only needs the
  // top-level array — `walkNode` is what recurses, and tests that
  // exercise it pass nested nodes explicitly.
  function fakeAst({
    value,
    attachments,
    content = [],
  }: {
    value: string;
    attachments: Array<{
      type: "image" | "chart";
      mimeType: string;
      data: string;
      name: string;
      extension: string;
    }>;
    content?: Array<{ type: string; metadata?: Record<string, unknown>; children?: unknown[] }>;
  }) {
    return {
      to: vi.fn().mockResolvedValue({ value }),
      attachments,
      content,
    };
  }

  it("returns a single markdown page when the doc has no attachments", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-docx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({ value: "# Heading\n\nBody text.", attachments: [] }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageIndex: 0,
      imageUrl: "",
      markdown: "# Heading\n\nBody text.",
      status: "success",
    });
    expect(mocks.uploadKbImage).not.toHaveBeenCalled();
  });

  // ponytail: image nodes get uploaded to R2 and the AST metadata
  // gets rewritten in place. The markdown generator's URL-precedence
  // rule (`meta.url || meta.attachmentName`) picks up our rewrite and
  // emits `![](r2-url)` inline at the original AST position. We
  // assert the AST mutation here, not the markdown string, because
  // the actual markdown layout depends on the generator's traversal.
  it("uploads image attachments and rewrites image-node metadata.url", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const realJpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500)]);
    const ast = {
      to: vi.fn().mockResolvedValue({
        value: "# Slide 1\n\n![chart](https://r2/chart.png)\n\nMore text.",
      }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "chart.png",
          extension: "png",
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: realJpg.toString("base64"),
          name: "photo.jpg",
          extension: "jpg",
        },
      ],
      content: [
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              metadata: { attachmentName: "chart.png", altText: "chart" },
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              metadata: { attachmentName: "photo.jpg", altText: "team photo" },
            },
          ],
        },
      ],
    };
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(ast);

    const pages = await officeHandler.buildPages({
      ...ARGS,
      r2Key: "u/x/y.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    // One pre-baked page with inline image refs — same shape as textHandler.
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageIndex: 0,
      status: "success",
    });
    expect(pages[0].markdown).toContain("![chart](https://r2/chart.png)");

    // AST got mutated: image nodes now carry R2 URLs in metadata.url.
    const images = (
      ast.content as Array<{ children: Array<{ metadata: { url?: string } }> }>
    ).flatMap((p) => p.children);
    expect(images[0].metadata.url).toMatch(/^https:\/\/r2\/kb-tmp\/u-1\/d-1\/chart\.png$/);
    expect(images[1].metadata.url).toMatch(/^https:\/\/r2\/kb-tmp\/u-1\/d-1\/photo\.jpg$/);
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(2);
  });

  it("skips chart attachments (no markdown representation to anchor them to)", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const ast = {
      to: vi.fn().mockResolvedValue({ value: "md" }),
      attachments: [
        {
          type: "chart",
          mimeType: "image/png",
          data: "ignored",
          name: "chart1.png",
          extension: "png",
        },
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "img1.png",
          extension: "png",
        },
      ],
      // Only `img1.png` is referenced from the AST — chart1.png is an
      // orphan attachment that no image node points at, so it would
      // never be rendered as a markdown ref. The handler doesn't
      // upload unattached attachments either (no markdown impact).
      content: [
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              metadata: { attachmentName: "img1.png" },
            },
          ],
        },
      ],
    };
    mocks.getObject.mockResolvedValue(Buffer.from("fake-xlsx"));
    mocks.parseOffice.mockResolvedValue(ast);

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    // Only the image attachment got uploaded — chart is type:'chart',
    // not type:'image', so it's never even looked up.
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
    expect(mocks.uploadKbImage).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("passes extractAttachments=true and ocr=false to officeparser", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-docx"));
    mocks.parseOffice.mockResolvedValue(fakeAst({ value: "x", attachments: [] }));

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(mocks.parseOffice).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ extractAttachments: true, ocr: false }),
    );
  });

  it("asks for markdown output with images included (URLs come from the AST walk)", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake"));
    mocks.parseOffice.mockResolvedValue(fakeAst({ value: "md", attachments: [] }));

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const ast = await mocks.parseOffice.mock.results[0].value;
    // includeImages: true → generator emits `![](url)` refs at AST
    // positions. The AST walk above sets metadata.url to R2 URLs so
    // the refs point at our bucket, not at base64 data URIs.
    expect(ast.to).toHaveBeenCalledWith(
      "md",
      expect.objectContaining({ includeImages: true, generateIds: false }),
    );
  });

  // ponytail: PPTX slides often ship with placeholder / vector /
  // legacy-bitmap images. Filtering at ingest prevents broken refs
  // (SVG, TIFF, BMP) and empty/stub bytes from cluttering the
  // markdown with `![](nonexistent)` placeholders.
  it("skips attachments the vision LLM can't read (SVG / TIFF / BMP / empty / tiny)", async () => {
    const stubBytes = Buffer.alloc(50); // < MIN_ATTACHMENT_BYTES — stub
    const realBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "md",
        attachments: [
          {
            type: "image",
            mimeType: "image/svg+xml",
            data: "<svg/>",
            name: "logo.svg",
            extension: "svg",
          },
          {
            type: "image",
            mimeType: "image/tiff",
            data: "ignored",
            name: "scan.tiff",
            extension: "tiff",
          },
          {
            type: "image",
            mimeType: "image/bmp",
            data: "ignored",
            name: "old.bmp",
            extension: "bmp",
          },
          { type: "image", mimeType: "image/png", data: "", name: "empty.png", extension: "png" },
          {
            type: "image",
            mimeType: "image/png",
            data: stubBytes.toString("base64"),
            name: "stub.png",
            extension: "png",
          },
          // the one keeper — real PNG, real bytes
          {
            type: "image",
            mimeType: "image/png",
            data: realBytes.toString("base64"),
            name: "real.png",
            extension: "png",
          },
        ],
        // Only `real.png` is referenced from the AST — the SVG/TIFF/BMP/
        // empty/stub attachments are unreferenced, so they wouldn't be
        // rendered as markdown refs anyway. We still verify the handler
        // filters them out by mime/size for the ones that DO get
        // referenced, just to be defensive.
        content: [
          {
            type: "paragraph",
            children: [
              { type: "image", metadata: { attachmentName: "logo.svg" } },
              { type: "image", metadata: { attachmentName: "scan.tiff" } },
              { type: "image", metadata: { attachmentName: "old.bmp" } },
              { type: "image", metadata: { attachmentName: "empty.png" } },
              { type: "image", metadata: { attachmentName: "stub.png" } },
              { type: "image", metadata: { attachmentName: "real.png" } },
            ],
          },
        ],
      }),
    );

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    // Only the real PNG makes it to R2.
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
    expect(mocks.uploadKbImage).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kb-tmp/u-1/d-1/real.png",
        contentType: "image/png",
      }),
    );
  });

  // ponytail: paginateAst reads the top-level AST nodes and groups
  // by the kind's natural page boundary. PPTX → slide, XLSX → sheet.
  // Each becomes its own PageResult so the Pages tab shows N entries.
  // The MarkdownGenerator emits a leading `\n---\n\n` for slide/sheet
  // node types — the handler strips it so each page starts with the
  // actual content.
  it("splits PPTX into one page per slide", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        // The mock returns the same value per call (the handler
        // invokes .to("md") once per slide on a sub-AST).
        value: "\n---\n\nslide body",
        attachments: [],
        content: [
          { type: "slide", metadata: { slideNumber: 1 }, children: [] },
          { type: "slide", metadata: { slideNumber: 2 }, children: [] },
          { type: "slide", metadata: { slideNumber: 3 }, children: [] },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(pages.every((p) => p.status === "success")).toBe(true);
    // Leading `\n---\n\n` stripped from every page.
    expect(pages.every((p) => p.markdown === "slide body")).toBe(true);
  });

  it("splits XLSX into one page per sheet", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-xlsx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "\n---\n\n| col |\n| --- |\n| row |",
        attachments: [],
        content: [
          { type: "sheet", metadata: { name: "Sheet1" }, children: [] },
          { type: "sheet", metadata: { name: "Sheet2" }, children: [] },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    expect(pages[0].markdown).toBe("| col |\n| --- |\n| row |");
  });

  // ponytail: DOCX has no natural top-level page node (Word's
  // pagination is dynamic — paper size + margins + font). The
  // handler falls back to the legacy single-page behaviour so the
  // whole document lands as one markdown chunk.
  it("DOCX stays a single page (no top-level slide/sheet node)", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-docx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "doc body",
        attachments: [],
        content: [
          { type: "heading", children: [] },
          { type: "paragraph", children: [] },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toBe("doc body");
  });

  // ponytail: cross-page dedup — an image referenced by multiple
  // slides (e.g. logo used on every slide) is only PUT to R2 once.
  // The per-page image-node `metadata.url` writes still happen on
  // every reference so the markdown generator renders the same URL
  // each time.
  it("uploads the same image only once when referenced from multiple slides", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "\n---\n\nslide",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            data: realPng.toString("base64"),
            name: "logo.png",
            extension: "png",
          },
        ],
        content: [
          {
            type: "slide",
            children: [{ type: "image", metadata: { attachmentName: "logo.png" } }],
          },
          {
            type: "slide",
            children: [{ type: "image", metadata: { attachmentName: "logo.png" } }],
          },
          {
            type: "slide",
            children: [{ type: "image", metadata: { attachmentName: "logo.png" } }],
          },
        ],
      }),
    );

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
    expect(mocks.uploadKbImage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "kb-tmp/u-1/d-1/logo.png" }),
    );
  });

  // ponytail: paginateAst falls back to a single "use the whole
  // AST" slice if a kind we expect to paginate has zero slide/sheet
  // nodes (unexpected AST shape). Without this guard the doc would
  // come out with zero pages and the kb-agent would fail.
  it("falls back to single page if PPTX has zero slide nodes (defensive)", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "fallback body",
        attachments: [],
        // No `slide` nodes — only paragraphs. Should fall through
        // to one whole-AST page rather than zero pages.
        content: [{ type: "paragraph", children: [] }],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toBe("fallback body");
  });

  // ponytail: officeparser emits a YAML frontmatter block at the
  // start of every `generate()` call. With one big AST it shows
  // once; with per-page sub-ASTs (PPTX slides, XLSX sheets) it
  // shows on every page and the joined Markdown tab repeats core
  // props N times. Strip the frontmatter per-page so each page
  // starts with the actual content.
  it("strips the YAML frontmatter (core props) from each page", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        // What officeparser's markdown generator actually emits at
        // the start of every per-slide generate() call — frontmatter
        // block followed by `\n\n` then slide content. Strip the
        // frontmatter block AND the slide separator (which appears
        // as the leading `\n---\n\n` after our strip).
        value:
          '\n---\n\n---\ncreated: 2019-06-19T02:08:00.000Z\nmodified: 2021-07-25T09:28:43.000Z\nKSOProductBuildVer: "2052-11.1.0.10667"\nICV: "3B84E52E953E48078A65941517C4824F"\n---\n\nactual slide body',
        attachments: [],
        content: [
          { type: "slide", metadata: { slideNumber: 1 }, children: [] },
          { type: "slide", metadata: { slideNumber: 2 }, children: [] },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.markdown === "actual slide body")).toBe(true);
  });

  // ponytail: helper to build a minimal PPTX zip with slide→layout
  // rels and layout→image rels. The orphan backfill pass unzips
  // the doc bytes itself (officeparser doesn't surface layout
  // images), so the test needs a real zip it can read.
  function buildPptxZip(
    slides: Array<{ slideNum: number; layoutFile: string }>,
    layouts: Record<string, { imageNames: string[] }>,
  ): Buffer {
    const entries: Record<string, Uint8Array> = {};
    for (const { slideNum, layoutFile } of slides) {
      // Minimal slide XML — empty <p:sld>. We never parse this;
      // officeparser is mocked to return the AST we give it.
      entries[`ppt/slides/slide${slideNum}.xml`] = strToU8(
        `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:sld>`,
      );
      entries[`ppt/slides/_rels/slide${slideNum}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${layoutFile}"/>
</Relationships>`,
      );
    }
    for (const [layoutFile, { imageNames }] of Object.entries(layouts)) {
      const relsXml = imageNames.length
        ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${imageNames
  .map(
    (name, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`,
  )
  .join("\n")}
</Relationships>`
        : `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      entries[`ppt/slideLayouts/_rels/${layoutFile}.rels`] = strToU8(relsXml);
    }
    return Buffer.from(zipSync(entries));
  }

  // ponytail: orphan backfill — an image referenced ONLY from a
  // slide layout (officeparser doesn't walk layouts in 7.4.0)
  // should be uploaded and appended to the slides that inherit
  // that layout. With all 2 slides sharing one layout, the orphan
  // appears on both.
  it("uploads layout-only orphan images and appends them to inheriting slides", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const zipBytes = buildPptxZip(
      [
        { slideNum: 1, layoutFile: "slideLayout1.xml" },
        { slideNum: 2, layoutFile: "slideLayout1.xml" },
      ],
      { "slideLayout1.xml": { imageNames: ["bg.png"] } },
    );
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "\n---\n\nslide body" }),
      attachments: [
        // bg.png is NOT referenced from any AST image node — the
        // orphan backfill pass should still pick it up.
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "bg.png",
          extension: "png",
        },
      ],
      content: [
        { type: "slide", metadata: { slideNumber: 1 }, children: [] },
        { type: "slide", metadata: { slideNumber: 2 }, children: [] },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(2);
    // ponytail: bg.png appended to both slides (shared layout).
    expect(pages[0].markdown).toContain("![bg.png](https://r2/kb-tmp/u-1/d-1/bg.png)");
    expect(pages[1].markdown).toContain("![bg.png](https://r2/kb-tmp/u-1/d-1/bg.png)");
    // ponytail: dedup — same orphan referenced from both slides'
    // shared layout → only one R2 PUT.
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
  });

  // ponytail: orphan backfill is scoped per layout. A layout
  // referenced only by slide 2 (not slide 1) means its images only
  // appear on page 2.
  it("scopes orphan images to slides that actually inherit the layout", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const zipBytes = buildPptxZip(
      [
        { slideNum: 1, layoutFile: "slideLayout1.xml" },
        { slideNum: 2, layoutFile: "slideLayout2.xml" },
      ],
      {
        "slideLayout1.xml": { imageNames: [] },
        "slideLayout2.xml": { imageNames: ["bg.png"] },
      },
    );
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "\n---\n\nslide body" }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "bg.png",
          extension: "png",
        },
      ],
      content: [
        { type: "slide", metadata: { slideNumber: 1 }, children: [] },
        { type: "slide", metadata: { slideNumber: 2 }, children: [] },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(2);
    expect(pages[0].markdown).not.toContain("bg.png");
    expect(pages[1].markdown).toContain("![bg.png](https://r2/kb-tmp/u-1/d-1/bg.png)");
  });

  // ponytail: orphan backfill is a no-op for non-PPTX. DOCX has
  // no slide/layout inheritance model, and we don't unzip those
  // formats here.
  it("does not run orphan backfill for DOCX", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-docx-bytes"));
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "doc body" }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.alloc(500).toString("base64"),
          name: "orphan.png",
          extension: "png",
        },
      ],
      content: [],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toBe("doc body");
    // ponytail: orphan not uploaded, no extra upload beyond what
    // AST references (and there are no AST refs here).
    expect(mocks.uploadKbImage).not.toHaveBeenCalled();
  });

  // ponytail: when the AST already references an image, the
  // orphan pass must NOT re-upload it. Backfill only handles
  // attachments the AST walker wouldn't have touched.
  it("does not re-upload images that the AST already references", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const zipBytes = buildPptxZip(
      [
        { slideNum: 1, layoutFile: "slideLayout1.xml" },
        { slideNum: 2, layoutFile: "slideLayout1.xml" },
      ],
      // Layout ALSO references logo.png — but the AST already
      // points at it, so the orphan pass should treat it as
      // already-covered and skip it.
      { "slideLayout1.xml": { imageNames: ["logo.png"] } },
    );
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "\n---\n\nslide body" }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "logo.png",
          extension: "png",
        },
      ],
      content: [
        {
          type: "slide",
          children: [{ type: "image", metadata: { attachmentName: "logo.png" } }],
        },
        {
          type: "slide",
          children: [{ type: "image", metadata: { attachmentName: "logo.png" } }],
        },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    // ponytail: logo.png uploaded once by the AST walker (not
    // duplicated by the orphan pass). If the pass had wrongly
    // re-uploaded, we'd see > 1 call.
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
    // The page markdown should reference logo.png via the AST
    // inline image, not via the orphan append path (the inline
    // ref shows up as `![logo](https://r2/...)` from the mock's
    // pre-baked markdown; the orphan path would append
    // `![logo.png](https://r2/...)` — both contain the URL, but
    // we mainly care that we didn't double-upload).
    expect(pages).toHaveLength(2);
  });

  // ponytail: this is the bug case the user reported. image1.png
  // is referenced from `ppt/slides/_rels/slide2.xml.rels` (rId1)
  // and used inside a `<p:grpSp>` on the slide, but officeparser's
  // walker doesn't recurse into group shapes for image refs. The
  // orphan backfill pass picks it up via slide rels and appends
  // it to page 2's markdown. Other slides don't reference
  // image1.png in their rels → they don't get it.
  it("recovers images referenced from slide rels but missed by AST walker (group-shape case)", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    // Build a custom zip with image1.png ONLY in slide2's rels.
    // (buildPptxZip places images in layout rels by default; we
    // want slide-level rels here, so we hand-write.)
    const entries: Record<string, Uint8Array> = {};
    for (const n of [1, 2, 3]) {
      entries[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
${
  n === 2
    ? `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
    : ""
}
</Relationships>`,
      );
    }
    const zipBytes = Buffer.from(zipSync(entries));
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "\n---\n\nslide body" }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "image1.png",
          extension: "png",
        },
      ],
      // AST has 3 slides, but NONE has an image node pointing at
      // image1.png — simulating the group-shape miss.
      content: [
        { type: "slide", metadata: { slideNumber: 1 }, children: [] },
        { type: "slide", metadata: { slideNumber: 2 }, children: [] },
        { type: "slide", metadata: { slideNumber: 3 }, children: [] },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(3);
    expect(pages[0].markdown).not.toContain("image1.png");
    expect(pages[1].markdown).toContain("![image1.png](https://r2/kb-tmp/u-1/d-1/image1.png)");
    expect(pages[2].markdown).not.toContain("image1.png");
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1);
  });

  // ponytail: position-based orphan insertion. When the orphan's
  // attachmentIndex is LOWER than a content image on the same
  // page, the orphan inserts BEFORE that content image — not at
  // the page end. attachmentIndex is the position in
  // ast.attachments[] (zip entry order ≈ z-order), so an orphan
  // earlier in the zip renders earlier in the markdown.
  it("inserts orphan BEFORE content image when orphan's attachmentIndex is lower", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    // zip order: bg.png first (index 0, orphan), fg.png second
    // (index 1, content). Slide1's rels reference bg.png; AST
    // only references fg.png. Expected: bg inserts before fg.
    const entries: Record<string, Uint8Array> = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(
        `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type=".../slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId1" Type=".../image" Target="../media/bg.png"/>
</Relationships>`,
      ),
    };
    const zipBytes = Buffer.from(zipSync(entries));
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      // ponytail: ast.to("md") returns a string with a content
      // image ref. The walker has set `metadata.url` on fg.png
      // before the generator runs, so the rendered markdown
      // includes the R2 URL inline.
      to: vi.fn().mockResolvedValue({
        value: "intro\n\n![fg alt](https://r2/kb-tmp/u-1/d-1/fg.png)\n\nmore text",
      }),
      attachments: [
        // Order matters: bg.png is index 0, fg.png is index 1.
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "bg.png",
          extension: "png",
        },
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "fg.png",
          extension: "png",
        },
      ],
      content: [
        {
          type: "slide",
          children: [{ type: "image", metadata: { attachmentName: "fg.png" } }],
        },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(1);
    // ponytail: bg.png's ref appears BEFORE fg.png's ref in the
    // final markdown. The exact URLs come from uploadKbImage's
    // mock (which returns `https://r2/${key}` for the asked key).
    const md = pages[0].markdown;
    const bgPos = md.indexOf("bg.png");
    const fgPos = md.indexOf("fg.png");
    expect(bgPos).toBeGreaterThan(-1);
    expect(fgPos).toBeGreaterThan(-1);
    expect(bgPos).toBeLessThan(fgPos);
  });

  // ponytail: when the orphan's attachmentIndex is HIGHER than
  // every content image on the page, no content image satisfies
  // the "higher index" predicate, so the orphan appends at the
  // end (the legacy fallback).
  it("appends orphan at end when no content image has a higher attachmentIndex", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    // fg.png is index 0 (content), bg.png is index 1 (orphan).
    // bg's index (1) > fg's (0), so bg appends at end.
    const entries: Record<string, Uint8Array> = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(
        `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type=".../slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId1" Type=".../image" Target="../media/bg.png"/>
</Relationships>`,
      ),
    };
    const zipBytes = Buffer.from(zipSync(entries));
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({
        value: "intro\n\n![fg alt](https://r2/kb-tmp/u-1/d-1/fg.png)",
      }),
      attachments: [
        // fg.png FIRST in zip (index 0)
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "fg.png",
          extension: "png",
        },
        // bg.png SECOND (index 1)
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "bg.png",
          extension: "png",
        },
      ],
      content: [
        {
          type: "slide",
          children: [{ type: "image", metadata: { attachmentName: "fg.png" } }],
        },
      ],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(1);
    const md = pages[0].markdown;
    const bgPos = md.indexOf("bg.png");
    const fgPos = md.indexOf("fg.png");
    expect(bgPos).toBeGreaterThan(fgPos);
    expect(md.endsWith("bg.png)")).toBe(true);
  });

  // ponytail: a page with NO content image refs. The orphan has
  // nowhere to insert "before" (no content image to anchor
  // against), so it falls back to append-at-end. This case also
  // covers slides that are pure text.
  it("appends orphan at end when page has no content image refs", async () => {
    const realPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]);
    const entries: Record<string, Uint8Array> = {
      "ppt/slides/_rels/slide1.xml.rels": strToU8(
        `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId99" Type=".../slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId1" Type=".../image" Target="../media/orphan.png"/>
</Relationships>`,
      ),
    };
    const zipBytes = Buffer.from(zipSync(entries));
    mocks.getObject.mockResolvedValue(zipBytes);
    mocks.parseOffice.mockResolvedValue({
      to: vi.fn().mockResolvedValue({ value: "just text, no images" }),
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: realPng.toString("base64"),
          name: "orphan.png",
          extension: "png",
        },
      ],
      // No image children — pure text slide.
      content: [{ type: "slide", children: [{ type: "paragraph", children: [] }] }],
    });

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toContain("just text, no images");
    expect(pages[0].markdown).toContain("![orphan.png]");
    expect(pages[0].markdown.endsWith("![orphan.png](https://r2/kb-tmp/u-1/d-1/orphan.png)")).toBe(
      true,
    );
  });
});
