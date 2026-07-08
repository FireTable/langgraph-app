import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  presignPut: vi.fn(async () => "https://r2.example/presigned"),
  headObject: vi.fn(async () => ({ contentType: "image/png", contentLength: 1024 })),
  deleteObject: vi.fn(async () => undefined),
  buildPublicUrl: vi.fn((key: string) => `https://file.example/${key}`),
}));

function resetMocks() {
  // mockReset clears once-return queues too — mockClear doesn't. Without
  // this, a `mockRejectedValueOnce` set in one test bleeds into the next.
  mockState.presignPut.mockReset();
  mockState.headObject.mockReset();
  mockState.deleteObject.mockReset();
  mockState.buildPublicUrl.mockReset();
  mockState.presignPut.mockResolvedValue("https://r2.example/presigned");
  mockState.headObject.mockResolvedValue({ contentType: "image/png", contentLength: 1024 });
  mockState.deleteObject.mockResolvedValue(undefined);
  mockState.buildPublicUrl.mockImplementation((key: string) => `https://file.example/${key}`);
}

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
    headObject: mockState.headObject,
    deleteObject: mockState.deleteObject,
    buildPublicUrl: mockState.buildPublicUrl,
    getS3Client: vi.fn(),
    getR2Bucket: vi.fn(() => "test-bucket"),
    getR2PublicBaseUrl: vi.fn(() => "https://file.example"),
  };
});

import { db } from "@/db/client";
import { attachments } from "@/lib/attachments/schema";
import { threads } from "@/lib/threads/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { makeUser, cleanupUsers, ensureTestUser, TEST_USER } from "@/tests/helpers/auth";
import { POST as POSTPresign } from "@/app/api/attachments/presign/route";
import { POST as POSTConfirm } from "@/app/api/attachments/[id]/confirm/route";
import { DELETE as DELETEOne } from "@/app/api/attachments/[id]/route";

const owner = TEST_USER.id;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function presignBody(
  overrides: Partial<{
    name: string;
    contentType: string;
    sizeBytes: number;
    threadId: string;
  }> = {},
) {
  return {
    name: "test.png",
    contentType: "image/png",
    sizeBytes: 1024,
    ...overrides,
  };
}

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(attachments);
  await db.delete(threads);
  resetMocks();
  // Default env so a test that forgets to set them still gets a sane
  // allow-list + cap (tests that exercise validation override per-test).
  process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,image/jpeg,application/pdf";
  process.env.R2_MAX_BYTES = "10485760";
  setCurrentUser({ id: owner, email: TEST_USER.email });
});

afterAll(async () => {
  await cleanupUsers();
  setCurrentUser(null);
});

// ---------- POST /api/attachments/presign ----------

describe("POST /api/attachments/presign — auth + validation", () => {
  const ctx = { params: Promise.resolve(undefined as never) };

  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await POSTPresign(jsonRequest(presignBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POSTPresign(req, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when contentType is not in the allow-list", async () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png,image/jpeg";
    const res = await POSTPresign(
      jsonRequest(presignBody({ contentType: "application/zip" })),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("returns 400 when sizeBytes exceeds R2_MAX_BYTES", async () => {
    process.env.R2_MAX_BYTES = "100";
    const res = await POSTPresign(jsonRequest(presignBody({ sizeBytes: 101 })), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("FILE_TOO_LARGE");
  });

  it("returns 503 when R2 is not configured", async () => {
    const { R2NotConfiguredError } = await import("@/lib/r2/client");
    mockState.presignPut.mockRejectedValueOnce(new R2NotConfiguredError(["R2_BUCKET"]));
    const res = await POSTPresign(jsonRequest(presignBody()), ctx);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("ATTACHMENTS_NOT_CONFIGURED");
  });
});

describe("POST /api/attachments/presign — happy path", () => {
  const ctx = { params: Promise.resolve(undefined as never) };

  it("returns 201 with id, key, uploadUrl, publicUrl and bakes Content-Type into uploadHeaders", async () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png";
    process.env.R2_MAX_BYTES = "10485760";
    const res = await POSTPresign(jsonRequest(presignBody({ name: "pic.png" })), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-z]{12}$/);
    expect(body.key).toBe(`u/${owner}/${body.id}-pic.png`);
    expect(body.uploadUrl).toBe("https://r2.example/presigned");
    expect(body.publicUrl).toBe(`https://file.example/u/${owner}/${body.id}-pic.png`);
    expect(body.uploadHeaders).toEqual({ "Content-Type": "image/png" });
  });

  it("inserts a pending row scoped to the caller", async () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png";
    process.env.R2_MAX_BYTES = "10485760";
    const res = await POSTPresign(jsonRequest(presignBody()), ctx);
    const body = await res.json();
    const row = await db.query.attachments.findFirst({ where: (t, { eq }) => eq(t.id, body.id) });
    expect(row?.userId).toBe(owner);
    expect(row?.status).toBe("pending");
    expect(row?.sizeBytes).toBe(1024);
  });

  it("stores threadId when provided", async () => {
    // FK requires a threads row to exist before referencing thread_id.
    await db.insert(threads).values({ id: "thread-1", userId: owner, title: "test" });
    const res = await POSTPresign(jsonRequest(presignBody({ threadId: "thread-1" })), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = await db.query.attachments.findFirst({ where: (t, { eq }) => eq(t.id, body.id) });
    expect(row?.threadId).toBe("thread-1");
  });
});

// ---------- POST /api/attachments/[id]/confirm ----------

describe("POST /api/attachments/[id]/confirm — auth + ownership", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a missing id", async () => {
    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when confirming another user's attachment (no existence leak)", async () => {
    const other = await makeUser();
    await db.insert(attachments).values({
      id: "theirs",
      userId: other.id,
      r2Key: `u/${other.id}/theirs-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 100,
    });
    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "theirs" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/attachments/[id]/confirm — happy + edge paths", () => {
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES = "image/png";
    process.env.R2_MAX_BYTES = "10485760";
  });

  it("200 + flips status to uploaded when HeadObject matches", async () => {
    await db.insert(attachments).values({
      id: "ok1",
      userId: owner,
      r2Key: `u/${owner}/ok1-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    mockState.headObject.mockResolvedValueOnce({ contentType: "image/png", contentLength: 1024 });

    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "ok1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("uploaded");
    expect(body.publicUrl).toBe(`https://file.example/u/${owner}/ok1-foo.png`);
    const row = await db.query.attachments.findFirst({ where: (t, { eq }) => eq(t.id, "ok1") });
    expect(row?.status).toBe("uploaded");
    expect(row?.confirmedAt).toBeInstanceOf(Date);
  });

  it("409 when HeadObject reports a different size (partial upload)", async () => {
    await db.insert(attachments).values({
      id: "partial",
      userId: owner,
      r2Key: `u/${owner}/partial-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    mockState.headObject.mockResolvedValueOnce({ contentType: "image/png", contentLength: 512 });
    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "partial" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SIZE_MISMATCH");
  });

  it("409 when HeadObject 404s (PUT never landed)", async () => {
    await db.insert(attachments).values({
      id: "ghost",
      userId: owner,
      r2Key: `u/${owner}/ghost-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 1024,
    });
    mockState.headObject.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 404 },
      name: "NotFound",
    });
    const res = await POSTConfirm(new Request("http://localhost"), {
      params: Promise.resolve({ id: "ghost" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("UPLOAD_MISSING");
  });
});

// ---------- DELETE /api/attachments/[id] ----------

describe("DELETE /api/attachments/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("204 removes the row + calls R2 deleteObject", async () => {
    await db.insert(attachments).values({
      id: "del1",
      userId: owner,
      r2Key: `u/${owner}/del1-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 100,
    });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "del1" }),
    });
    expect(res.status).toBe(204);
    const row = await db.query.attachments.findFirst({ where: (t, { eq }) => eq(t.id, "del1") });
    expect(row).toBeUndefined();
    expect(mockState.deleteObject).toHaveBeenCalledWith(`u/${owner}/del1-foo.png`);
  });

  it("404 when another user owns the attachment (no leak)", async () => {
    const other = await makeUser();
    await db.insert(attachments).values({
      id: "theirs",
      userId: other.id,
      r2Key: `u/${other.id}/theirs-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 100,
    });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "theirs" }),
    });
    expect(res.status).toBe(404);
  });

  it("404 when id is missing", async () => {
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("tolerates R2 404 on delete (idempotent)", async () => {
    await db.insert(attachments).values({
      id: "r2ghost",
      userId: owner,
      r2Key: `u/${owner}/r2ghost-foo.png`,
      name: "foo.png",
      contentType: "image/png",
      sizeBytes: 100,
    });
    mockState.deleteObject.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 404 },
      name: "NotFound",
    });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "r2ghost" }),
    });
    expect(res.status).toBe(204);
  });
});
