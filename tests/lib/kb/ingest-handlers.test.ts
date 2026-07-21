import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
