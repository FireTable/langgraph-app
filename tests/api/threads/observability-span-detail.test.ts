import "@/tests/helpers/session";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// ponytail: mock the LangGraph SDK Client. The detail endpoint falls
// back to langGraphClient.runs.list when the requested span isn't in
// the local DB. We pre-mock it to a noop default so the test doesn't
// hit the real dev server.
const { mockRunsList } = vi.hoisted(() => ({
  mockRunsList: vi.fn(),
}));

vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    threads: { create: vi.fn() },
    runs: { list: mockRunsList },
  },
}));

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import { bulkInsertSpans } from "@/lib/observability/queries";
import { GET } from "@/app/api/threads/[id]/observability/[parentMessageId]/spans/[spanId]/route";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER, ensureTestUser, makeUser, cleanupUsers } from "@/tests/helpers/auth";
import type { CapturedSpan } from "@/lib/observability/callback";

function makeSpan(overrides: Partial<CapturedSpan> = {}): CapturedSpan {
  return {
    span_id: "s",
    parent_span_id: null,
    name: "chain",
    kind: "chain",
    status: "completed",
    started_at: Date.now(),
    ended_at: Date.now() + 10,
    input: { foo: "bar" },
    output: { result: 42 },
    usage: null,
    error: null,
    meta: {},
    ...overrides,
  };
}

const owner = TEST_USER.id;

function ctxFor(threadId: string, parentMessageId: string, spanId: string) {
  return {
    params: Promise.resolve({ id: threadId, parentMessageId, spanId }),
  };
}

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(observabilitySpans);
  await db.delete(threads);
  setCurrentUser({ id: owner, email: TEST_USER.email });
  mockRunsList.mockReset();
  mockRunsList.mockResolvedValue([]);
});

afterAll(async () => {
  await cleanupUsers();
  setCurrentUser(null);
});

describe("GET /api/threads/[id]/observability/[parentMessageId]/spans/[spanId]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctxFor("any", "msg-1", "s-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the thread does not exist", async () => {
    const res = await GET(new Request("http://localhost"), ctxFor("ghost", "msg-1", "s-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's thread (no existence leak)", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await GET(new Request("http://localhost"), ctxFor("theirs", "msg-1", "s-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the span does not exist locally and SDK has no run", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-1", "missing"));
    expect(res.status).toBe(404);
  });

  it("returns the full CapturedSpan for an owned thread's existing span", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "real-span",
        name: "weatherModel",
        kind: "llm",
        meta: {
          langgraph_thread_id: "t-mine",
          parent_message_id: "msg-1",
          ls_model_name: "gpt-4o-mini",
        },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-1", "real-span"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread_id).toBe("t-mine");
    expect(body.span.span_id).toBe("real-span");
    expect(body.span.kind).toBe("llm");
    expect(body.span.input).toEqual({ foo: "bar" });
    expect(body.span.output).toEqual({ result: 42 });
    expect(body.span.meta.ls_model_name).toBe("gpt-4o-mini");
    expect(body.span.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it("does not leak spans from other threads", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "cross-thread",
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-1" },
      }),
    ]);
    await db.insert(threads).values({ id: "t-other", userId: owner });
    const res = await GET(
      new Request("http://localhost"),
      ctxFor("t-other", "msg-1", "cross-thread"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the same span_id exists in another turn (parent_message_id mismatch)", async () => {
    // ponytail: this is the whole point of moving the endpoint under
    // [parentMessageId]. A span with id "real" was written in msg-A;
    // requesting it under msg-B must 404, not return the wrong turn's
    // data. Without the new WHERE clause, a previous version of the
    // route surfaced the wrong span.
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    await bulkInsertSpans([
      makeSpan({
        span_id: "real",
        meta: { langgraph_thread_id: "t-mine", parent_message_id: "msg-A" },
      }),
    ]);
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-B", "real"));
    expect(res.status).toBe(404);
  });

  it("falls back to SDK runs.list when the span is missing locally (e.g. retention evicted it)", async () => {
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    mockRunsList.mockImplementation(async (_threadId, opts) => {
      if (opts?.status === "running") {
        return [
          {
            run_id: "bg-1",
            thread_id: "t-mine",
            assistant_id: "background_agent",
            status: "running",
            created_at: "2026-07-05T00:00:00Z",
            updated_at: "2026-07-05T00:00:01Z",
            metadata: { parent_message_id: "msg-1" },
          },
        ];
      }
      return [];
    });
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-1", "bg-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.span.span_id).toBe("bg-1");
    expect(body.span.kind).toBe("chain");
    expect(body.span.meta.assistant_id).toBe("background_agent");
    expect(body.span.meta.parent_message_id).toBe("msg-1");
  });

  it("does NOT fall back to an SDK run from a different turn (parent_message_id mismatch)", async () => {
    // ponytail: the SDK's runs.list can include concurrent runs from
    // earlier turns. A run_id match alone isn't enough — the run must
    // also carry `metadata.parent_message_id` matching the path. This
    // is the bug that motivated moving the endpoint under
    // [parentMessageId].
    await db.insert(threads).values({ id: "t-mine", userId: owner });
    mockRunsList.mockImplementation(async (_threadId, opts) => {
      if (opts?.status === "running") {
        return [
          {
            run_id: "bg-1",
            thread_id: "t-mine",
            assistant_id: "background_agent",
            status: "running",
            created_at: "2026-07-05T00:00:00Z",
            updated_at: "2026-07-05T00:00:01Z",
            metadata: { parent_message_id: "msg-A" },
          },
        ];
      }
      return [];
    });
    const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-B", "bg-1"));
    expect(res.status).toBe(404);
  });
});
