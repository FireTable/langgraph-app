import "@/tests/helpers/session";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  presignPut: vi.fn(async () => "https://r2.example/presigned"),
  buildPublicUrl: vi.fn((key: string) => `https://file.example/${key}`),
  deleteObject: vi.fn(async () => undefined),
  getR2PublicBaseUrl: vi.fn(() => "https://file.example"),
}));

vi.mock("@/lib/r2/client", async () => {
  class R2NotConfiguredError extends Error {
    readonly missing: readonly string[];
    constructor(missing: readonly string[]) {
      super(`R2 not configured — missing env vars: ${missing.join(", ")}`);
      this.name = "R2NotConfiguredError";
      this.missing = missing;
    }
  }
  return {
    R2NotConfiguredError,
    presignPut: mockState.presignPut,
    buildPublicUrl: mockState.buildPublicUrl,
    deleteObject: mockState.deleteObject,
    getR2PublicBaseUrl: mockState.getR2PublicBaseUrl,
  };
});

import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";
import { R2NotConfiguredError } from "@/lib/r2/client";
import { POST } from "@/app/api/avatar/presign/route";
import { DELETE } from "@/app/api/avatar/route";

const ctx = { params: Promise.resolve(undefined as never) };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function body(overrides: Partial<{ name: string; contentType: string; sizeBytes: number }> = {}) {
  return { name: "me.png", contentType: "image/png", sizeBytes: 1024, ...overrides };
}

beforeEach(() => {
  mockState.presignPut.mockReset();
  mockState.buildPublicUrl.mockReset();
  mockState.deleteObject.mockReset();
  mockState.getR2PublicBaseUrl.mockReset();
  mockState.presignPut.mockResolvedValue("https://r2.example/presigned");
  mockState.buildPublicUrl.mockImplementation((key: string) => `https://file.example/${key}`);
  mockState.deleteObject.mockResolvedValue(undefined);
  mockState.getR2PublicBaseUrl.mockReturnValue("https://file.example");
  process.env.R2_MAX_BYTES = "10485760";
  setCurrentUser({ id: TEST_USER.id, email: TEST_USER.email });
});

afterAll(() => setCurrentUser(null));

describe("POST /api/avatar/presign", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    expect((await POST(jsonRequest(body()), ctx)).status).toBe(401);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect((await POST(req, ctx)).status).toBe(400);
  });

  it("returns 400 on schema violation", async () => {
    const res = await POST(jsonRequest({ name: "", contentType: "image/png", sizeBytes: 0 }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-image content type", async () => {
    const res = await POST(jsonRequest(body({ contentType: "application/pdf" })), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("rejects image/svg+xml (XSS-in-bucket)", async () => {
    const res = await POST(jsonRequest(body({ contentType: "image/svg+xml" })), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 when the file is over the cap", async () => {
    const res = await POST(jsonRequest(body({ sizeBytes: 20_000_000 })), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("FILE_TOO_LARGE");
  });

  it("returns 201 with a presigned PUT + public URL under the user avatar path", async () => {
    const res = await POST(jsonRequest(body()), ctx);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.uploadUrl).toBe("https://r2.example/presigned");
    expect(json.key).toMatch(new RegExp(`^u/${TEST_USER.id}/avatar/[0-9a-z]{12}-me\\.png$`));
    expect(json.publicUrl).toBe(`https://file.example/${json.key}`);
    expect(json.uploadHeaders).toEqual({
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
    });
  });

  it("returns 503 when R2 is not configured", async () => {
    mockState.presignPut.mockRejectedValueOnce(new R2NotConfiguredError(["R2_BUCKET"]));
    const res = await POST(jsonRequest(body()), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("AVATAR_UPLOADS_NOT_CONFIGURED");
  });
});

describe("DELETE /api/avatar", () => {
  const del = (b: unknown) =>
    DELETE(
      new Request("http://localhost", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      }),
      ctx,
    );

  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    expect((await del({ url: "https://file.example/x" })).status).toBe(401);
  });

  it("returns 400 when url is missing", async () => {
    expect((await del({})).status).toBe(400);
  });

  it("deletes an owned avatar object and returns 204", async () => {
    const key = `u/${TEST_USER.id}/avatar/abc123def456-me.png`;
    const res = await del({ url: `https://file.example/${key}` });
    expect(res.status).toBe(204);
    expect(mockState.deleteObject).toHaveBeenCalledWith(key);
  });

  it("no-ops (204) for an external / non-R2 URL without deleting", async () => {
    const res = await del({ url: "https://avatars.githubusercontent.com/u/1?v=4" });
    expect(res.status).toBe(204);
    expect(mockState.deleteObject).not.toHaveBeenCalled();
  });

  it("returns 403 for a key outside the caller's avatar path", async () => {
    const res = await del({ url: "https://file.example/u/someone-else/avatar/x-me.png" });
    expect(res.status).toBe(403);
    expect(mockState.deleteObject).not.toHaveBeenCalled();
  });

  it("returns 503 when R2 is not configured", async () => {
    mockState.getR2PublicBaseUrl.mockImplementationOnce(() => {
      throw new R2NotConfiguredError(["R2_PUBLIC_BASE_URL"]);
    });
    const res = await del({ url: "https://file.example/x" });
    expect(res.status).toBe(503);
  });
});
