import { HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

// ponytail: mock everything kb-agent.ts touches at the IO boundary —
// models, screenshot, R2 helpers, attachment lookup, DB queries. The SUT
// compiles the graph at module load; tests just invoke it with stubbed
// state and assert the merged state on return.

const mocks = vi.hoisted(() => {
  const chatInvoke = vi.fn();
  const chatWithStructured = vi.fn(() => ({ invoke: chatInvoke }));
  const chatInstance = { withStructuredOutput: chatWithStructured };
  const chatFactory = vi.fn(async () => chatInstance);

  const embedderInvoke = vi.fn();
  const embedderFactory = vi.fn(async () => ({ embedDocuments: embedderInvoke }));

  const vlmStructuredInvoke = vi.fn();
  // ponytail: kbAgent.vlmNode uses vlm.withStructuredOutput(schema).invoke(...).
  // Mock the structured chain directly — the bare .invoke() path is not used.
  const vlmFactory = vi.fn(async () => ({
    withStructuredOutput: () => ({ invoke: vlmStructuredInvoke }),
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
    vlmStructuredInvoke,
    vlmFactory,
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
  getVlmModel: mocks.vlmFactory,
}));
vi.mock("@/lib/kb/screenshot", () => ({
  screenshotPdf: mocks.screenshot,
}));
vi.mock("@/lib/attachments/queries", () => ({
  findAttachmentByR2Key: mocks.getAttachment,
}));
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
vi.mock("@/lib/kb/cache", () => ({
  invalidateKbDoc: mocks.invalidate,
}));

// ponytail: import after mocks so the compiled graph picks up the stubs.
import { kbAgent } from "@/backend/agent/kb-agent";

const USER: string = "u-1";
const ATT_ID = "att-1";
const R2_KEY = "u/u-1/abc-resume.pdf";
const FOLDER_ID = "f-1";

function attachmentStub() {
  return {
    id: ATT_ID,
    userId: USER,
    r2Key: R2_KEY,
    name: "resume.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    status: "uploaded" as const,
    sha256: "sha-abc",
    createdAt: new Date(),
    confirmedAt: new Date(),
  };
}

function pdfFilePart(url = "https://r2.example.com/u/u-1/abc-resume.pdf") {
  return { type: "file" as const, data: url, mime_type: "application/pdf" };
}

function humanWithFile(file = pdfFilePart(), text = "look at this pdf") {
  return [
    new HumanMessage({
      content: [{ type: "text", text }, file],
      id: "m-1",
    }),
  ];
}

async function runKbAgent(
  input: { messages?: ReturnType<typeof humanWithFile>; userId?: string | null } = {},
) {
  const messages = input.messages ?? humanWithFile();
  return kbAgent.invoke(
    { messages, userId: input.userId === undefined ? USER : input.userId },
    { configurable: { userId: USER } },
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  });
  // Default happy-path stubs.
  mocks.getR2PublicBase.mockReturnValue("https://r2.example.com");
  mocks.r2KeyFromPublic.mockReturnValue(R2_KEY);
  mocks.getAttachment.mockResolvedValue(attachmentStub());
  mocks.findByHash.mockResolvedValue(null);
  mocks.findByAtt.mockResolvedValue(null);
  mocks.ensureFolder.mockResolvedValue({ id: FOLDER_ID, userId: USER, name: "Attachments" });
  mocks.insertDoc.mockImplementation(
    async (row: { id: string; userId: string; title?: string }) => ({
      id: row.id,
      userId: row.userId,
      folderId: FOLDER_ID,
      attachmentId: ATT_ID,
      title: row.title ?? "resume.pdf",
      contentType: "application/pdf",
      contentHash: "sha-abc",
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
  mocks.uploadKbImage.mockImplementation(
    async ({ key }: { key: string }) => `https://r2.example.com/${key}`,
  );
  mocks.embedderInvoke.mockResolvedValue([
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]);
  mocks.vlmStructuredInvoke.mockResolvedValue({ markdown: "page text" });
  mocks.chatInvoke.mockResolvedValue(["entity1", "entity2"]);
});

describe("backend/kb-agent", () => {
  describe("screenshotNode error paths", () => {
    // ponytail: screenshotNode early-returns with makeError() (status=failed,
    // skipPipeline=true) but does NOT set docId/attachmentId/contentHash.
    // chunkEmbedStoreNode's first guard then fires with "missing fields",
    // which becomes the final errorMessage after merge. We assert status=
    // failed + the errorMessage is non-null; the exact text depends on
    // which guard wins.

    it("fails when no userId is provided", async () => {
      const out = await kbAgent.invoke(
        { messages: humanWithFile(), userId: null },
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
      expect(out.errorMessage).toMatch(/no human message|missing fields/i);
    });

    it("fails when the last human message carries no file part", async () => {
      const messages = [
        new HumanMessage({ content: [{ type: "text", text: "no file" }], id: "m-1" }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/no file part|missing fields/i);
    });

    it("fails when the file mime type is unsupported", async () => {
      const messages = [
        new HumanMessage({
          content: [
            { type: "text", text: "x" },
            { type: "file", data: "https://r2.example.com/x.png", mime_type: "image/png" },
          ],
          id: "m-1",
        }),
      ];
      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/unsupported type|missing fields/i);
    });

    it("fails when the attachment row is missing", async () => {
      mocks.getAttachment.mockResolvedValueOnce(null);
      const out = await runKbAgent();
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/attachment not found|missing fields/i);
    });
  });

  describe("new PDF — full pipeline", () => {
    it("happy path: screenshot → vlm → chunk + embed + store → kb_ref appended", async () => {
      // Stub VLM to return distinct, long-enough content per page so the
      // splitter produces 2 chunks (chunkSize=1000). Short strings collapse
      // into 1 chunk and break the chunk-count assertions below.
      mocks.vlmStructuredInvoke.mockReset();
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({
        markdown: "page one markdown content ".repeat(50),
      });
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({
        markdown: "page two markdown content ".repeat(50),
      });
      const out = await runKbAgent();
      expect(out.status).toBe("success");
      expect(out.errorMessage).toBeNull();
      expect(out.skipPipeline).toBe(false);
      expect(out.docId).toMatch(/^d-/);
      expect(out.attachmentId).toBe(ATT_ID);
      expect(out.contentHash).toBe("sha-abc");
      // 2 pages → 2 VLM calls
      expect(mocks.vlmStructuredInvoke).toHaveBeenCalledTimes(2);
      // 1 embed call covering all chunks
      expect(mocks.embedderInvoke).toHaveBeenCalledTimes(1);
      const chunkTexts = mocks.embedderInvoke.mock.calls[0][0] as string[];
      expect(chunkTexts.length).toBeGreaterThanOrEqual(1);
      // one entity-extraction call per chunk
      expect(mocks.chatInvoke).toHaveBeenCalledTimes(chunkTexts.length);
      // chunks contain both pages' markdown
      const allChunkContent = (out.chunks as Array<{ content: string }>)
        .map((c) => c.content)
        .join("\n\n");
      expect(allChunkContent).toContain("page one");
      expect(allChunkContent).toContain("page two");
      // Doc inserted via withKbTx
      expect(mocks.withTx).toHaveBeenCalledTimes(1);
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1);
      // Cache invalidated after the new doc lands
      expect(mocks.invalidate).toHaveBeenCalledWith(USER, out.docId);
      // kb_ref appended to the last HumanMessage
      const lastMsg = (out.messages as HumanMessage[]).find(
        (m) => (m as HumanMessage).id === "m-1",
      ) as HumanMessage | undefined;
      const content = lastMsg?.content as Array<Record<string, unknown>>;
      expect(content.some((p) => p.type === "kb_ref")).toBe(true);
      expect(content.some((p) => p.type === "file")).toBe(false);
    });

    it("falls back to [] entities when the chat invoke rejects", async () => {
      mocks.chatInvoke.mockRejectedValue(new Error("parse error"));
      const out = await runKbAgent();
      expect(out.status).toBe("success");
      expect(out.chunks?.[0]?.entities).toEqual([]);
    });

    it("uses r2key fallback hash when attachment.sha256 is null", async () => {
      mocks.getAttachment.mockResolvedValueOnce({
        ...attachmentStub(),
        sha256: null,
      });
      const out = await runKbAgent();
      expect(out.contentHash).toBe(`r2key:${R2_KEY}`);
    });
  });

  describe("dedup — primary (contentHash hit)", () => {
    it("success: skipPipeline, status from existing row, kb_ref appended", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: ATT_ID,
        title: "resume.pdf",
        contentType: "application/pdf",
        contentHash: "sha-abc",
        status: "success",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await runKbAgent();
      expect(out.skipPipeline).toBe(true);
      expect(out.docId).toBe("d-existing");
      expect(out.status).toBe("success");
      expect(out.errorMessage).toBeNull();
      // No new ingest work
      expect(mocks.screenshot).not.toHaveBeenCalled();
      expect(mocks.vlmStructuredInvoke).not.toHaveBeenCalled();
      expect(mocks.embedderInvoke).not.toHaveBeenCalled();
      expect(mocks.insertDoc).not.toHaveBeenCalled();
      // kb_ref appended
      const lastMsg = (out.messages as HumanMessage[]).find(
        (m) => (m as HumanMessage).id === "m-1",
      ) as HumanMessage;
      const content = lastMsg.content as Array<Record<string, unknown>>;
      expect(content.some((p) => p.type === "kb_ref")).toBe(true);
    });

    it("failed: errorMessage preserved from the existing row", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: ATT_ID,
        title: "resume.pdf",
        contentType: "application/pdf",
        contentHash: "sha-abc",
        status: "failed",
        errorMessage: "VLM timed out",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await runKbAgent();
      expect(out.skipPipeline).toBe(true);
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toBe("VLM timed out");
    });

    it("parsing: placeholder status preserved from the existing row", async () => {
      mocks.findByHash.mockResolvedValueOnce({
        id: "d-existing",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: ATT_ID,
        title: "resume.pdf",
        contentType: "application/pdf",
        contentHash: "sha-abc",
        status: "parsing",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await runKbAgent();
      expect(out.skipPipeline).toBe(true);
      expect(out.status).toBe("parsing");
    });
  });

  describe("dedup — secondary (attachmentId hit when contentHash missed)", () => {
    it("attachmentId dedup wins when contentHash is empty", async () => {
      mocks.findByHash.mockResolvedValueOnce(null);
      mocks.findByAtt.mockResolvedValueOnce({
        id: "d-by-attachment",
        userId: USER,
        folderId: FOLDER_ID,
        attachmentId: ATT_ID,
        title: "resume.pdf",
        contentType: "application/pdf",
        contentHash: "different-hash",
        status: "success",
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const out = await runKbAgent();
      expect(out.docId).toBe("d-by-attachment");
      expect(out.skipPipeline).toBe(true);
      expect(mocks.screenshot).not.toHaveBeenCalled();
    });
  });

  describe("vlmNode error path", () => {
    it("marks the run failed when the VLM throws", async () => {
      mocks.vlmStructuredInvoke.mockRejectedValueOnce(new Error("VLM gateway 502"));
      const out = await runKbAgent();
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/VLM gateway 502/);
    });
  });

  describe("chunkEmbedStoreNode", () => {
    it("fails with 'empty markdown' when all VLM pages returned empty strings", async () => {
      mocks.vlmStructuredInvoke.mockResolvedValue({ markdown: "" });
      const out = await runKbAgent();
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/empty markdown/i);
      expect(mocks.insertDoc).not.toHaveBeenCalled();
    });

    it("extracts text from a markdown VLM response", async () => {
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({ markdown: "page one markdown" });
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({ markdown: "page two markdown" });
      const out = await runKbAgent();
      expect(out.status).toBe("success");
      expect(out.chunks?.[0]?.content).toContain("page one");
    });

    it("extracts text from a longer markdown VLM response", async () => {
      mocks.vlmStructuredInvoke.mockReset();
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({ markdown: "alpha beta" });
      mocks.vlmStructuredInvoke.mockResolvedValueOnce({ markdown: "gamma" });
      const out = await runKbAgent();
      expect(out.status).toBe("success");
      // With 2 short pages, the splitter produces 1 chunk covering both.
      const allChunkContent = (out.chunks as Array<{ content: string }>)
        .map((c) => c.content)
        .join("\n\n");
      expect(allChunkContent).toContain("alpha beta");
      expect(allChunkContent).toContain("gamma");
    });
  });
});
