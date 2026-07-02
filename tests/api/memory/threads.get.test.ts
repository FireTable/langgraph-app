import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, mockGetAllUserSummaries } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mockGetAllUserSummaries: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/memory/queries", () => ({
  getAllUserSummaries: mockGetAllUserSummaries,
}));

describe("GET /api/memory/threads", () => {
  beforeEach(() => {
    getSession.mockReset();
    mockGetAllUserSummaries.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("groups summaries by threadId, sorts each group by sequence desc + group by updatedAt desc", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([
      {
        key: "t1:2",
        value: summary("t1", 2, "2026-07-02T00:00:00.000Z"),
      },
      {
        key: "t1:1",
        value: summary("t1", 1, "2026-07-01T00:00:00.000Z"),
      },
      {
        key: "t2:1",
        value: summary("t2", 1, "2026-06-30T00:00:00.000Z"),
      },
    ]);
    const { GET } = await import("@/app/api/memory/threads/route");
    const res = await GET(new Request("http://localhost/api/memory/threads"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads[0]?.threadId).toBe("t1");
    expect(body.threads[0]?.summaries.map((s: { sequence: number }) => s.sequence)).toEqual([2, 1]);
  });

  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/memory/threads/route");
    const res = await GET(new Request("http://localhost/api/memory/threads"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(401);
  });
});

function summary(threadId: string, sequence: number, updatedAt: string) {
  return {
    threadId,
    sequence,
    name: "n",
    description: "d",
    startMessageIndex: 0,
    endMessageIndex: 0,
    messageCount: 1,
    updatedAt,
  };
}
