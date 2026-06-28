import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth/config", () => ({
  auth: { api: { getSession } },
}));

// Env must be mutated BEFORE the route module is imported, because the
// handler reads process.env at call-time (not module-init) — so we set
// it in beforeEach and the handler picks up the latest value.
describe("GET /api/alchemy/status", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.ALCHEMY_API_KEY;
    getSession.mockReset();
    getSession.mockResolvedValue({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = original;
    vi.resetModules();
  });

  it("returns configured: false when ALCHEMY_API_KEY is unset", async () => {
    delete process.env.ALCHEMY_API_KEY;
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET(new Request("http://localhost/api/alchemy/status"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: false });
  });

  it("returns configured: false when ALCHEMY_API_KEY is empty", async () => {
    process.env.ALCHEMY_API_KEY = "";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET(new Request("http://localhost/api/alchemy/status"), {
      params: Promise.resolve({} as never),
    });
    const body = await res.json();
    expect(body).toEqual({ configured: false });
  });

  it("returns configured: true when ALCHEMY_API_KEY is set", async () => {
    process.env.ALCHEMY_API_KEY = "alchemy-test-key-abc123";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET(new Request("http://localhost/api/alchemy/status"), {
      params: Promise.resolve({} as never),
    });
    const body = await res.json();
    expect(body).toEqual({ configured: true });
  });

  it("never includes the key value in the response", async () => {
    process.env.ALCHEMY_API_KEY = "super-secret-key-12345";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET(new Request("http://localhost/api/alchemy/status"), {
      params: Promise.resolve({} as never),
    });
    const text = await res.text();
    expect(text).not.toContain("super-secret-key-12345");
  });
});
