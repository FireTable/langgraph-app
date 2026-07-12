import "@/tests/helpers/session";
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { GET } from "@/app/api/credit/history/route";
import { db } from "@/db/client";
import { creditUsageLog } from "@/lib/credit/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { makeUser, cleanupUsers, ensureTestUser, TEST_USER } from "@/tests/helpers/auth";

const owner = TEST_USER.id;

function getRequest(query: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/api/credit/history");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

const routeCtx = { params: Promise.resolve(undefined as never) };

function makeCall(overrides: Partial<typeof creditUsageLog.$inferInsert> = {}) {
  return {
    id: randomUUID(),
    userId: owner,
    providerId: "openai",
    modelName: "gpt-4o-mini",
    agentName: "router",
    inputTokens: 100,
    outputTokens: 50,
    credits: "0.0123",
    status: "success" as const,
    errorMessage: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(creditUsageLog);
  setCurrentUser({ id: owner, email: TEST_USER.email });
});

afterAll(async () => {
  await cleanupUsers();
  setCurrentUser(null);
});

describe("GET /api/credit/history — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(getRequest(), routeCtx);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/credit/history — empty", () => {
  it("returns empty array and total=0 when user has no calls", async () => {
    const res = await GET(getRequest(), routeCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("GET /api/credit/history — own calls", () => {
  it("returns the signed-in user's calls ordered by createdAt DESC", async () => {
    const older = makeCall({ id: "older", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = makeCall({ id: "newer", createdAt: new Date("2026-02-01T00:00:00Z") });
    await db.insert(creditUsageLog).values([older, newer]);

    const res = await GET(getRequest(), routeCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.calls.map((c: { id: string }) => c.id)).toEqual(["newer", "older"]);
    expect(body.calls[0]).toMatchObject({
      id: "newer",
      providerId: "openai",
      modelName: "gpt-4o-mini",
      agentName: "router",
      inputTokens: 100,
      outputTokens: 50,
      credits: 0.0123,
      status: "success",
    });
  });
});

describe("GET /api/credit/history — cross-user isolation", () => {
  it("never returns another user's calls", async () => {
    const other = await makeUser();
    await db
      .insert(creditUsageLog)
      .values([
        makeCall({ id: "mine-1" }),
        makeCall({ id: "mine-2" }),
        makeCall({ id: "theirs", userId: other.id }),
      ]);

    const res = await GET(getRequest(), routeCtx);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.calls.map((c: { id: string }) => c.id).sort()).toEqual(["mine-1", "mine-2"]);
  });

  it("isolates when signed in as the other user", async () => {
    const other = await makeUser();
    await db
      .insert(creditUsageLog)
      .values([
        makeCall({ id: "theirs", userId: other.id, agentName: "crypto" }),
        makeCall({ id: "mine", agentName: "router" }),
      ]);

    setCurrentUser({ id: other.id, email: other.email });
    const res = await GET(getRequest(), routeCtx);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].id).toBe("theirs");
    expect(body.calls[0].agentName).toBe("crypto");
  });
});

describe("GET /api/credit/history — pagination", () => {
  it("honors limit and offset", async () => {
    const rows = ["a", "b", "c"].map((id, i) =>
      makeCall({ id, createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`) }),
    );
    await db.insert(creditUsageLog).values(rows);

    const page1 = await GET(getRequest({ limit: "2", offset: "0" }), routeCtx);
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.total).toBe(3);
    expect(body1.calls).toHaveLength(2);
    // DESC: c, b — first page
    expect(body1.calls.map((c: { id: string }) => c.id)).toEqual(["c", "b"]);

    const page2 = await GET(getRequest({ limit: "2", offset: "2" }), routeCtx);
    const body2 = await page2.json();
    expect(body2.total).toBe(3);
    expect(body2.calls).toHaveLength(1);
    expect(body2.calls[0].id).toBe("a");
  });

  it("clamps limit to the schema's max", async () => {
    const res = await GET(getRequest({ limit: "9999" }), routeCtx);
    expect(res.status).toBe(400);
  });

  it("rejects negative offset", async () => {
    const res = await GET(getRequest({ offset: "-1" }), routeCtx);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/credit/history — error rows", () => {
  it("includes errorMessage for status=error rows", async () => {
    await db.insert(creditUsageLog).values([
      makeCall({ id: "ok" }),
      makeCall({
        id: "bad",
        status: "error",
        credits: "0",
        errorMessage: "rate limit exceeded",
      }),
    ]);

    const res = await GET(getRequest(), routeCtx);
    const body = await res.json();
    const bad = body.calls.find((c: { id: string }) => c.id === "bad");
    expect(bad).toMatchObject({
      status: "error",
      errorMessage: "rate limit exceeded",
      credits: 0,
    });
  });
});
