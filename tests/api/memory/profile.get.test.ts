import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, mockGetProfileDoc, mockGetSocialAccounts } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mockGetProfileDoc: vi.fn(),
  mockGetSocialAccounts: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/schema", () => ({ account: {} }));
vi.mock("@/lib/memory/queries", () => ({
  getProfileDoc: mockGetProfileDoc,
  getSocialAccounts: mockGetSocialAccounts,
}));

describe("GET /api/memory/profile", () => {
  beforeEach(() => {
    getSession.mockReset();
    mockGetProfileDoc.mockReset();
    mockGetSocialAccounts.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", name: "Yongzhuo", email: "y@example.com", image: null },
      session: { id: "s1", userId: "u1" },
    });
    mockGetProfileDoc.mockResolvedValue({ role: "frontend" });
    mockGetSocialAccounts.mockResolvedValue([{ provider: "github" }]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns 200 with profile + session + socialAccounts", async () => {
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toEqual({ role: "frontend" });
    expect(body.session).toEqual({ name: "Yongzhuo", email: "y@example.com", image: null });
    expect(body.socialAccounts).toEqual([{ provider: "github" }]);
  });

  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(401);
  });

  it("returns 500 when the store throws", async () => {
    mockGetProfileDoc.mockRejectedValueOnce(new Error("db down"));
    const { GET } = await import("@/app/api/memory/profile/route");
    const res = await GET(new Request("http://localhost/api/memory/profile"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(500);
  });
});
