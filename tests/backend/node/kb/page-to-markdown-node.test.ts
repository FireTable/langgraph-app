import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOcrInvoke = vi.fn();
const mockUpdateKbDocumentStatus = vi.fn();

vi.mock("@/backend/model", () => ({
  getOcrModel: async () => ({
    withStructuredOutput: () => ({
      invoke: (...args: unknown[]) => mockOcrInvoke(...args),
    }),
  }),
}));

vi.mock("@/lib/kb/queries", () => ({
  updateKbDocumentStatus: (...args: unknown[]) => mockUpdateKbDocumentStatus(...args),
}));

import { pageToMarkdownNode } from "@/backend/node/kb/page-to-markdown-node";

// ponytail: P1 fix for Greptile on PR #47. The early-return guard
// incorrectly skipped OCR for retryFailed mode (only chunksOnly /
// retryFailedChunks should pass through). retryFailed re-OCRs the failed
// pages, so the OCR branch must run.

beforeEach(() => {
  mockOcrInvoke.mockReset();
  mockUpdateKbDocumentStatus.mockReset();
});

describe("pageToMarkdownNode — retryFailed mode does NOT skip OCR", () => {
  it("chunksOnly: returns cached pages by reference (OCR skipped)", async () => {
    const pages = [{ pageIndex: 0, imageUrl: "http://x", markdown: "cached" }];
    const state = {
      mode: "chunksOnly",
      pagesByDocId: { "d-1": pages },
      processedFiles: [],
      userId: "u-1",
    };
    const out = await pageToMarkdownNode(state as never);
    expect(out.pagesByDocId).toBe(state.pagesByDocId);
    expect(mockOcrInvoke).not.toHaveBeenCalled();
  });

  it("retryFailedChunks: returns cached pages by reference (OCR skipped)", async () => {
    const pages = [{ pageIndex: 0, imageUrl: "http://x", markdown: "cached" }];
    const state = {
      mode: "retryFailedChunks",
      pagesByDocId: { "d-1": pages },
      processedFiles: [],
      userId: "u-1",
    };
    const out = await pageToMarkdownNode(state as never);
    expect(out.pagesByDocId).toBe(state.pagesByDocId);
    expect(mockOcrInvoke).not.toHaveBeenCalled();
  });

  it("retryFailed: runs OCR — produces fresh pagesByDocId + invokes OCR model for failed pages", async () => {
    mockOcrInvoke.mockResolvedValue({ markdown: "freshly OCR'd" });

    const failedPage = {
      pageIndex: 0,
      imageUrl: "http://x",
      markdown: "",
      status: "failed",
      errorMessage: "previous OCR timed out",
    };
    const processedFile = {
      docId: "d-1",
      pipelineStatus: "new",
      contentType: "application/pdf",
      r2Key: "u/u-1/upload/sha.pdf",
      title: "doc.pdf",
    };
    const state = {
      mode: "retryFailed",
      pagesByDocId: { "d-1": [failedPage] },
      processedFiles: [processedFile],
      userId: "u-1",
    };

    const out = await pageToMarkdownNode(state as never);
    // Different reference → OCR branch ran (skip branch returns the
    // exact same pagesByDocId reference).
    expect(out.pagesByDocId).not.toBe(state.pagesByDocId);
    // OCR was called for the failed page.
    expect(mockOcrInvoke).toHaveBeenCalledTimes(1);
    // The page markdown reflects the OCR result.
    const outPages = out.pagesByDocId?.["d-1"] ?? [];
    expect(outPages[0]?.markdown).toBe("freshly OCR'd");
    expect(outPages[0]?.status).toBe("success");
  });

  it("retryFailed: per-page OCR skip preserves cached successful pages, re-runs only failed ones", async () => {
    // ponytail: P2 follow-up from claude on PR #47 round 3. The per-
    // page OCR skip preserves pages with non-empty markdown AND no
    // errorMessage; a mixed pagesByDocId (some success, some failed)
    // should land in the right lane per page.
    mockOcrInvoke.mockResolvedValue({ markdown: "freshly OCR'd" });

    const okPage = {
      pageIndex: 0,
      imageUrl: "http://x/0",
      markdown: "page 0 already done",
      status: "success",
    };
    const failedPage = {
      pageIndex: 1,
      imageUrl: "http://x/1",
      markdown: "",
      status: "failed",
      errorMessage: "previous OCR timed out",
    };
    const processedFile = {
      docId: "d-1",
      pipelineStatus: "new",
      contentType: "application/pdf",
      r2Key: "u/u-1/upload/sha.pdf",
      title: "doc.pdf",
    };
    const state = {
      mode: "retryFailed",
      pagesByDocId: { "d-1": [okPage, failedPage] },
      processedFiles: [processedFile],
      userId: "u-1",
    };

    const out = await pageToMarkdownNode(state as never);
    const outPages = out.pagesByDocId?.["d-1"] ?? [];

    // OCR invoked only once — for the failed page.
    expect(mockOcrInvoke).toHaveBeenCalledTimes(1);
    // Cached page preserved verbatim.
    expect(outPages[0]?.markdown).toBe("page 0 already done");
    expect(outPages[0]?.status).toBe("success");
    // Failed page re-OCRed.
    expect(outPages[1]?.markdown).toBe("freshly OCR'd");
    expect(outPages[1]?.status).toBe("success");
  });
});
