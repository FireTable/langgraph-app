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
  const extractText = vi.fn();
  const getAttachment = vi.fn();
  const r2KeyFromPublic = vi.fn();
  const uploadKbImage = vi.fn();
  const getR2PublicBase = vi.fn();
  const getObject = vi.fn();

  const ensureFolder = vi.fn();
  const findByHash = vi.fn();
  const findByAtt = vi.fn();
  const findById = vi.fn();
  const insertDoc = vi.fn();
  const insertChunks = vi.fn();
  const withTx = vi.fn();
  const invalidate = vi.fn();
  const updateDocStatus = vi.fn();

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
    extractText,
    getAttachment,
    r2KeyFromPublic,
    uploadKbImage,
    getR2PublicBase,
    getObject,
    ensureFolder,
    findByHash,
    findByAtt,
    findById,
    insertDoc,
    insertChunks,
    withTx,
    invalidate,
    updateDocStatus,
  };
});

vi.mock("@/backend/model", () => ({
  getChatModel: mocks.chatFactory,
  getEmbeddingModel: mocks.embedderFactory,
  getOcrModel: mocks.ocrFactory,
}));
vi.mock("@/lib/kb/screenshot", () => ({ screenshotPdf: mocks.screenshot }));
vi.mock("@/lib/kb/text", () => ({ extractPdfText: mocks.extractText }));
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
  findKbDocumentById: mocks.findById,
  insertKbDocument: mocks.insertDoc,
  insertKbChunks: mocks.insertChunks,
  updateKbDocumentStatus: mocks.updateDocStatus,
  withKbTx: mocks.withTx,
}));
vi.mock("@/lib/kb/cache", () => ({
  invalidateKbDoc: mocks.invalidate,
  setInFlightOcr: vi.fn(),
  deleteInFlightOcr: vi.fn(),
}));

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
  mocks.findById.mockImplementation(async (userId: string, id: string) => ({
    id,
    userId,
    folderId: FOLDER_ID,
    attachmentId: "att-x",
    title: "doc.pdf",
    contentType: "application/pdf",
    contentHash: "sha-x",
    status: "success" as const,
    errorMessage: null,
    pages: [
      { pageIndex: 0, imageUrl: "img-0", markdown: "mock page text" },
      { pageIndex: 1, imageUrl: "img-1", markdown: "mock page text" },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  mocks.withTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  mocks.insertChunks.mockResolvedValue(undefined);
  mocks.updateDocStatus.mockResolvedValue(undefined);
  mocks.screenshot.mockResolvedValue([
    { pageIndex: 0, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { pageIndex: 1, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  // ponytail: splitFilePageNode now runs screenshot + extractPdfText in
  // parallel. Default to empty text (vision-only OCR path) so existing
  // vision-flow tests don't need to provide text. Per-test mocks for
  // tests that want to exercise the reference-text branch.
  mocks.extractText.mockResolvedValue([]);
  mocks.getObject.mockResolvedValue(Buffer.from("%PDF-1.4\n"));
  mocks.uploadKbImage.mockImplementation(async ({ key }: { key: string }) => `${BASE_URL}/${key}`);
  // ponytail: kbAgent now sanity-checks dim === 1024 (matches pgvector
  // column + HNSW index). Build a real-shape 1024-dim vector instead
  // of the old 3-tuple stub.
  const makeEmbedding = () => Array.from({ length: 1024 }, (_, i) => (i % 7) * 0.01);
  mocks.embedderInvoke.mockImplementation(async (texts: string[]) =>
    texts.map(() => makeEmbedding()),
  );
  mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "page text" });
  // ponytail: entitySchema is z.object({ entities: z.array(z.string()) })
  // because OpenAI strict jsonSchema mode rejects top-level arrays.
  // The mock must match the new shape — otherwise `out.entities` is
  // undefined and the chunk's entity list silently falls back to [].
  mocks.chatInvoke.mockResolvedValue({ entities: ["entity1", "entity2"] });
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
      // chunk+embed runs in background (fire-and-forget from
      // imageToMarkdownNode) — can't assert call counts synchronously.
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      // imageToMarkdownNode flips status=success after OCR
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        processed[0].docId as string,
        expect.objectContaining({ status: "success" }),
      );

      const lastMsg = (out.messages as HumanMessage[])[0];
      const content = lastMsg.content as Array<Record<string, unknown>>;
      // ponytail: kbAgent stamps `kb_ref` as a sibling field on the
      // file part (not a standalone part). File part preserved, kb_ref
      // carries the docId.
      expect(content.some((p) => p.type === "file" && p.kb_ref)).toBe(true);
      expect(content.some((p) => p.type === "file")).toBe(true);
    });

    it("falls back to [] entities when the chat invoke rejects", async () => {
      // Entity extraction is best-effort — chat invoke rejection
      // doesn't fail the doc. chunk+embed runs in background; we can
      // only verify the graph-level outcome (status, kb_ref stamp).
      mocks.chatInvoke.mockRejectedValue(new Error("parse error"));
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].pipelineStatus).toBe("new");
      expect(processed[0].docId).toMatch(/^d-/);
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
      // embedder may fire in background for any leaked "new" docs
      // from default mocks — dedup itself never triggers it.
      expect(mocks.insertDoc).not.toHaveBeenCalled();
      const lastMsg = (out.messages as HumanMessage[])[0];
      const content = lastMsg.content as Array<Record<string, unknown>>;
      // ponytail: dedup case reuses an existing docId — kbAgent
      // stamps it as a sibling on the file part.
      expect(content.some((p) => p.type === "file" && p.kb_ref)).toBe(true);
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
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0]?.docId).toMatch(/^d-/);
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        processed[0]?.docId as string,
        expect.objectContaining({ status: "failed", errorMessage: "OCR gateway 502" }),
      );
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(1);
      expect(content.filter((p) => p.type === "file")).toHaveLength(1);
    });
  });

  describe("pageToMarkdownNode — single doc", () => {
    it("fails with 'empty markdown' when all OCR pages returned empty strings", async () => {
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "" });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toMatch(/empty markdown/i);
      expect(mocks.insertDoc).toHaveBeenCalledTimes(1);
      expect(mocks.insertChunks).not.toHaveBeenCalled();
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0]?.docId).toMatch(/^d-/);
      // pageToMarkdownNode now correctly flips status="failed" for
      // empty-markdown docs (previously stayed at "parsing" forever).
      const failedUpdates = mocks.updateDocStatus.mock.calls.filter(
        ([, , patch]) => (patch as { status?: string }).status === "failed",
      );
      expect(failedUpdates).toHaveLength(1);
    });

    // ponytail: splitFilePageNode runs screenshot + extractPdfText in
    // parallel; when extractPdfText returns non-empty text, pageToMarkdownNode
    // should attach it as a SECOND text content part on the HumanMessage
    // alongside the image_url part. The OCR call must receive the
    // reference text in its content array — that's the whole point of
    // the dual-source prompt (image for structure, text for ambiguous
    // character accuracy).
    it("passes reference text to the OCR call when extractPdfText returns content", async () => {
      mocks.extractText.mockReset();
      mocks.extractText.mockResolvedValue([
        { pageIndex: 0, text: "extracted native text 0" },
        { pageIndex: 1, text: "extracted native text 1" },
      ]);
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "cleaned markdown" });

      await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );

      expect(mocks.extractText).toHaveBeenCalledTimes(1);
      // 2 pages × 1 doc = 2 OCR calls; each must carry both an image_url
      // part AND a text part citing the reference text.
      expect(mocks.ocrStructuredInvoke).toHaveBeenCalledTimes(2);
      for (const call of mocks.ocrStructuredInvoke.mock.calls) {
        const messages = call[0] as Array<unknown>;
        // ponytail: LangChain serializes messages into V2 envelopes at
        // the model boundary. lc_namespace is sometimes truncated to
        // its first two segments ("langchain_core","messages") with
        // the class name living in `type` ("human" / "system"). Use
        // `type === "human"` as the canonical selector. Content lives
        // under `lc_kwargs.content`.
        const userEnvelope = messages.find((m) => (m as { type?: string }).type === "human");
        expect(userEnvelope).toBeDefined();
        const content = (userEnvelope as { lc_kwargs?: { content?: unknown } }).lc_kwargs?.content;
        const parts: Array<{ type?: string; text?: string }> = Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
          : [];
        const partTypes = parts.map((p) => p.type);
        expect(partTypes).toContain("image_url");
        expect(partTypes).toContain("text");
        // The text part must mention "Reference text" so the model
        // knows it's a spell-check aid and not a structural source.
        const textPart = parts.find((p) => p.type === "text");
        expect(textPart?.text).toMatch(/reference text/i);
      }
    });

    // ponytail: empty reference text (scanned PDF) → no second text part;
    // the OCR call only sees the image. Same as before the change.
    it("omits reference text part when extractPdfText returns empty strings", async () => {
      mocks.extractText.mockReset();
      mocks.extractText.mockResolvedValue([
        { pageIndex: 0, text: "" },
        { pageIndex: 1, text: "" },
      ]);
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "vision only" });

      await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );

      expect(mocks.ocrStructuredInvoke).toHaveBeenCalledTimes(2);
      for (const call of mocks.ocrStructuredInvoke.mock.calls) {
        const messages = call[0] as Array<unknown>;
        const userEnvelope = messages.find((m) => (m as { type?: string }).type === "human");
        const content = (userEnvelope as { lc_kwargs?: { content?: unknown } }).lc_kwargs?.content;
        const parts: Array<{ type?: string; text?: string }> = Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
          : [];
        const partTypes = parts.map((p) => p.type);
        // Only image_url — empty reference text is dropped (not passed as "").
        expect(partTypes).toEqual(["image_url"]);
      }
    });

    it("concatenates pages' markdown and fires background chunk", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({ markdown: "alpha beta" });
      mocks.ocrStructuredInvoke.mockResolvedValueOnce({ markdown: "gamma" });
      const out = await kbAgent.invoke(
        { messages: [humanWithOnePdf()], userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      expect(processed[0].pipelineStatus).toBe("new");
      expect(processed[0].docId).toMatch(/^d-/);
      // chunk+embed runs in background — we verify OCR produced pages
      // and the status was flipped to success.
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        processed[0].docId as string,
        expect.objectContaining({ status: "success" }),
      );
    });

    // ponytail: fan-out isolation. One doc's chunkEmbedStore failure
    // (here, embedDocuments rejects for beta) must not block alpha's
    // chunks from being inserted and indexed. Each per-doc closure runs
    // its own try/catch and only mutates its own entry in
    // updatedProcessed.
    // ponytail: embed failures now happen in backgroundChunkEmbedStore
    // (fire-and-forget), so they're not observable in the graph return.
    // Both docs get pipelineStatus="new" and kb_ref stamps from the
    // graph's perspective. The background function handles failure
    // isolation (flipping status="failed" per-doc on the DB row).
    it("both docs get kb_ref stamps — embed failures handled in background", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({
        markdown: "doc markdown content ".repeat(40),
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
      // Both docs OCR'd successfully → graph status is success
      expect(out.status).toBe("success");
      const processed = out.processedFiles as Array<Record<string, unknown>>;
      const alpha = processed.find(
        (p) => (p.filePart as { data: string }).data === urlFor("alpha"),
      ) as Record<string, unknown>;
      const beta = processed.find(
        (p) => (p.filePart as { data: string }).data === urlFor("beta"),
      ) as Record<string, unknown>;
      expect(alpha.pipelineStatus).toBe("new");
      expect(alpha.docId).toMatch(/^d-/);
      expect(beta.pipelineStatus).toBe("new");
      expect(beta.docId).toMatch(/^d-/);
      // Both kb_refs present in the rewritten HumanMessage.
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(2);
      // Both docs flipped to status=success by imageToMarkdownNode
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        alpha.docId as string,
        expect.objectContaining({ status: "success" }),
      );
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        beta.docId as string,
        expect.objectContaining({ status: "success" }),
      );
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
      await vi.waitFor(() => {
        expect(mocks.insertChunks).toHaveBeenCalledTimes(2);
      });
      // Both file parts preserved with kb_ref sibling (NOT replaced).
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(2);
      expect(content.filter((p) => p.type === "file")).toHaveLength(2);
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
      // ponytail: kb_ref rides on the file part as a sibling.
      expect(c1.some((p) => p.type === "file" && p.kb_ref)).toBe(true);
      expect(c1.some((p) => p.type === "file")).toBe(true);
      expect(c2.some((p) => p.type === "file" && p.kb_ref)).toBe(true);
      expect(c2.some((p) => p.type === "file")).toBe(true);
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
      // Both file parts preserved with kb_ref sibling.
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(2);
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
      // Both docs get a row written (parsing) — even the one that failed OCR.
      expect(mocks.insertDoc).toHaveBeenCalledTimes(2);
      // The failed entry KEEPS its docId so the rewritten HumanMessage
      // can still carry a kb_ref — resolveKbRefs then renders the
      // [Failed: ...] placeholder instead of silently dropping the
      // document context.
      const failed = processed.find((p) => p.pipelineStatus === "failed") as Record<
        string,
        unknown
      >;
      expect(failed.docId).toMatch(/^d-/);
      // updateKbDocumentStatus flips the failed row to status=failed
      expect(mocks.updateDocStatus).toHaveBeenCalledWith(
        USER,
        failed.docId,
        expect.objectContaining({ status: "failed", errorMessage: expect.stringMatching(/OCR/) }),
      );
      // The success entry still has a kb_ref
      const success = processed.find((p) => p.pipelineStatus === "new") as Record<string, unknown>;
      expect(success.docId).toMatch(/^d-/);
      // Both file parts preserved with kb_ref sibling.
      const content = (out.messages as HumanMessage[])[0].content as Array<Record<string, unknown>>;
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(2);
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
      // ponytail: file part preserved with kb_ref sibling, text preserved, image dropped.
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(1);
      expect(content.filter((p) => p.type === "file")).toHaveLength(1);
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
      // ponytail: existing standalone kb_ref part kept, file part
      // gets kb_ref sibling. So total kb_refs = 1 (legacy) + 1 (sibling).
      expect(content.filter((p) => p.type === "kb_ref")).toHaveLength(1);
      expect(content.filter((p) => p.type === "file" && p.kb_ref)).toHaveLength(1);
      expect(content.filter((p) => p.type === "file")).toHaveLength(1);
      expect(content.filter((p) => p.type === "text")).toHaveLength(1);
    });

    // ponytail: regression guard for the multi-turn case. State.messages
    // carries the kbAgent-rewritten file part from turn 1 forward into
    // turn 2 (state.messages is append-only under the langgraph
    // addMessages reducer). chunkEmbedStoreNode's rewrite iterates
    // EVERY HumanMessage — for the older one the file part already
    // carries a kb_ref sibling, so fileToDoc.get(part.data) misses
    // (fileToDoc is built from THIS round's processedFiles) and the
    // pre-fix code `continue`d past it, stripping the file part (and
    // its filename prefix) from the older message. Symptom in the UI:
    // turn 1's KB tile disappeared the moment turn 2's kbAgent ran.
    //
    // Fix: skip file parts with an existing kb_ref sibling and carry
    // them through unchanged. This test pins that behavior.
    it("multi-turn rewrite preserves already-stamped file parts in older HumanMessages", async () => {
      mocks.ocrStructuredInvoke.mockReset();
      mocks.ocrStructuredInvoke.mockResolvedValue({ markdown: "doc text ".repeat(40) });

      // Turn 1: prior round stamped the kb_ref sibling + filename
      // prefix on alpha. This is the round we're simulating the AFTER
      // state of — turn 2 is the new upload we're about to process.
      const priorAlphaUrl = urlFor("alpha");
      const priorStampedFilename = `[kb:d-prior] alpha.pdf`;
      const turn1Message = new HumanMessage({
        content: [
          { type: "text", text: "first upload" },
          {
            type: "file",
            data: priorAlphaUrl,
            mime_type: "application/pdf",
            filename: priorStampedFilename,
            metadata: { filename: priorStampedFilename },
            kb_ref: { docId: "d-prior", attachmentId: "att-prior" },
          },
        ] as never,
        id: "m-1",
      });

      // Turn 2: brand-new PDF, no kb_ref yet. This is what THIS
      // kbAgent invocation will process.
      const messages = [
        turn1Message,
        new HumanMessage({
          content: [{ type: "text", text: "what's this?" }, pdfFilePart(urlFor("beta"))] as never,
          id: "m-2",
        }),
      ];

      const out = await kbAgent.invoke(
        { messages, userId: USER },
        { configurable: { userId: USER } },
      );
      expect(out.status).toBe("success");

      // Turn 1's HumanMessage is preserved BY IDENTITY (rewrite only
      // constructs a new HumanMessage when it had to drop a part) —
      // chunkEmbedStoreNode's `if (!changed) return m` branch. With
      // the fix it returns the original message untouched; without
      // the fix it would build a new HumanMessage missing the file
      // part entirely.
      const rewrittenM1 = (out.messages as HumanMessage[]).find((m) => m.id === "m-1");
      const c1 = rewrittenM1?.content as Array<Record<string, unknown>>;
      const alphaPart = c1.find(
        (p) => p.type === "file" && (p.data as string) === priorAlphaUrl,
      ) as Record<string, unknown>;
      expect(alphaPart).toBeDefined();
      // kb_ref sibling preserved verbatim.
      expect(alphaPart.kb_ref).toEqual({ docId: "d-prior", attachmentId: "att-prior" });
      // Filename prefix preserved verbatim (idempotent stamp on re-write).
      expect(alphaPart.filename).toBe(priorStampedFilename);
      expect((alphaPart.metadata as Record<string, unknown>)?.filename).toBe(priorStampedFilename);

      // Turn 2's HumanMessage gets a new kb_ref sibling + filename prefix.
      const rewrittenM2 = (out.messages as HumanMessage[]).find((m) => m.id === "m-2");
      const c2 = rewrittenM2?.content as Array<Record<string, unknown>>;
      const betaPart = c2.find((p) => p.type === "file") as Record<string, unknown>;
      expect(betaPart.kb_ref).toMatchObject({ docId: expect.stringMatching(/^d-/) });
      expect(betaPart.filename as string).toMatch(/^\[kb:d-/);
    });
  });
});
