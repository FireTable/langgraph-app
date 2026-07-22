import "@/tests/frontend/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAddDoc, handleAddMultipleDocs } from "@/components/settings/kb-view/helpers";

// ponytail: handleAddDoc used to swallow every error with a plain
// `console.error` — the user clicked "Choose file" on a too-big PDF,
// presign returned `{code:"FILE_TOO_LARGE"}`, the dialog closed, and
// nothing happened on screen. Pinning the toast surface here so
// future refactors can't silently regress back to console-only.

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));

const FOLDER = "folder-1";

function makeFile(name: string, type: string, sizeBytes: number): File {
  // ponytail: jsdom's global File extends Blob and accepts the same
  // shape as the browser constructor. Pass a real ArrayBuffer so the
  // BlobPart union narrows cleanly under TS 5.x — `new Uint8Array(N)`
  // gives a TypedArray<ArrayBuffer> that doesn't satisfy BlobPart in
  // stricter configs.
  return new File([new ArrayBuffer(sizeBytes)], name, { type });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  toast.info.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe("handleAddDoc error surfacing", () => {
  beforeEach(() => {
    // ponytail: stub crypto.subtle so sha256Hex produces a stable
    // hex string for the test — jsdom has it but the real digest is
    // irrelevant, so we just want sha256Hex to NOT take the catch
    // branch (which would omit `sha256` from the request body).
    // digest() returns ArrayBuffer, not a view — wrapping in
    // Uint8Array here triggers TS 5.x's narrowed BufferSource check.
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
  });

  it("toasts a MB-formatted FILE_TOO_LARGE error from presign", async () => {
    // ponytail: pick sizes that round-trip through `formatMb` to
    // something stable — 15.84 MB → "15.8 MB" via (1-decimal) Math
    // division. Asserting the exact MB string keeps the test honest
    // about the rounding rule the user will see on screen.
    const sizeBytes = 16_606_431;
    const file = makeFile(
      "big.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes,
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/attachments/presign") {
        return jsonResponse(400, {
          code: "FILE_TOO_LARGE",
          maxBytes: 10 * 1024 * 1024,
          sizeBytes,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "File too large",
      expect.objectContaining({
        description: expect.stringContaining("15.8 MB"),
      }),
    );
    expect(toast.error.mock.calls[0][1].description).toContain("10.0 MB");
    // The kb-upload step must NOT have been reached.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/attachments/presign"]);
  });

  it("toasts a friendly message for CONTENT_TYPE_NOT_ALLOWED", async () => {
    const file = makeFile("bad.exe", "application/x-msdownload", 100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          code: "CONTENT_TYPE_NOT_ALLOWED",
          contentType: "application/x-msdownload",
        }),
      ),
    );

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      "File type not supported",
      expect.objectContaining({ description: expect.stringContaining("bad.exe") }),
    );
  });

  it("falls back to code + stage when an unrecognized error code arrives", async () => {
    const file = makeFile("x.pdf", "application/pdf", 100);
    // Simulate presign returning 500 with a code the handler doesn't
    // special-case — the user should still see something useful.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { code: "INTERNAL_ERROR" })),
    );

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      "Upload failed (presign)",
      expect.objectContaining({ description: expect.stringContaining("INTERNAL_ERROR") }),
    );
  });

  it("still toasts when the error body isn't JSON", async () => {
    const file = makeFile("x.pdf", "application/pdf", 100);
    vi.stubGlobal(
      "fetch",
      // Plain text body — json() throws, but readApiError catches and
      // falls back to `HTTP {status}`.
      vi.fn(async () => new Response("oh no", { status: 502 })),
    );

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      "Upload failed (presign)",
      expect.objectContaining({ description: expect.stringContaining("HTTP 502") }),
    );
  });

  it("returns true and toasts success on a happy 202 from /api/kb/upload", async () => {
    const file = makeFile("a.pdf", "application/pdf", 100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/attachments/presign") {
          return jsonResponse(201, {
            id: "att-1",
            uploadUrl: "https://r2.example/upload",
            uploadHeaders: { "Content-Type": "application/pdf" },
            publicUrl: "https://cdn.example/a.pdf",
          });
        }
        if (url === "https://r2.example/upload") return emptyResponse(200);
        if (url === "/api/attachments/att-1/confirm") return emptyResponse(200);
        if (url === "/api/kb/upload") {
          return jsonResponse(202, { doc: { title: "a.pdf" } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Upload queued", expect.any(Object));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("returns true and toasts dedup info on a happy 200 from /api/kb/upload", async () => {
    const file = makeFile("dup.pdf", "application/pdf", 100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/attachments/presign") {
          return jsonResponse(201, {
            id: "att-1",
            uploadUrl: "https://r2.example/upload",
            uploadHeaders: { "Content-Type": "application/pdf" },
            publicUrl: "https://cdn.example/dup.pdf",
          });
        }
        if (url === "https://r2.example/upload") return emptyResponse(200);
        if (url === "/api/attachments/att-1/confirm") return emptyResponse(200);
        if (url === "/api/kb/upload") {
          return jsonResponse(200, { deduped: true, doc: { title: "dup.pdf" } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const ok = await handleAddDoc(file, FOLDER, () => {});

    expect(ok).toBe(true);
    expect(toast.info).toHaveBeenCalledWith("Already in knowledge base", expect.any(Object));
  });
});

describe("handleAddMultipleDocs batch uploads", () => {
  beforeEach(() => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
  });

  it("uploads multiple files, reports progress, and toasts batch success", async () => {
    const file1 = makeFile("doc1.pdf", "application/pdf", 100);
    const file2 = makeFile("doc2.md", "text/markdown", 50);

    let attCounter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/attachments/presign") {
          attCounter++;
          return jsonResponse(201, {
            id: `att-${attCounter}`,
            uploadUrl: `https://r2.example/upload/${attCounter}`,
            uploadHeaders: { "Content-Type": "application/octet-stream" },
            publicUrl: `https://cdn.example/file${attCounter}`,
          });
        }
        if (url.startsWith("https://r2.example/upload/")) return emptyResponse(200);
        if (url.includes("/confirm")) return emptyResponse(200);
        if (url === "/api/kb/upload") {
          return jsonResponse(202, { doc: { title: `doc${attCounter}` } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const progressCalls: Array<[number, number]> = [];
    const refreshFn = vi.fn();

    const { successCount, failCount } = await handleAddMultipleDocs(
      [file1, file2],
      FOLDER,
      refreshFn,
      (completed, total) => progressCalls.push([completed, total]),
    );

    expect(successCount).toBe(2);
    expect(failCount).toBe(0);
    expect(progressCalls).toContainEqual([0, 2]);
    expect(progressCalls).toContainEqual([2, 2]);
    expect(toast.success).toHaveBeenCalledWith(
      "Batch upload queued",
      expect.objectContaining({
        description: expect.stringContaining("2 file(s) uploaded"),
      }),
    );
  });

  it("handles partial failure and toasts warning", async () => {
    const file1 = makeFile("ok.pdf", "application/pdf", 100);
    const file2 = makeFile("fail.exe", "application/x-msdownload", 50);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/attachments/presign") {
          const body = JSON.parse((init?.body as string) || "{}");
          if (body.name === "fail.exe") {
            return jsonResponse(400, { code: "CONTENT_TYPE_NOT_ALLOWED" });
          }
          return jsonResponse(201, {
            id: "att-ok",
            uploadUrl: "https://r2.example/upload/ok",
            uploadHeaders: {},
            publicUrl: "https://cdn.example/ok",
          });
        }
        if (url === "https://r2.example/upload/ok") return emptyResponse(200);
        if (url === "/api/attachments/att-ok/confirm") return emptyResponse(200);
        if (url === "/api/kb/upload") {
          return jsonResponse(202, { doc: { title: "ok.pdf" } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const { successCount, failCount } = await handleAddMultipleDocs(
      [file1, file2],
      FOLDER,
      () => {},
    );

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Batch upload completed with errors",
      expect.objectContaining({
        description: expect.stringContaining("1 file(s) queued for ingestion, 1 file(s) failed"),
      }),
    );
  });
});
