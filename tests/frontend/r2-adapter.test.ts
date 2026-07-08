import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { R2AttachmentAdapter } from "@/lib/attachments/r2-adapter";

function fakeFile(name: string, type: string, sizeBytes: number): File {
  // jsdom's File constructor is missing in older versions; build a Blob
  // and cast it. The adapter only reads `name`, `type`, `size`, `arrayBuffer`.
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

describe("R2AttachmentAdapter — add", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,application/pdf";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts presign with name/contentType/size/threadId, then PUTs to R2, returns requires-action", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "abc123def456",
            key: "u/u1/abc123def456-pic.png",
            uploadUrl: "https://r2.example/presigned",
            publicUrl: "https://file.example/u/u1/abc123def456-pic.png",
            uploadHeaders: { "Content-Type": "image/png" },
            contentType: "image/png",
            sizeBytes: 12,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => "t-1" });
    const file = fakeFile("pic.png", "image/png", 12);
    const pending = await adapter.add({ file });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/attachments/presign");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "pic.png",
      contentType: "image/png",
      sizeBytes: 12,
      threadId: "t-1",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://r2.example/presigned");
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ "Content-Type": "image/png" });

    expect(pending.id).toBe("abc123def456");
    expect(pending.type).toBe("image");
    expect(pending.status).toEqual({ type: "requires-action", reason: "composer-send" });
  });

  it("threads null when no thread is active (fresh chat before first message)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "x",
            uploadUrl: "https://r2.example/p",
            uploadHeaders: {},
            contentType: "application/pdf",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await adapter.add({ file: fakeFile("a.pdf", "application/pdf", 8) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).threadId).toBeUndefined();
  });

  it("surfaces a presign failure (4xx) without attempting the PUT", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "FILE_TOO_LARGE" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await expect(adapter.add({ file: fakeFile("a.png", "image/png", 8) })).rejects.toThrow(
      /presign failed: 400/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an R2 PUT failure (4xx)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "x",
            uploadUrl: "https://r2.example/p",
            uploadHeaders: { "Content-Type": "image/png" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("signature mismatch", { status: 403 }));
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await expect(adapter.add({ file: fakeFile("a.png", "image/png", 8) })).rejects.toThrow(
      /upload to R2 failed: 403/,
    );
  });
});

describe("R2AttachmentAdapter — send", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("confirms via POST /api/attachments/[id]/confirm and builds an image content part", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "abc123def456",
          publicUrl: "https://file.example/u/u1/abc123def456-pic.png",
          contentType: "image/png",
          sizeBytes: 12,
          status: "uploaded",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    const complete = await adapter.send({
      id: "abc123def456",
      type: "image",
      name: "pic.png",
      contentType: "image/png",
      file: fakeFile("pic.png", "image/png", 12),
      status: { type: "requires-action", reason: "composer-send" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/attachments/abc123def456/confirm");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(complete.status).toEqual({ type: "complete" });
    expect(complete.content).toEqual([
      {
        type: "image",
        image: "https://file.example/u/u1/abc123def456-pic.png",
        filename: "pic.png",
      },
    ]);
  });

  it("builds a file content part for non-image types", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "p1",
          publicUrl: "https://file.example/u/u1/p1-doc.pdf",
          contentType: "application/pdf",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    const complete = await adapter.send({
      id: "p1",
      type: "file",
      name: "doc.pdf",
      contentType: "application/pdf",
      file: fakeFile("doc.pdf", "application/pdf", 100),
      status: { type: "requires-action", reason: "composer-send" },
    });
    expect(complete.content).toEqual([
      {
        type: "file",
        data: "https://file.example/u/u1/p1-doc.pdf",
        mimeType: "application/pdf",
        filename: "doc.pdf",
      },
    ]);
  });

  it("throws on confirm failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "SIZE_MISMATCH" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await expect(
      adapter.send({
        id: "p1",
        type: "file",
        name: "doc.pdf",
        contentType: "application/pdf",
        file: fakeFile("doc.pdf", "application/pdf", 100),
        status: { type: "requires-action", reason: "composer-send" },
      }),
    ).rejects.toThrow(/confirm failed: 409/);
  });
});

describe("R2AttachmentAdapter — remove", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs a pending attachment", async () => {
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await adapter.remove({
      id: "p1",
      type: "file",
      name: "doc.pdf",
      contentType: "application/pdf",
      file: fakeFile("doc.pdf", "application/pdf", 100),
      status: { type: "requires-action", reason: "composer-send" },
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/p1", { method: "DELETE" });
  });

  it("is a no-op for complete attachments (already part of a message)", async () => {
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await adapter.remove({
      id: "p1",
      type: "file",
      name: "doc.pdf",
      contentType: "application/pdf",
      status: { type: "complete" },
      content: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows network errors on remove (best-effort cleanup)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    await expect(
      adapter.remove({
        id: "p1",
        type: "file",
        name: "doc.pdf",
        contentType: "application/pdf",
        file: fakeFile("doc.pdf", "application/pdf", 100),
        status: { type: "requires-action", reason: "composer-send" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("R2AttachmentAdapter — accept string", () => {
  it("reads NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES for the composer's file picker", () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,application/pdf";
    const adapter = new R2AttachmentAdapter({ getCurrentThreadId: () => null });
    expect(adapter.accept).toBe("image/png,application/pdf");
  });
});
