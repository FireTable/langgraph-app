import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, mockDeleteThreadSummaries } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mockDeleteThreadSummaries: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/memory/queries", () => ({
  deleteThreadSummaries: mockDeleteThreadSummaries,
}));

describe("DELETE /api/memory/threads/[threadId]", () => {
  beforeEach(() => {
    getSession.mockReset();
    mockDeleteThreadSummaries.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 200 with { ok: true, deletedCount } when there are summaries", async () => {
    mockDeleteThreadSummaries.mockResolvedValueOnce(3);
    const { DELETE } = await import("@/app/api/memory/threads/[threadId]/route");
    const res = await DELETE(
      new Request("http://localhost/api/memory/threads/t1", { method: "DELETE" }),
      { params: Promise.resolve({ threadId: "t1" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedCount: 3 });
  });

  it("returns 404 when the thread has no summaries", async () => {
    mockDeleteThreadSummaries.mockResolvedValueOnce(0);
    const { DELETE } = await import("@/app/api/memory/threads/[threadId]/route");
    const res = await DELETE(
      new Request("http://localhost/api/memory/threads/t1", { method: "DELETE" }),
      { params: Promise.resolve({ threadId: "t1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { DELETE } = await import("@/app/api/memory/threads/[threadId]/route");
    const res = await DELETE(
      new Request("http://localhost/api/memory/threads/t1", { method: "DELETE" }),
      { params: Promise.resolve({ threadId: "t1" }) },
    );
    expect(res.status).toBe(401);
  });
});
