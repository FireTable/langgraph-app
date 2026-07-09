import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { R2AttachmentAdapter } from "@/lib/attachments/r2-adapter";

function fakeFile(name: string, type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

// ponytail: deferred-upload contract — add() makes zero network calls,
// send() runs the full presign → PUT → confirm chain. This sidesteps the
// __LOCALID_* FK bug entirely (send() only fires once initialize()
// has settled the thread id) and eliminates orphan pending rows on
// composer cancel. See docs/ATTACHMENTS.md for the full reasoning.

describe("R2AttachmentAdapter — add (deferred)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,application/pdf";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes zero network calls and returns a requires-action PendingAttachment", async () => {
    const adapter = new R2AttachmentAdapter();
    const file = fakeFile("pic.png", "image/png", 12);
    const pending = await adapter.add({ file });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pending.type).toBe("image");
    expect(pending.name).toBe("pic.png");
    expect(pending.contentType).toBe("image/png");
    expect(pending.file).toBe(file);
    expect(pending.status).toEqual({ type: "requires-action", reason: "composer-send" });
  });

  it("ignores the thread concept on add (no thread binding, deferred upload)", async () => {
    const adapter = new R2AttachmentAdapter();
    await adapter.add({ file: fakeFile("a.png", "image/png", 8) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks non-image types as 'file' kind", async () => {
    const adapter = new R2AttachmentAdapter();
    const pending = await adapter.add({ file: fakeFile("a.pdf", "application/pdf", 8) });
    expect(pending.type).toBe("file");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("R2AttachmentAdapter — send (full upload pipeline)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("runs presign → PUT → confirm in order, builds image content part", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "abc123def456",
            key: "u/u1/abc123def456-pic.png",
            uploadUrl: "https://r2.example/presigned",
            publicUrl: "https://file.example/u/u1/abc123def456-pic.png",
            uploadHeaders: {
              "Content-Type": "image/png",
              "Content-Disposition": "inline",
            },
            contentType: "image/png",
            sizeBytes: 12,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
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

    const adapter = new R2AttachmentAdapter();
    const file = fakeFile("pic.png", "image/png", 12);
    const complete = await adapter.send({
      id: "local-uuid",
      type: "image",
      name: "pic.png",
      contentType: "image/png",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 1. presign with name/contentType/size/sha256 (Q2 dedup)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/attachments/presign");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    const presignBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(presignBody).toMatchObject({
      name: "pic.png",
      contentType: "image/png",
      sizeBytes: 12,
    });
    expect(presignBody.sha256).toMatch(/^[0-9a-f]{64}$/);

    // 2. PUT to R2 with uploadHeaders
    expect(fetchMock.mock.calls[1][0]).toBe("https://r2.example/presigned");
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
    });

    // 3. confirm by server-side id (NOT the local-uuid)
    expect(fetchMock.mock.calls[2][0]).toBe("/api/attachments/abc123def456/confirm");
    expect(fetchMock.mock.calls[2][1].method).toBe("POST");

    expect(complete.id).toBe("abc123def456");
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
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "p1",
            uploadUrl: "https://r2.example/p",
            publicUrl: "https://file.example/u/u1/p1-doc.pdf",
            uploadHeaders: {
              "Content-Type": "application/pdf",
              "Content-Disposition": "attachment",
            },
            contentType: "application/pdf",
            sizeBytes: 100,
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            publicUrl: "https://file.example/u/u1/p1-doc.pdf",
            contentType: "application/pdf",
          }),
          { status: 200 },
        ),
      );

    const adapter = new R2AttachmentAdapter();
    const complete = await adapter.send({
      id: "local-uuid",
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

  it("when server returns skipUpload:true, jumps to confirm with no PUT", async () => {
    // Q2: dedup hit. The presign response carries the existing row's
    // publicUrl and skipUpload=true; the adapter must skip the PUT and
    // still call confirm so the row stays 'uploaded'.
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "existing1",
            key: "u/u1/existing1-pic.png",
            publicUrl: "https://file.example/u/u1/existing1-pic.png",
            contentType: "image/png",
            sizeBytes: 12,
            skipUpload: true,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            publicUrl: "https://file.example/u/u1/existing1-pic.png",
            contentType: "image/png",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const adapter = new R2AttachmentAdapter();
    const complete = await adapter.send({
      id: "local-uuid",
      type: "image",
      name: "pic.png",
      contentType: "image/png",
      file: fakeFile("pic.png", "image/png", 12),
      status: { type: "requires-action", reason: "composer-send" },
    });

    // Only 2 calls: presign + confirm. No PUT.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/attachments/existing1/confirm");
    expect(complete.id).toBe("existing1");
    expect(complete.content).toEqual([
      {
        type: "image",
        image: "https://file.example/u/u1/existing1-pic.png",
        filename: "pic.png",
      },
    ]);
  });

  it("throws on presign failure (4xx) without attempting PUT or confirm", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "FILE_TOO_LARGE" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const adapter = new R2AttachmentAdapter();
    await expect(
      adapter.send({
        id: "local",
        type: "file",
        name: "a.png",
        contentType: "image/png",
        file: fakeFile("a.png", "image/png", 8),
        status: { type: "requires-action", reason: "composer-send" },
      }),
    ).rejects.toThrow(/presign failed: 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on R2 PUT failure (4xx) without calling confirm", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "x",
            uploadUrl: "https://r2.example/p",
            uploadHeaders: { "Content-Type": "image/png" },
            contentType: "image/png",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response("signature mismatch", { status: 403 }));
    const adapter = new R2AttachmentAdapter();
    await expect(
      adapter.send({
        id: "local",
        type: "file",
        name: "a.png",
        contentType: "image/png",
        file: fakeFile("a.png", "image/png", 8),
        status: { type: "requires-action", reason: "composer-send" },
      }),
    ).rejects.toThrow(/upload to R2 failed: 403/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on confirm failure", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "p1",
            uploadUrl: "https://r2.example/p",
            uploadHeaders: {},
            contentType: "application/pdf",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "SIZE_MISMATCH" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const adapter = new R2AttachmentAdapter();
    await expect(
      adapter.send({
        id: "local",
        type: "file",
        name: "doc.pdf",
        contentType: "application/pdf",
        file: fakeFile("doc.pdf", "application/pdf", 100),
        status: { type: "requires-action", reason: "composer-send" },
      }),
    ).rejects.toThrow(/confirm failed: 409/);
  });
});

describe("R2AttachmentAdapter — remove (no-op)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing for requires-action attachments (no row exists yet)", async () => {
    const adapter = new R2AttachmentAdapter();
    await adapter.remove({
      id: "local",
      type: "file",
      name: "doc.pdf",
      contentType: "application/pdf",
      file: fakeFile("doc.pdf", "application/pdf", 100),
      status: { type: "requires-action", reason: "composer-send" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for complete attachments (part of a sent message)", async () => {
    const adapter = new R2AttachmentAdapter();
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
});

describe("R2AttachmentAdapter — accept string", () => {
  it("reads NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES for the composer's file picker", () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,application/pdf";
    const adapter = new R2AttachmentAdapter();
    expect(adapter.accept).toBe("image/png,application/pdf");
  });
});
