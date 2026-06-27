import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Env must be mutated BEFORE the route module is imported, because the
// handler reads process.env at call-time (not module-init) — so we set
// it in beforeEach and the handler picks up the latest value.
describe("GET /api/alchemy/status", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.ALCHEMY_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = original;
  });

  it("returns configured: false when ALCHEMY_API_KEY is unset", async () => {
    delete process.env.ALCHEMY_API_KEY;
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: false });
  });

  it("returns configured: false when ALCHEMY_API_KEY is empty", async () => {
    process.env.ALCHEMY_API_KEY = "";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ configured: false });
  });

  it("returns configured: true when ALCHEMY_API_KEY is set", async () => {
    process.env.ALCHEMY_API_KEY = "alchemy-test-key-abc123";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ configured: true });
  });

  it("never includes the key value in the response", async () => {
    process.env.ALCHEMY_API_KEY = "super-secret-key-12345";
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("super-secret-key-12345");
  });
});
