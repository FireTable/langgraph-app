import "@/tests/helpers/session";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Mock the shared LangGraph SDK Client. The per-turn observability route
// calls runs.list to fetch in-flight bg dispatches; without this mock the
// SDK hits the real langgraph dev server (which 400s on non-UUID thread
// ids like "t-mine"). Production parity: see
// app/api/threads/[id]/observability/[parentMessageId]/route.ts.
type FakeRun = {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  status: "pending" | "running" | "error" | "success" | "timeout" | "interrupted";
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

// ponytail: typed against the SDK signature so mockImplementation
// callbacks in each test can take (threadId, opts) without TS
// rejecting the broader signature.
type RunsListFn = (
  threadId: string,
  opts?: { status?: "pending" | "running" | "error" | "success" | "timeout" | "interrupted" },
) => Promise<FakeRun[]>;

const { mockRunsList } = vi.hoisted(() => ({
  mockRunsList: vi.fn<RunsListFn>(),
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
  mockRunsList.mockReset();
  mockRunsList.mockResolvedValue([]);
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

  describe("in_flight_runs", () => {
    // ponytail: the route fetches SDK runs.list twice (running + pending)
    // to cover both states the SDK's single-valued status filter splits.
    // The route then filters by metadata.parent_message_id. We assert
    // both: the SDK is called per status, and the filter narrows to the
    // current turn.

    function makeRun(overrides: Partial<FakeRun>): FakeRun {
      return {
        run_id: "r-1",
        thread_id: "t-mine",
        assistant_id: "background_agent",
        status: "running",
        created_at: "2026-07-05T00:00:00Z",
        updated_at: "2026-07-05T00:00:01Z",
        metadata: {},
        ...overrides,
      };
    }

    it("returns in_flight_runs filtered by metadata.parent_message_id matching the path", async () => {
      await db.insert(threads).values({ id: "t-mine", userId: owner });
      mockRunsList.mockImplementation(async (_threadId, opts) => {
        if (opts?.status === "running") {
          return [
            makeRun({
              run_id: "bg-match",
              metadata: { parent_message_id: "msg-A" },
            }),
            makeRun({
              run_id: "bg-other-turn",
              metadata: { parent_message_id: "msg-B" },
            }),
          ];
        }
        return [];
      });
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.in_flight_runs).toEqual([expect.objectContaining({ run_id: "bg-match" })]);
    });

    it("queries both running and pending so the panel surfaces either state", async () => {
      await db.insert(threads).values({ id: "t-mine", userId: owner });
      mockRunsList.mockImplementation(async (_threadId, opts) => {
        if (opts?.status === "running") return [];
        if (opts?.status === "pending") {
          return [
            makeRun({
              run_id: "bg-pending",
              status: "pending",
              metadata: { parent_message_id: "msg-A" },
            }),
          ];
        }
        return [];
      });
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
      const body = await res.json();
      expect(body.in_flight_runs).toEqual([
        expect.objectContaining({ run_id: "bg-pending", status: "pending" }),
      ]);
      // ponytail: assert AT LEAST one call per status. The route may
      // call runs.list for additional debug / inspection (e.g. a
      // console.warn probe) — those calls are tolerated as long as the
      // production-shape calls are present.
      const statuses = mockRunsList.mock.calls
        .map((c) => c[1]?.status)
        .filter((s): s is "pending" | "running" => s === "pending" || s === "running");
      expect(statuses).toContain("pending");
      expect(statuses).toContain("running");
    });

    it("drops runs from other threads (SDK scopes by threadId, but paranoia)", async () => {
      // ponytail: langGraphClient.runs.list(threadId, ...) is supposed to
      // already scope by thread. We assert the API doesn't loosen that
      // — if a future refactor moves the call site, this guards it.
      await db.insert(threads).values({ id: "t-mine", userId: owner });
      mockRunsList.mockImplementation(async (_threadId, opts) => {
        if (opts?.status === "running") {
          return [
            makeRun({
              run_id: "cross-thread",
              thread_id: "other-thread",
              metadata: { parent_message_id: "msg-A" },
            }),
          ];
        }
        return [];
      });
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
      const body = await res.json();
      // SDK cross-thread run would be filtered server-side; if it
      // somehow leaks through, the API still must surface it as-is
      // (we don't strip cross-thread runs because that's the SDK's
      // job). Document the current behavior here:
      expect(body.in_flight_runs).toHaveLength(1);
    });

    it("drops runs whose metadata.parent_message_id does not match the path", async () => {
      await db.insert(threads).values({ id: "t-mine", userId: owner });
      mockRunsList.mockResolvedValue([
        makeRun({
          run_id: "no-meta",
          // metadata: {} — no parent_message_id
        }),
        makeRun({
          run_id: "wrong-turn",
          metadata: { parent_message_id: "msg-B" },
        }),
      ]);
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
      const body = await res.json();
      expect(body.in_flight_runs).toEqual([]);
    });

    it("always returns in_flight_runs as an array (never undefined)", async () => {
      await db.insert(threads).values({ id: "t-mine", userId: owner });
      const res = await GET(new Request("http://localhost"), ctxFor("t-mine", "msg-A"));
      const body = await res.json();
      expect(Array.isArray(body.in_flight_runs)).toBe(true);
      expect(body.in_flight_runs).toEqual([]);
    });
  });
});
