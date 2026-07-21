import "@/tests/helpers/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCurrentUser } from "@/tests/helpers/session";

const mocks = vi.hoisted(() => ({
  getAttachmentForUser: vi.fn(),
  insertAttachment: vi.fn(),
  findUploadedBySha: vi.fn(),
  findKbFolderById: vi.fn(),
  findKbDocumentByContentHash: vi.fn(),
  insertKbDocument: vi.fn(),
  fireIngestionRun: vi.fn(),
  fetchUrlToMarkdown: vi.fn(),
  validateIngestUrl: vi.fn(),
  putObject: vi.fn(),
  getR2FolderUser: vi.fn(() => "u"),
}));

vi.mock("@/lib/attachments/queries", () => ({
  getAttachmentForUser: mocks.getAttachmentForUser,
  insertAttachment: mocks.insertAttachment,
  findUploadedBySha: mocks.findUploadedBySha,
}));
vi.mock("@/lib/kb/queries", () => ({
  findKbFolderById: mocks.findKbFolderById,
  findKbDocumentByContentHash: mocks.findKbDocumentByContentHash,
  insertKbDocument: mocks.insertKbDocument,
}));
vi.mock("@/lib/kb/ingest", () => ({ fireIngestionRun: mocks.fireIngestionRun }));
vi.mock("@/lib/kb/url", () => ({ fetchUrlToMarkdown: mocks.fetchUrlToMarkdown }));
vi.mock("@/lib/kb/url-validate", () => ({
  validateIngestUrl: mocks.validateIngestUrl,
}));
vi.mock("@/lib/r2/client", () => ({
  putObject: mocks.putObject,
  getR2FolderUser: mocks.getR2FolderUser,
}));

import { POST } from "@/app/api/kb/upload/route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/kb/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CTX = { params: Promise.resolve(undefined) };
const USER = { id: "u-1", email: "u@x" };

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  setCurrentUser(USER);
  mocks.findKbFolderById.mockResolvedValue({ id: "f-1", userId: "u-1", name: "Attachments" });
  mocks.findKbDocumentByContentHash.mockResolvedValue(null);
  // ponytail: validateIngestUrl passes by default; URL-deny tests override.
  mocks.validateIngestUrl.mockImplementation(async (rawUrl: string) => ({
    ok: true as const,
    url: new URL(rawUrl),
    addresses: ["1.1.1.1"],
  }));
  mocks.insertKbDocument.mockImplementation(
    async (row: { id: string; userId: string; folderId: string }) => ({
      id: row.id,
      userId: row.userId,
      folderId: row.folderId,
      attachmentId: null,
      title: "doc",
      contentType: "application/pdf",
      contentHash: "h",
      status: "pending" as const,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
});

describe("POST /api/kb/upload — auth + validation", () => {
  it("401 with no session", async () => {
    setCurrentUser(null);
    const res = await POST(makeRequest({ folderId: "f-1", attachmentId: "a-1" }), CTX);
    expect(res.status).toBe(401);
  });

  it("400 with neither attachmentId nor url", async () => {
    const res = await POST(makeRequest({ folderId: "f-1" }), CTX);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID");
  });

  it("404 when folder doesn't belong to caller", async () => {
    mocks.findKbFolderById.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ folderId: "f-x", attachmentId: "a-1" }), CTX);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("FOLDER_NOT_FOUND");
  });
});

describe("POST /api/kb/upload — file path (attachmentId)", () => {
  it("queues a fresh PDF and returns 202", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce({
      id: "a-1",
      userId: "u-1",
      r2Key: "u/u-1/a-1-doc.pdf",
      name: "doc.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
      status: "uploaded",
      sha256: "h-1",
    });

    const res = await POST(makeRequest({ folderId: "f-1", attachmentId: "a-1" }), CTX);
    expect(res.status).toBe(202);
    expect(mocks.fireIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        attachment: expect.objectContaining({ id: "a-1", contentType: "application/pdf" }),
      }),
    );
  });

  it("404 when attachment doesn't belong to caller", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ folderId: "f-1", attachmentId: "a-x" }), CTX);
    expect(res.status).toBe(404);
    expect(mocks.fireIngestionRun).not.toHaveBeenCalled();
  });

  it("409 when attachment not yet uploaded", async () => {
    mocks.getAttachmentForUser.mockResolvedValueOnce({
      id: "a-1",
      status: "pending",
    });
    const res = await POST(makeRequest({ folderId: "f-1", attachmentId: "a-1" }), CTX);
    expect(res.status).toBe(409);
  });
});

describe("POST /api/kb/upload — URL path", () => {
  it("fetches URL, PUTs to R2, writes attachments row, queues", async () => {
    mocks.fetchUrlToMarkdown.mockResolvedValueOnce({
      title: "Hello",
      markdown: "# Hello\n\nbody",
      sourceUrl: "https://example.com/x",
    });
    mocks.putObject.mockResolvedValueOnce("https://r2/u/u-1/a-1.md");
    mocks.insertAttachment.mockResolvedValueOnce({
      id: "a-1",
      userId: "u-1",
      r2Key: "u/u-1/a-1.md",
      name: "Hello.md",
      contentType: "text/markdown",
      sizeBytes: 16,
      status: "uploaded",
    });

    const res = await POST(makeRequest({ folderId: "f-1", url: "https://example.com/x" }), CTX);

    expect(res.status).toBe(202);
    expect(mocks.fetchUrlToMarkdown).toHaveBeenCalledWith("https://example.com/x");
    expect(mocks.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "text/markdown" }),
    );
    expect(mocks.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "text/markdown",
        status: "uploaded",
        sha256: expect.any(String),
      }),
    );
    expect(mocks.fireIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        attachment: expect.objectContaining({ contentType: "text/markdown" }),
      }),
    );
  });

  it("uses URL title as doc title when caller doesn't override", async () => {
    mocks.fetchUrlToMarkdown.mockResolvedValueOnce({
      title: "Article Title",
      markdown: "body",
      sourceUrl: "https://example.com/article",
    });
    mocks.putObject.mockResolvedValueOnce("https://r2/u/u-1/a-1.md");
    mocks.insertAttachment.mockResolvedValueOnce({
      id: "a-1",
      userId: "u-1",
      r2Key: "u/u-1/a-1.md",
      name: "Article Title.md",
      contentType: "text/markdown",
      sizeBytes: 4,
      status: "uploaded",
    });

    await POST(makeRequest({ folderId: "f-1", url: "https://example.com/article" }), CTX);

    expect(mocks.insertKbDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Article Title" }),
    );
  });

  it("honors caller-supplied title for URL flow", async () => {
    mocks.fetchUrlToMarkdown.mockResolvedValueOnce({
      title: "FromURL",
      markdown: "body",
      sourceUrl: "https://example.com/x",
    });
    mocks.putObject.mockResolvedValueOnce("https://r2/u/u-1/a-1.md");
    mocks.insertAttachment.mockResolvedValueOnce({
      id: "a-1",
      userId: "u-1",
      r2Key: "u/u-1/a-1.md",
      name: "Custom.md",
      contentType: "text/markdown",
      sizeBytes: 4,
      status: "uploaded",
    });

    await POST(
      makeRequest({ folderId: "f-1", url: "https://example.com/x", title: "Custom" }),
      CTX,
    );

    expect(mocks.insertKbDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Custom" }),
    );
  });

  it("rejects URL flow when validateIngestUrl denies (greptile P1)", async () => {
    mocks.validateIngestUrl.mockResolvedValueOnce({ ok: false, code: "URL_DENIED_HOST" });

    const res = await POST(makeRequest({ folderId: "f-1", url: "http://169.254.169.254/" }), CTX);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "URL_DENIED_HOST" });
    expect(mocks.fetchUrlToMarkdown).not.toHaveBeenCalled();
  });

  it("returns URL_FETCH_FAILED when fetchUrlToMarkdown throws (greptile P1)", async () => {
    mocks.fetchUrlToMarkdown.mockRejectedValueOnce(new Error("503 from jina"));

    const res = await POST(makeRequest({ folderId: "f-1", url: "https://example.com/x" }), CTX);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "URL_FETCH_FAILED" });
    expect(mocks.insertKbDocument).not.toHaveBeenCalled();
  });

  it("returns URL_EMPTY_CONTENT when reader returns no markdown (greptile P1)", async () => {
    mocks.fetchUrlToMarkdown.mockResolvedValueOnce({
      title: "",
      markdown: "   \n\n  ",
      sourceUrl: "https://example.com/x",
    });

    const res = await POST(makeRequest({ folderId: "f-1", url: "https://example.com/x" }), CTX);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "URL_EMPTY_CONTENT" });
  });
});
