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
  function fakeAst({
    value,
    attachments,
  }: {
    value: string;
    attachments: Array<{
      type: "image" | "chart";
      mimeType: string;
      data: string;
      name: string;
      extension: string;
    }>;
  }) {
    return {
      to: vi.fn().mockResolvedValue({ value }),
      attachments,
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

  it("uploads each image attachment as a separate vision-OCR page", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-pptx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "# Slide 1\n\nHello.",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from([0x89, 0x50]).toString("base64"),
            name: "img1.png",
            extension: "png",
          },
          {
            type: "image",
            mimeType: "image/jpeg",
            data: Buffer.from([0xff, 0xd8]).toString("base64"),
            name: "img2.jpg",
            extension: "jpg",
          },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      r2Key: "u/x/y.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    expect(pages).toHaveLength(3);
    // text page first, then one vision page per image attachment
    expect(pages[0]).toMatchObject({
      pageIndex: 0,
      status: "success",
      markdown: "# Slide 1\n\nHello.",
    });
    expect(pages[1]).toMatchObject({ pageIndex: 1, status: "pending", markdown: "" });
    expect(pages[1].imageUrl).toMatch(/^https:\/\/r2\/kb-tmp\/u-1\/d-1\/office-1\.png$/);
    expect(pages[2].imageUrl).toMatch(/^https:\/\/r2\/kb-tmp\/u-1\/d-1\/office-2\.jpg$/);
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(2);
  });

  it("skips chart attachments (no markdown representation to anchor them to)", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake-xlsx"));
    mocks.parseOffice.mockResolvedValue(
      fakeAst({
        value: "| A | B |\n|---|---|\n| 1 | 2 |",
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
            data: Buffer.from([0x89, 0x50]).toString("base64"),
            name: "img1.png",
            extension: "png",
          },
        ],
      }),
    );

    const pages = await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(pages).toHaveLength(2);
    expect(mocks.uploadKbImage).toHaveBeenCalledTimes(1); // chart skipped
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

  it("asks for markdown output with images stripped (avoids base64 in markdown text)", async () => {
    mocks.getObject.mockResolvedValue(Buffer.from("fake"));
    mocks.parseOffice.mockResolvedValue(fakeAst({ value: "md", attachments: [] }));

    await officeHandler.buildPages({
      ...ARGS,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const ast = await mocks.parseOffice.mock.results[0].value;
    expect(ast.to).toHaveBeenCalledWith(
      "md",
      expect.objectContaining({ includeImages: false, generateIds: false }),
    );
  });
});
