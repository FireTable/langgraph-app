import "@/tests/helpers/session";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import { bulkInsertSpans } from "@/lib/observability/queries";
import { GET, DELETE } from "@/app/api/threads/[id]/observability/route";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER, ensureTestUser, makeUser, cleanupUsers } from "@/tests/helpers/auth";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

function makeSpan(overrides: Partial<CapturedSpan> = {}): CapturedSpan {
  return {
    span_id: "s",
    parent_span_id: null,
    name: "chain",
    kind: "chain",
    status: "completed",
    started_at: Date.now(),
    ended_at: Date.now() + 10,
    input: null,
    output: null,
    usage: null,
    error: null,
    meta: {},
    ...overrides,
  };
}

const owner = TEST_USER.id;

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(observabilitySpans);
  await db.delete(threads);
  setCurrentUser({ id: owner, email: TEST_USER.email });
});

afterAll(async () => {
  await cleanupUsers();
  setCurrentUser(null);
});

describe("GET /api/threads/[id]/observability", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctxFor("any"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the thread does not exist", async () => {
    const res = await GET(new Request("http://localhost"), ctxFor("ghost"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's thread (no existence leak)", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await GET(new Request("http://localhost"), ctxFor("theirs"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 200 with empty spans array for an owned thread with no spans", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread_id).toBe("t-mine");
    expect(body.spans).toEqual([]);
    expect(body.retention_days).toBeGreaterThan(0);
  });

  it("returns the captured spans ordered by started_at", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({ span_id: "b", started_at: base + 20, meta: { langgraph_thread_id: "t-mine" } }),
      makeSpan({ span_id: "a", started_at: base + 10, meta: { langgraph_thread_id: "t-mine" } }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans.map((s: CapturedSpan) => s.span_id)).toEqual(["a", "b"]);
  });

  it("flips running spans to failed before returning them", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "still-running",
        status: "running",
        meta: { langgraph_thread_id: "t-mine" },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans[0].status).toBe("failed");
  });

  it("echoes retention_days from OBSERVABILITY_RETENTION_DAYS env var", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    const prev = process.env.OBSERVABILITY_RETENTION_DAYS;
    process.env.OBSERVABILITY_RETENTION_DAYS = "14";
    try {
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine"));
      const body = await res.json();
      expect(body.retention_days).toBe(14);
    } finally {
      if (prev === undefined) delete process.env.OBSERVABILITY_RETENTION_DAYS;
      else process.env.OBSERVABILITY_RETENTION_DAYS = prev;
    }
  });
});

describe("DELETE /api/threads/[id]/observability", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await DELETE(new Request("http://localhost"), ctxFor("any"));
    expect(res.status).toBe(401);
  });

  it("returns 404 for another user's thread", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await DELETE(new Request("http://localhost"), ctxFor("theirs"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the thread does not exist", async () => {
    const res = await DELETE(new Request("http://localhost"), ctxFor("ghost"));
    expect(res.status).toBe(404);
  });

  it("clears spans for an owned thread and reports the count", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({ span_id: "x", meta: { langgraph_thread_id: "t-mine" } }),
      makeSpan({ span_id: "y", meta: { langgraph_thread_id: "t-mine" } }),
    ]);
    const res = await DELETE(new Request("http://localhost"), ctxFor("t-mine"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(2);
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining).toHaveLength(0);
  });

  it("does not touch spans from other threads", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await db.insert(threads).values({ id: "t-other", userId: owner });
    await bulkInsertSpans([
      makeSpan({ span_id: "x", meta: { langgraph_thread_id: "t-mine" } }),
      makeSpan({ span_id: "y", meta: { langgraph_thread_id: "t-other" } }),
    ]);
    const res = await DELETE(new Request("http://localhost"), ctxFor("t-mine"));
    const body = await res.json();
    expect(body.cleared).toBe(1);
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining.map((r) => r.spanId)).toEqual(["y"]);
  });
});

describe("ON DELETE CASCADE — thread delete removes spans", () => {
  it("removes spans when the owning thread is deleted", async () => {
    await db.insert(threads).values({ id: "t-cascade", userId: owner });
    await bulkInsertSpans([makeSpan({ meta: { langgraph_thread_id: "t-cascade" } })]);
    await db.delete(threads).where(eq(threads.id, "t-cascade"));
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining).toHaveLength(0);
  });
});
