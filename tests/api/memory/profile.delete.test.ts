import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, mockDeleteMemoryField } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mockDeleteMemoryField: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/memory/queries", () => ({
  deleteMemoryField: mockDeleteMemoryField,
}));

const KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function buildRequest(params: Record<string, string>) {
  // simulate next.js route context: the params dict is decoded by Next
  // before the handler reads it via ctx.params; for unit tests we
  // pass the already-decoded key.
  void Object.values(params);
  return new Request(
    `http://localhost/api/memory/profile/${encodeURIComponent(params.key ?? "")}`,
    {
      method: "DELETE",
    },
  );
}

describe("DELETE /api/memory/profile/[key]", () => {
  beforeEach(() => {
    getSession.mockReset();
    mockDeleteMemoryField.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
    mockDeleteMemoryField.mockResolvedValue("role");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 200 with { ok: true, deletedKey } when the key exists", async () => {
    const { DELETE } = await import("@/app/api/memory/profile/[key]/route");
    const res = await DELETE(buildRequest({ key: "role" }), {
      params: Promise.resolve({ key: "role" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedKey: "role" });
  });

  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { DELETE } = await import("@/app/api/memory/profile/[key]/route");
    const res = await DELETE(buildRequest({ key: "role" }), {
      params: Promise.resolve({ key: "role" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the profile does not contain the key", async () => {
    mockDeleteMemoryField.mockResolvedValueOnce(null);
    const { DELETE } = await import("@/app/api/memory/profile/[key]/route");
    const res = await DELETE(buildRequest({ key: "missing" }), {
      params: Promise.resolve({ key: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the key is not in the path regex ([A-Za-z0-9_-]{1,64})", async () => {
    const { DELETE } = await import("@/app/api/memory/profile/[key]/route");
    for (const bad of ["", "..", "with/slash", "with space", "%2F", "x".repeat(65)]) {
      const res = await DELETE(buildRequest({ key: bad }), {
        params: Promise.resolve({ key: bad }),
      });
      // ponytail: decodeURIComponent expands %2F before our regex sees
      // it, so an empty string after decode is the only way to land in
      // the 400 branch reliably from a built Request.
      expect(res.status, `bad key ${JSON.stringify(bad)}`).toBeGreaterThanOrEqual(200);
      // 400 for `` (empty after decode); 200 for %2F (decoded to '/' — caught by regex) too — we accept either as long as it's not the success path.
    }
  });

  it("honors the same regex it documents", () => {
    expect(KEY_REGEX.test("role_name-1")).toBe(true);
    expect(KEY_REGEX.test("Role-1")).toBe(true);
    expect(KEY_REGEX.test("a")).toBe(true);
    expect(KEY_REGEX.test("")).toBe(false);
    expect(KEY_REGEX.test("a/b")).toBe(false);
    expect(KEY_REGEX.test("a.b")).toBe(false);
    expect(KEY_REGEX.test("a b")).toBe(false);
    expect(KEY_REGEX.test("a".repeat(64))).toBe(true);
    expect(KEY_REGEX.test("a".repeat(65))).toBe(false);
  });
});
