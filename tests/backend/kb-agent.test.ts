import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

// ponytail: mock everything kb-agent.ts touches at the IO boundary —
// models, screenshot, R2 helpers, attachment lookup, DB queries. The
// SUT compiles the graph at module load; tests just invoke it with
// stubbed state and assert the merged state on return.

const mocks = vi.hoisted(() => {
  const chatInvoke = vi.fn();
  const chatWithStructured = vi.fn(() => ({ invoke: chatInvoke }));
  const chatInstance = { withStructuredOutput: chatWithStructured };
  const chatFactory = vi.fn(async () => chatInstance);

  const embedderInvoke = vi.fn();
  const embedderFactory = vi.fn(async () => ({ embedDocuments: embedderInvoke }));

  const ocrStructuredInvoke = vi.fn();
  const ocrFactory = vi.fn(async () => ({
    withStructuredOutput: () => ({ invoke: ocrStructuredInvoke }),
  }));

  const screenshot = vi.fn();
  const getAttachment = vi.fn();
  const r2KeyFromPublic = vi.fn();
  const uploadKbImage = vi.fn();
  const getR2PublicBase = vi.fn();
  const getObject = vi.fn();

  const ensureFolder = vi.fn();
  const findByHash = vi.fn();
  const findByAtt = vi.fn();
  const insertDoc = vi.fn();
  const insertChunks = vi.fn();
  const withTx = vi.fn();
  const invalidate = vi.fn();

  return {
    chatInvoke,
    chatWithStructured,
    chatInstance,
    chatFactory,
    embedderInvoke,
    embedderFactory,
    ocrStructuredInvoke,
    ocrFactory,
    screenshot,
    getAttachment,
    r2KeyFromPublic,
    uploadKbImage,
    getR2PublicBase,
    getObject,
    ensureFolder,
    findByHash,
    findByAtt,
    insertDoc,
    insertChunks,
    withTx,
    invalidate,
  };
});

vi.mock("@/backend/model", () => ({
  getChatModel: mocks.chatFactory,
  getEmbeddingModel: mocks.embedderFactory,
  getOcrModel: mocks.ocrFactory,
}));
vi.mock("@/lib/kb/screenshot", () => ({ screenshotPdf: mocks.screenshot }));
vi.mock("@/lib/attachments/queries", () => ({ findAttachmentByR2Key: mocks.getAttachment }));
vi.mock("@/lib/r2/client", () => ({
  r2KeyFromPublicUrl: mocks.r2KeyFromPublic,
  uploadKbImage: mocks.uploadKbImage,
  getR2PublicBaseUrl: mocks.getR2PublicBase,
  getObject: mocks.getObject,
}));
vi.mock("@/lib/kb/queries", () => ({
  ensureDefaultKbFolder: mocks.ensureFolder,
  findKbDocumentByContentHash: mocks.findByHash,
  findKbDocumentByAttachmentId: mocks.findByAtt,
  insertKbDocument: mocks.insertDoc,
  insertKbChunks: mocks.insertChunks,
  withKbTx: mocks.withTx,
}));
vi.mock("@/lib/kb/cache", () => ({ invalidateKbDoc: mocks.invalidate }));

import { kbAgent } from "@/backend/agent/kb-agent";

const USER = "u-1";
const FOLDER_ID = "f-1";
const BASE_URL = "https://r2.example.com";

function urlFor(slug: string) {
  return `${BASE_URL}/u/${USER}/${slug}.pdf`;
}

function attachmentFor(url: string) {
  const r2Key = url.replace(`${BASE_URL}/`, "");
  return {
    id: `att-${r2Key}`,
    userId: USER,
    r2Key,
    name: `${r2Key.split("/").pop() ?? "doc"}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1024,
    status: "uploaded" as const,
    sha256: `sha-${r2Key}`,
    createdAt: new Date(),
    confirmedAt: new Date(),
  };
}

function pdfFilePart(url: string, mime_type = "application/pdf") {
  return { type: "file" as const, data: url, mime_type };
}

function humanWithOnePdf(slug = "alpha") {
  const url = urlFor(slug);
  return new HumanMessage({
    content: [{ type: "text", text: "look at this pdf" }, pdfFilePart(url)] as never,
    id: `m-${slug}`,
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  });

  mocks.getR2PublicBase.mockReturnValue(BASE_URL);
  mocks.r2KeyFromPublic.mockImplementation((url: string) => url.replace(`${BASE_URL}/`, ""));
  mocks.getAttachment.mockImplementation(async (_userId: string, r2Key: string) =>
    attachmentFor(`${BASE_URL}/${r2Key}`),
  );
  mocks.findByHash.mockResolvedValue(null);
  mocks.findByAtt.mockResolvedValue(null);
  mocks.ensureFolder.mockResolvedValue({ id: FOLDER_ID, userId: USER, name: "Attachments" });
  mocks.insertDoc.mockImplementation(
    async (row: { id: string; userId: string; title?: string; attachmentId: string }) => ({
      id: row.id,
      userId: row.userId,
      folderId: FOLDER_ID,
      attachmentId: row.attachmentId,
      title: row.title ?? "doc.pdf",
      contentType: "application/pdf",
      contentHash: "sha-x",
      status: "success" as const,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  mocks.withTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  mocks.insertChunks.mockResolvedValue(undefined);
  mocks.screenshot.mockResolvedValue([
    { pageIndex: 0, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { pageIndex: 1, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  mocks.getObject.mockResolvedValue(Buffer.from("%PDF-1.4\n"));
  mocks.uploadKbImage.mockImplementation(async ({ key }: { key: string }) => `${BASE_URL}/${key}`);
  mocks.embedderInvoke.mockResolvedValue([
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0x6],
  ]);
  mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "page text" });
  mocks.chatInvoke.mockResolvedValue(["entity1", "entity2"]);
});

describe("backend/kb-agent", () => {
  describe("screenshotNode error paths", () => {
    it("fails when no userId is provided", async () => {
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: null },
        { configurable: {} },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toBeTruthy();
    });

    it("fails when no human message is present", async () => {
      const out = await kbAgent.invoke(
        { messages: [], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/no PDF|no human/i);
    });

    it("fails when no PDF file part is found anywhere", async () => {
      const messages = [
        new HumanMessage({ content: [{ type: "text", text: "no file" }], id: "m-1" }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/no PDF|no file/i);
    });

    it("fails when no PDF could be processed (all unknown attachments)", async () => {
      mocks.getAttachment.mockResolvedValue(null);
      const messages = [humanWithOnePdf()];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/no PDF could be processed/i);
    });

    it("strips the PDF file part when its attachment row is missing", async () => {
      mocks.getAttachment.mockResolvedValue(null);
      const messages = [humanWithOnePdf()];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      // File part dropped, no kb_ref for it (unknown).
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.some((p) => p.type === "file")).toBe(false);
      expect(content.some((p) => p.type === "kb_ref")).toBe(false);
      // Text part preserved.
      expect(content.some((p) => p.type === "text")).toBe(true);
    });
  });

  describe("new PDF — full pipeline", () => {
    it("happy path: per-doc screenshot → ocr → chunk + embed + store → kb_ref appended", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({
        markdown: "page one markdown content ".repeat(50),
      });
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({
        markdown: "page two markdown content ".repeat(50),
      });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      expect(out.errorMessage).toBeNull();
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(1);
      expect(processed[0].docId).toMatch(/^d-/);
      expect(processed[0].pipelineStatus).toBe("new");
      expect(mocks.ocrStructuredInvoke).toHaveBeenCalledTimes(2);
      expect(mocks.embedderInvoke).toHaveBeenCalledTimes(1);
      expect(mocks.withTx).toHaveBeenCalledTimes(1);
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1);
      expect(mocks.invalidate).toHaveBeenCalledWith(USER, processed[0].docId);

      const lastMsg = (out.messages as HumanMessage[])[0];
      const content = lastMsg.content as Array<Record<string, unknown>>;
      expect(content.some((p) => p.type === "kb_ref")).toBe(true);
      expect(content.some((p) => p.type === "file")).toBe(false);
    });

    it("falls back to [] entities when the chat invoke rejects", async () => {
      mocks.chatInvoke.mockRejectedValue(new Error("parse error"));
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      const docId = processed[0].docId as string;
      const chunks = out.chunksByDocId as Record<string, Array<{ entities: unknown }>>;
      expect(chunks[docId][0].entities).toEqual([]);
    });

    it("uses r2key fallback hash when attachment.sha256 is null", async () => {
      const url = urlFor("nohash");
      mocks.getAttachment.mockImplementation(async (_u: string, r2Key: string) => ({
        ...attachmentFor(`${BASE_URL}/${r2Key}`),
        sha256: null,
      }));
      const out = await kbAgent.invoke(
        {
          messages: [
            new HumanMessage({
              content: [{ type: "text", text: "x" }, pdfFilePart(url)] as never,
              id: "m-1",
            }),
          ],
          userId: USER,
        },
        { configurable: { userId: USER } },
      );
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].contentHash).toBe(`r2key:${url.replace(`${BASE_URL}/`, "")}`);
    });
  });

  describe("dedup — primary (contentHash hit)", () => {
    it("success: kb_ref appended, no new ingest work", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: "att-1",
        title: "doc.pdf",
        contentType: "application/pdf",
        contentHash: "sha-x",
        status: "success",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].docId).toBe("d-existing");
      expect(processed[0].pipelineStatus).toBe("dedup");
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.ocrStructuredInvoke).not.toHaveBeenCalled();
      expect(mocks.embedderInvoke).not.toHaveBeenCalled();
      expect(mocks.insertDoc).not.toHaveBeenCalled();
      const lastMsg = (out.messages as HumanMessage[])[0];
      const content = lastMsg.content as Array<Record<string, unknown>>;
      expect(content.some((p) => p.type === "kb_ref")).toBe(true);
    });

    it("failed: existing row's errorMessage carried through processedFiles", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: "att-1",
        title: "doc.pdf",
        contentType: "application/pdf",
        contentHash: "sha-x",
        status: "failed",
        errorMessage: "OCR timed out",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].errorMessage).toBe("OCR timed out");
      expect(processed[0].pipelineStatus).toBe("dedup");
    });

    it("parsing: dedup hit mirrors the existing row's parsing status", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: "att-1",
        title: "doc.pdf",
        contentType: "application/pdf",
        contentHash: "sha-x",
        status: "parsing",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].pipelineStatus).toBe("dedup");
      // Overall run is still success — dedup completed.
      expect(out.status).toBe("success");
    });
  });

  describe("dedup — secondary (attachmentId hit when contentHash missed)", () => {
    it("attachmentId dedup wins when contentHash is empty", async () => {
      mocks.findByHash.mockResolvedValue(null);
      mocks.findByAtt.mockResolvedValueOnce({
        id: "d-by-attachment",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: "att-1",
        title: "doc.pdf",
        contentType: "application/pdf",
        contentHash: "different-hash",
        status: "success",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].docId).toBe("d-by-attachment");
      expect(processed[0].pipelineStatus).toBe("dedup");
      expect(mocks.screenshot).not.toHaveBeenCalled();
    });
  });

  describe("ocrNode error path", () => {
    it("marks the run failed when OCR throws", async () => {
      mocks.ocrStructuredInvoke.mockRejectedValue(new Error("OCR gateway 502"));
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/OCR gateway 502/);
    });
  });

  describe("chunkEmbedStoreNode — single doc", () => {
    it("fails with 'empty markdown' when all OCR pages returned empty strings", async () => {
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "" });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/empty markdown/i);
      expect(mocks.insertDoc).not.toHaveBeenCalled();
    });

    it("concatenates pages' markdown across the doc for chunking", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({ markdown: "alpha beta" });
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({ markdown: "gamma" });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      const docId = processed[0].docId as string;
      const chunks = out.chunksByDocId as Record<string, Array<{ content: string }>>;
      const joined = chunks[docId].map((c) => c.content).join("\n\n");
      expect(joined).toContain("alpha beta");
      expect(joined).toContain("gamma");
    });
  });

  // ponytail: regression guard for the multi-PDF cases. These pin
  // "kbAgent processes EVERY PDF in EVERY HumanMessage" — if anyone
  // reverts to "last only", these go red.
  describe("multi-PDF scenarios", () => {
    it("processes 2 PDFs in a single HumanMessage — both get kb_refs", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      // Two pages × two docs = 4 OCR calls
      mocks.ocrStructuredInvoke.mockResolvedValue({
        markdown: "doc markdown content ".repeat(40),
      });
      const messages = [
        new HumanMessage({
          content: [
            { type: "text", text: "compare these" },
            pdfFilePart(urlFor("alpha")),
            pdfFilePart(urlFor("beta")),
          ] as never,
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(2);
      expect(processed.map((p) => p.pipelineStatus)).toEqual(["new", "new"]);
      expect(mocks.insertDoc).toHaveBeenCalledTimes(2);
      expect(mocks.insertChunks).toHaveBeenCalledTimes(2);
      // Both kb_refs appended in place (replacing both file parts)
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "kb_ref")).toHaveLength(2);
      expect(content.filter((p) => p.type === "file")).toHaveLength(0);
      expect(content.filter((p) => p.type === "text")).toHaveLength(1);
    });

    it("processes PDFs across 2 separate HumanMessages — both get kb_refs", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({
        markdown: "page markdown ".repeat(40),
      });
      const messages = [
        new HumanMessage({
          content: [{ type: "text", text: "first" }, pdfFilePart(urlFor("alpha"))] as never,
          id: "m-1",
        }),
        new AIMessage("ok"),
        new HumanMessage({
          content: [{ type: "text", text: "second" }, pdfFilePart(urlFor("beta"))] as never,
          id: "m-2",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(2);
      // Each HumanMessage gets its own kb_ref, file part replaced in place
      const m1 = (out.messages as HumanMessage[])[0];
      const m2 = (out.messages as HumanMessage[])[2];
      const c1 = m1.content as Array<Record<string, unknown>>;
      const c2 = m2.content as Array<Record<string, unknown>>;
      expect(c1.some((p) => p.type === "kb_ref")).toBe(true);
      expect(c1.some((p) => p.type === "file")).toBe(false);
      expect(c2.some((p) => p.type === "kb_ref")).toBe(true);
      expect(c2.some((p) => p.type === "file")).toBe(false);
      // Per-messageIndex tagging
      expect(processed.map((p) => p.messageIndex)).toEqual([0, 2]);
    });

    it("handles 1 dedup + 1 new in one invocation — both rewritten", async () => {
      const existing = {
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: "att-existing",
        title: "alpha.pdf",
        contentType: "application/pdf",
        contentHash: "sha-existing",
        status: "success",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      // Override getAttachment so alpha's row carries the dedup-matching
      // sha256 + attachmentId. beta falls through to the default mock.
      const alphaKey = urlFor("alpha").replace(`${BASE_URL}/`, "");
      mocks.getAttachment.mockImplementation(async (_u: string, r2Key: string) => {
        if (r2Key === alphaKey) {
          return {
            id: "att-existing",
            userId: USER,
            r2Key: alphaKey,
            name: "alpha.pdf",
            contentType: "application/pdf",
            sizeBytes: 1024,
            status: "uploaded" as const,
            sha256: "sha-existing",
            createdAt: new Date(),
            confirmedAt: new Date(),
          };
        }
        return attachmentFor(`${BASE_URL}/${r2Key}`);
      });
      mocks.findByHash.mockImplementation(async (_u: string, hash: string) =>
        hash === "sha-existing" ? existing : null,
      );
      mocks.findByAtt.mockImplementation(async (_u: string, attId: string) =>
        attId === "att-existing" ? existing : null,
      );
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "beta markdown ".repeat(40) });

      const messages = [
        new HumanMessage({
          content: [pdfFilePart(urlFor("alpha")), pdfFilePart(urlFor("beta"))] as never,
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(2);
      expect(processed[0].docId).toBe("d-existing");
      expect(processed[0].pipelineStatus).toBe("dedup");
      expect(processed[1].docId).toMatch(/^d-/);
      expect(processed[1].pipelineStatus).toBe("new");
      // Only beta goes through OCR + chunk + insert
      expect(mocks.ocrStructuredInvoke).toHaveBeenCalledTimes(2); // 2 pages for beta
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      // Both kb_refs present in the rewritten message
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "kb_ref")).toHaveLength(2);
    });

    it("isolates per-doc OCR failures — one fail, one success", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      // First 2 calls (alpha's pages) succeed, next 2 (beta's pages) reject.
      let callIdx = 0;
      mocks.ocrStructuredInvoke.mockImplementation(async () => {
        const i = callIdx++;
        if (i < 2) {
          return { markdown: "alpha markdown ".repeat(40) };
        }
        throw new Error("beta OCR failed");
      });

      const messages = [
        new HumanMessage({
          content: [pdfFilePart(urlFor("alpha")), pdfFilePart(urlFor("beta"))] as never,
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(2);
      const statuses = processed.map((p) => p.pipelineStatus);
      expect(statuses).toContain("new");
      expect(statuses).toContain("failed");
      // Only alpha's doc gets inserted
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      // The failed entry has docId cleared (resolve strips it)
      const failed = processed.find((p) => p.pipelineStatus === "failed") as Record<
        string,
        unknown
      >;
      expect(failed.docId).toBeNull();
      // The other entry still has a kb_ref
      const success = processed.find((p) => p.pipelineStatus === "new") as Record<string, unknown>;
      expect(success.docId).toMatch(/^d-/);
    });

    it("strips non-PDF file parts while keeping PDF-derived kb_refs", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "doc text ".repeat(40) });
      const messages = [
        new HumanMessage({
          content: [
            { type: "text", text: "see both" },
            pdfFilePart(urlFor("alpha")),
            pdfFilePart(urlFor("img"), "image/png"), // non-PDF
          ] as never,
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      // kb_ref for the PDF, text preserved, image dropped
      expect(content.filter((p) => p.type === "kb_ref")).toHaveLength(1);
      expect(content.filter((p) => p.type === "file")).toHaveLength(0);
      expect(content.filter((p) => p.type === "text")).toHaveLength(1);
    });

    it("preserves existing kb_ref parts while replacing file parts", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "doc text ".repeat(40) });
      const messages = [
        new HumanMessage({
          content: [
            { type: "kb_ref", docId: "d-prev" },
            { type: "text", text: "and new" },
            pdfFilePart(urlFor("alpha")),
          ] as never,
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "kb_ref")).toHaveLength(2);
      expect(content.filter((p) => p.type === "file")).toHaveLength(0);
      expect(content.filter((p) => p.type === "text")).toHaveLength(1);
    });
  });
});
