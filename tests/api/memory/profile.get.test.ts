import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, mockGetMemoryDoc, mockGetAuthInfo, mockGetRecentThreadSummaries } = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    mockGetMemoryDoc: vi.fn(),
    mockGetAuthInfo: vi.fn(),
    mockGetRecentThreadSummaries: vi.fn(),
  }),
);

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/schema", () => ({ account: {} }));
vi.mock("@/lib/memory/queries", () => ({
  getMemoryDoc: mockGetMemoryDoc,
  getAuthInfo: mockGetAuthInfo,
  getRecentThreadSummaries: mockGetRecentThreadSummaries,
}));

describe("GET /api/memory/profile", () => {
  beforeEach(() => {
    getSession.mockReset();
    mockGetMemoryDoc.mockReset();
    mockGetAuthInfo.mockReset();
    mockGetRecentThreadSummaries.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", name: "Yongzhuo", email: "y@example.com", image: null },
      session: { id: "s1", userId: "u1" },
    });
    // ponytail: API returns store + auth + threads separately so the
    // frontend can run the same mergeMemory the model uses. Store
    // has user-saved fields; auth holds OAuth fields that overlay
    // only when the store key is missing.
    mockGetMemoryDoc.mockResolvedValue({ role: "frontend" });
    mockGetAuthInfo.mockResolvedValue({
      name: "Yongzhuo",
      email: "y@example.com",
      image: null,
      socials: [],
    });
    mockGetRecentThreadSummaries.mockResolvedValue([
      {
        key: "t1:1",
        value: {
          threadId: "t1",
          sequence: 1,
          startMessageIndex: 0,
          endMessageIndex: 6,
          messageCount: 7,
          messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
          summary: { entries: [{ question: "...", answer: "...", refs: ["#1-#4"] }] },
          createdAt: "2026-07-02T00:00:00.000Z",
        },
        // ponytail: enrich the wire shape — null when the rename
        // path hasn't run, fallback to the raw threadId in the UI.
        threadTitle: "Weather chat",
      },
    ]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 200 with the {store, auth, threads} payload (separate fields, not merged)", async () => {
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.store).toMatchObject({ role: "frontend" });
    expect(body.auth).toMatchObject({
      name: "Yongzhuo",
      email: "y@example.com",
    });
    expect(body.threads).toHaveLength(1);
    // ponytail: each thread summary entry carries threadTitle so the UI
    // can render the chat name (set by renameThreadAgent) instead of the
    // raw UUID. Null is the expected fallback when rename hasn't run.
    expect(body.threads[0].threadTitle).toBe("Weather chat");
    // ponytail: the API MUST NOT return a merged `memory` field — that
    // would hide provenance and force the UI to guess source.
    expect(body).not.toHaveProperty("memory");
  });

  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(401);
  });

  it("returns 500 when an unhandled DB error escapes the catch fallback", async () => {
    // ponytail: each query has its own .catch() that swallows errors,
    // so a single query failing returns 200 with degraded data. To
    // exercise the 500 path, the auth check itself must throw
    // synchronously after Promise.all resolves.
    mockGetAuthInfo.mockImplementationOnce(() => {
      throw new Error("auth service down");
    });
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(500);
  });
});
