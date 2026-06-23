import { describe, it, expect, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/config", () => ({
  auth: { api: { getSession } },
}));

import { withAuth } from "@/lib/auth/with-auth";

function call(handler: Parameters<typeof withAuth>[0], url = "http://localhost", params?: unknown) {
  // ponytail: route ctx matches Next.js App Router — params is a Promise.
  return handler(new Request(url), {
    params: Promise.resolve(params as never),
  });
}

describe("withAuth", () => {
  it("returns 401 when there is no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const handler = withAuth(async () => new Response("secret"));
    const res = await call(handler);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("invokes the handler with the authenticated user when present", async () => {
    const sessionUser = { id: "u1", email: "u1@example.com", name: "Test" };
    getSession.mockResolvedValueOnce({
      user: sessionUser,
      session: { id: "s", userId: "u1" },
    });
    let seen: { id: string; email: string } | null = null;
    const handler = withAuth(async (_req, ctx) => {
      seen = ctx.user;
      return new Response("ok");
    });
    const res = await call(handler);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual(sessionUser);
  });

  it("passes the awaited route params through to the handler", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s", userId: "u1" },
    });
    let seen: unknown = "unset";
    const handler = withAuth<{ id: string }>(async (_req, { params }) => {
      seen = await params;
      return new Response("ok");
    });
    await call(handler, "http://localhost/x", { id: "42" });
    expect(seen).toEqual({ id: "42" });
  });

  it("does not call the handler when unauthenticated", async () => {
    getSession.mockResolvedValueOnce(null);
    let called = false;
    const handler = withAuth(async () => {
      called = true;
      return new Response("ok");
    });
    await call(handler);
    expect(called).toBe(false);
  });

  it("propagates the handler's Response untouched", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s", userId: "u1" },
    });
    const original = new Response(JSON.stringify({ threads: [] }), {
      status: 201,
      headers: { "x-trace": "abc" },
    });
    const handler = withAuth(async () => original);
    const res = await call(handler);
    expect(res).toBe(original);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-trace")).toBe("abc");
  });
});
