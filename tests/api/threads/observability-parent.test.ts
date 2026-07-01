import "@/tests/helpers/session";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import { bulkInsertSpans } from "@/lib/observability/queries";
import { GET } from "@/app/api/threads/[id]/observability/[parentMessageId]/route";
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

function ctxFor(id: string, parentMessageId: string) {
  return { params: Promise.resolve({ id, parentMessageId }) };
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

describe("GET /api/threads/[id]/observability/[parentMessageId]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctxFor("any", "msg-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the thread does not exist", async () => {
    const res = await GET(new Request("http://localhost"), ctxFor("ghost", "msg-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's thread (no existence leak)", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await GET(new Request("http://localhost"), ctxFor("theirs", "msg-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns only spans whose parent_message_id matches the path", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({
        span_id: "match-1",
        started_at: base + 10,
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-A" },
      }),
      makeSpan({
        span_id: "match-2",
        started_at: base + 20,
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-A" },
      }),
      makeSpan({
        span_id: "other",
        started_at: base + 30,
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-B" },
      }),
      makeSpan({
        span_id: "no-pmid",
        started_at: base + 40,
        meta: { langgraph_thread_id: "t-mine" },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread_id).toBe("t-mine");
    expect(body.parent_message_id).toBe("msg-A");
    expect(body.spans.map((s: CapturedSpan) => s.span_id)).toEqual(["match-1", "match-2"]);
    // ponytail: the meta re-hydration also walks back from the column
    // — verify the response surfaces parent_message_id for consumers
    // that rely on the meta shape (panel renderers, transform layer).
    expect(body.spans[0].meta.parent_message_id).toBe("msg-A");
  });

  it("flips running spans to failed before returning them", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "still-running",
        status: "running",
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-A" },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans[0].status).toBe("failed");
  });

  it("returns an empty array when no spans match the requested parent_message_id", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "wrong",
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-other" },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-nothing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans).toEqual([]);
  });
});
