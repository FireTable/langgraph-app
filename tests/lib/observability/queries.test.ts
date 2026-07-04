import "@/tests/helpers/session";
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import {
  bulkInsertSpans,
  getSpansByThreadId,
  markRunningAsFailed,
  deleteSpansByThreadId,
  deleteSpansOlderThan,
  findLatestParentMessageId,
} from "@/lib/observability/queries";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

async function seedThread(id: string, userId = TEST_USER.id): Promise<void> {
  await db.insert(threads).values({ id, userId, title: "obs-test" });
}

function makeSpan(overrides: Partial<CapturedSpan> = {}): CapturedSpan {
  return {
    span_id: "span-" + Math.random().toString(36).slice(2, 10),
    parent_span_id: null,
    name: "chain",
    kind: "chain",
    status: "completed",
    started_at: Date.now(),
    ended_at: Date.now() + 10,
    input: { foo: "bar" },
    output: { ok: true },
    usage: null,
    error: null,
    meta: { langgraph_thread_id: "t-1", langgraph_node: "agent" },
    ...overrides,
  };
}

beforeEach(async () => {
  await ensureTestUser();
  await db.delete(observabilitySpans);
  await db.delete(threads);
});

describe("bulkInsertSpans", () => {
  it("inserts a single span and returns the row count", async () => {
    await seedThread("t-1");
    const written = await bulkInsertSpans([makeSpan({ meta: { langgraph_thread_id: "t-1" } })]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    expect(rows).toHaveLength(1);
    expect(rows[0].threadId).toBe("t-1");
  });

  it("bulk-inserts many spans in one call", async () => {
    await seedThread("t-1");
    const spans = Array.from({ length: 25 }, (_, i) =>
      makeSpan({
        span_id: `s-${i}`,
        meta: { langgraph_thread_id: "t-1", idx: i },
      }),
    );
    const written = await bulkInsertSpans(spans);
    expect(written).toBe(25);
  });

  it("is idempotent: re-inserting the same span_id is a no-op", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      span_id: "fixed",
      meta: { langgraph_thread_id: "t-1" },
    });
    const first = await bulkInsertSpans([span]);
    const second = await bulkInsertSpans([span]);
    expect(first).toBe(1);
    expect(second).toBe(0);
    const rows = await db.select().from(observabilitySpans);
    expect(rows).toHaveLength(1);
  });

  it("redacts api_key value to first-5 + *** (FR-009, no throw)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", openai_api_key: "sk-proj-abcdefghij1234567890" },
    });
    const written = await bulkInsertSpans([span]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const persisted = rows[0].meta as Record<string, unknown>;
    expect(persisted.openai_api_key).toBe("sk-pr***");
  });

  it("does NOT redact baseURL — explicit allowlist (FR-009 narrowed)", async () => {
    // ponytail: baseURL was dropped from the denylist because LLM output
    // regularly mentions it as a noun ("default baseURL", "set the
    // baseURL to ..."), producing false positives. Any URL-shaped value
    // is still preserved verbatim; we trust the schema / provider kwargs
    // to keep the real baseURL in env vars, not span payloads.
    await seedThread("t-1");
    const original = "https://internal-proxy.example.com/v1";
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", baseURL: original },
    });
    const written = await bulkInsertSpans([span]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const persisted = rows[0].meta as Record<string, unknown>;
    expect(persisted.baseURL).toBe(original);
  });

  it("redacts Bearer token value to first-5 + *** (FR-009, no throw)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", header: "Bearer abcdef1234567890xyz" },
    });
    const written = await bulkInsertSpans([span]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const persisted = rows[0].meta as Record<string, unknown>;
    expect(persisted.header).toBe("Bearer abcde***");
  });

  it("redacts secret in nested output field, not just top-level meta", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1" },
      output: { headers: { authorization: "Bearer topsecrettoken12345" } },
    });
    const written = await bulkInsertSpans([span]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const output = rows[0].output as { headers: { authorization: string } };
    expect(output.headers.authorization).toBe("Bearer topse***");
  });

  it("writes spans with no forbidden field verbatim (regression guard)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: {
        langgraph_thread_id: "t-1",
        langgraph_node: "agent",
        parent_message_id: "msg-12345",
      },
    });
    const written = await bulkInsertSpans([span]);
    expect(written).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const persisted = rows[0].meta as Record<string, unknown>;
    expect(persisted.langgraph_node).toBe("agent");
    expect(persisted.parent_message_id).toBe("msg-12345");
  });

  it("throws when the span has no thread_id in meta", async () => {
    const span = makeSpan({ meta: { langgraph_node: "agent" } });
    // ponytail: threadIdOf accepts both `meta.thread_id` (LC v1.x) and
    // `meta.langgraph_thread_id` (older LC). Neither present → throw.
    await expect(bulkInsertSpans([span])).rejects.toThrow(/thread_id/);
  });

  it("projects meta.parent_message_id into the column on insert", async () => {
    await seedThread("t-col");
    await bulkInsertSpans([
      makeSpan({
        span_id: "c-1",
        meta: { langgraph_thread_id: "t-col", parent_message_id: "msg-A" },
      }),
      makeSpan({
        span_id: "c-2",
        meta: { langgraph_thread_id: "t-col" }, // no parent_message_id
      }),
    ]);
    const rows = await db
      .select({
        spanId: observabilitySpans.spanId,
        parentMessageId: observabilitySpans.parentMessageId,
      })
      .from(observabilitySpans);
    const map = Object.fromEntries(rows.map((r) => [r.spanId, r.parentMessageId]));
    expect(map["c-1"]).toBe("msg-A");
    expect(map["c-2"]).toBeNull();
  });

  it("re-hydrates meta.parent_message_id from the column when meta doesn't carry it", async () => {
    // ponytail: round-trip guard — the column is indexable storage; if
    // a row reaches getSpansByThreadId without meta.parent_message_id
    // (e.g. a future writer bypasses the toRow projection), reads must
    // re-hydrate so downstream consumers see the same shape they wrote.
    await seedThread("t-roundtrip");
    // Direct insert bypassing toRow's projection to force the column-only path.
    await db.insert(observabilitySpans).values({
      spanId: "rt-1",
      threadId: "t-roundtrip",
      parentSpanId: null,
      name: "chain",
      kind: "chain",
      status: "completed",
      startedAt: Date.now(),
      endedAt: Date.now() + 1,
      input: null,
      output: null,
      usage: null,
      error: null,
      meta: { langgraph_thread_id: "t-roundtrip" }, // no parent_message_id key here
      parentMessageId: "msg-from-column-only",
    });
    const [fetched] = await getSpansByThreadId("t-roundtrip");
    expect(fetched?.meta.parent_message_id).toBe("msg-from-column-only");
  });
});

describe("getSpansByThreadId", () => {
  it("returns rows ordered by started_at ascending", async () => {
    await seedThread("t-1");
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({ span_id: "a", started_at: base + 30, meta: { langgraph_thread_id: "t-1" } }),
      makeSpan({ span_id: "b", started_at: base + 10, meta: { langgraph_thread_id: "t-1" } }),
      makeSpan({ span_id: "c", started_at: base + 20, meta: { langgraph_thread_id: "t-1" } }),
    ]);
    const spans = await getSpansByThreadId("t-1");
    expect(spans.map((s) => s.span_id)).toEqual(["b", "c", "a"]);
  });

  it("returns an empty array for a thread with no spans", async () => {
    const spans = await getSpansByThreadId("nonexistent");
    expect(spans).toEqual([]);
  });

  it("isolates spans across threads", async () => {
    await seedThread("t-a");
    await seedThread("t-b");
    await bulkInsertSpans([
      makeSpan({ span_id: "x", meta: { langgraph_thread_id: "t-a" } }),
      makeSpan({ span_id: "y", meta: { langgraph_thread_id: "t-b" } }),
    ]);
    const a = await getSpansByThreadId("t-a");
    const b = await getSpansByThreadId("t-b");
    expect(a.map((s) => s.span_id)).toEqual(["x"]);
    expect(b.map((s) => s.span_id)).toEqual(["y"]);
  });

  it("filters by parentMessageId when supplied", async () => {
    await seedThread("t-1");
    await bulkInsertSpans([
      makeSpan({
        span_id: "a",
        meta: { langgraph_thread_id: "t-1", parent_message_id: "msg-1" },
      }),
      makeSpan({
        span_id: "b",
        meta: { langgraph_thread_id: "t-1", parent_message_id: "msg-2" },
      }),
      makeSpan({
        span_id: "c",
        meta: { langgraph_thread_id: "t-1", parent_message_id: "msg-1" },
      }),
      makeSpan({
        span_id: "d",
        meta: { langgraph_thread_id: "t-1" }, // no parent_message_id
      }),
    ]);
    const filtered = await getSpansByThreadId("t-1", { parentMessageId: "msg-1" });
    expect(filtered.map((s) => s.span_id).sort()).toEqual(["a", "c"]);
  });

  it("returns all spans for the thread when parentMessageId is omitted", async () => {
    await seedThread("t-1");
    await bulkInsertSpans([
      makeSpan({
        span_id: "a",
        meta: { langgraph_thread_id: "t-1", parent_message_id: "msg-1" },
      }),
      makeSpan({
        span_id: "b",
        meta: { langgraph_thread_id: "t-1" },
      }),
    ]);
    const spans = await getSpansByThreadId("t-1");
    expect(spans.map((s) => s.span_id).sort()).toEqual(["a", "b"]);
  });
});

describe("markRunningAsFailed", () => {
  it("flips only running rows to failed, leaves completed alone", async () => {
    await seedThread("t-1");
    await bulkInsertSpans([
      makeSpan({ span_id: "r", status: "running", meta: { langgraph_thread_id: "t-1" } }),
      makeSpan({ span_id: "c", status: "completed", meta: { langgraph_thread_id: "t-1" } }),
    ]);
    const n = await markRunningAsFailed("t-1");
    expect(n).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const byId = Object.fromEntries(rows.map((r) => [r.spanId, r.status]));
    expect(byId.r).toBe("failed");
    expect(byId.c).toBe("completed");
  });

  it("does not touch other threads' running rows", async () => {
    await seedThread("t-a");
    await seedThread("t-b");
    await bulkInsertSpans([
      makeSpan({ span_id: "ar", status: "running", meta: { langgraph_thread_id: "t-a" } }),
      makeSpan({ span_id: "br", status: "running", meta: { langgraph_thread_id: "t-b" } }),
    ]);
    const n = await markRunningAsFailed("t-a");
    expect(n).toBe(1);
    const rows = await db.select().from(observabilitySpans);
    const byId = Object.fromEntries(rows.map((r) => [r.spanId, r.status]));
    expect(byId.ar).toBe("failed");
    expect(byId.br).toBe("running");
  });
});

describe("deleteSpansByThreadId", () => {
  it("removes every row for the thread and reports the count", async () => {
    await seedThread("t-1");
    await seedThread("t-2");
    await bulkInsertSpans([
      makeSpan({ span_id: "a", meta: { langgraph_thread_id: "t-1" } }),
      makeSpan({ span_id: "b", meta: { langgraph_thread_id: "t-1" } }),
      makeSpan({ span_id: "c", meta: { langgraph_thread_id: "t-2" } }),
    ]);
    const n = await deleteSpansByThreadId("t-1");
    expect(n).toBe(2);
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].spanId).toBe("c");
  });
});

describe("ON DELETE CASCADE — thread lifecycle", () => {
  it("deletes spans when the owning thread is deleted", async () => {
    await seedThread("t-cascade");
    await bulkInsertSpans([makeSpan({ meta: { langgraph_thread_id: "t-cascade" } })]);
    await db.delete(threads).where(eq(threads.id, "t-cascade"));
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining).toHaveLength(0);
  });
});

describe("findLatestParentMessageId (DB fallback)", () => {
  // ponytail: this is what the collector's start() calls at the
  // outermost span when currentParentMessageId is null. The most
  // recent non-null parent_message_id on the thread is reused so a
  // resumed / regen / cold-start invoke still tags with the right
  // turn id.
  it("returns the most recent parent_message_id for the thread", async () => {
    await seedThread("t-fl");
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({
        span_id: "older",
        started_at: base + 10,
        meta: { langgraph_thread_id: "t-fl", parent_message_id: "msg-A" },
      }),
      makeSpan({
        span_id: "newer",
        started_at: base + 20,
        meta: { langgraph_thread_id: "t-fl", parent_message_id: "msg-B" },
      }),
      makeSpan({
        span_id: "no-pmid",
        started_at: base + 30,
        meta: { langgraph_thread_id: "t-fl" },
      }),
    ]);
    expect(await findLatestParentMessageId("t-fl")).toBe("msg-B");
  });

  it("returns null when the thread has no prior parent_message_id", async () => {
    await seedThread("t-empty");
    await bulkInsertSpans([
      makeSpan({
        span_id: "no-pmid-1",
        meta: { langgraph_thread_id: "t-empty" },
      }),
    ]);
    expect(await findLatestParentMessageId("t-empty")).toBeNull();
  });

  it("returns null for an unknown thread", async () => {
    expect(await findLatestParentMessageId("ghost-thread")).toBeNull();
  });
});

describe("bulkInsertSpans — backfillWaitingInterruptSpans", () => {
  // ponytail: handler inserts a `kind: "human" / status: "waiting"`
  // span on each tool interrupt, stamping meta.interrupt_tool with
  // the tool's name. The openHumanSpanId in-memory finalize was
  // dropped (dies on `langgraphjs dev` restart); the backfill in
  // bulkInsertSpans takes over: when a new tool span for the same
  // thread arrives, the prior waiting human span for the SAME tool
  // flips to completed before this batch's INSERTs. Other tools'
  // open waits stay open.
  it("closes a prior waiting human span when a new span for the same tool arrives", async () => {
    await seedThread("t-resume");
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({
        span_id: "tool-prior",
        kind: "tool",
        name: "ask_location",
        status: "completed",
        started_at: base,
        ended_at: base + 50,
        meta: { langgraph_thread_id: "t-resume", langgraph_node: "weatherTools" },
      }),
      makeSpan({
        span_id: "tool-prior-interrupt",
        parent_span_id: "tool-prior",
        kind: "human",
        status: "waiting",
        started_at: base + 60,
        ended_at: null,
        meta: {
          langgraph_thread_id: "t-resume",
          langgraph_node: "weatherTools",
          interrupt: true,
          interrupt_tool: "ask_location",
        },
      }),
    ]);
    await bulkInsertSpans([
      makeSpan({
        span_id: "tool-resume",
        kind: "tool",
        name: "ask_location",
        status: "running",
        started_at: base + 5000,
        ended_at: null,
        meta: { langgraph_thread_id: "t-resume", langgraph_node: "weatherTools" },
      }),
    ]);
    const rows = await db
      .select({
        spanId: observabilitySpans.spanId,
        status: observabilitySpans.status,
        endedAt: observabilitySpans.endedAt,
      })
      .from(observabilitySpans);
    const byId = Object.fromEntries(rows.map((r) => [r.spanId, r]));
    expect(byId["tool-prior-interrupt"]?.status).toBe("completed");
    // ended_at is the resume tool's started_at (the gap close), not now().
    expect(byId["tool-prior-interrupt"]?.endedAt).toBe(base + 5000);
    expect(byId["tool-resume"]?.status).toBe("running");
  });

  it("does not close a waiting human span for a different tool", async () => {
    await seedThread("t-mismatch");
    const base = Date.now();
    await bulkInsertSpans([
      makeSpan({
        span_id: "ask-h",
        kind: "human",
        status: "waiting",
        ended_at: null,
        meta: {
          langgraph_thread_id: "t-mismatch",
          interrupt: true,
          interrupt_tool: "ask_location",
        },
      }),
    ]);
    await bulkInsertSpans([
      makeSpan({
        span_id: "place-order",
        kind: "tool",
        name: "place_crypto_order",
        started_at: base + 1000,
        meta: { langgraph_thread_id: "t-mismatch" },
      }),
    ]);
    const [row] = await db
      .select()
      .from(observabilitySpans)
      .where(eq(observabilitySpans.spanId, "ask-h"));
    expect(row.status).toBe("waiting");
    expect(row.endedAt).toBeNull();
  });

  it("does not touch a completed (non-waiting) human span", async () => {
    await seedThread("t-skip");
    await bulkInsertSpans([
      makeSpan({
        span_id: "done-human",
        kind: "human",
        status: "completed",
        ended_at: 1234,
        meta: {
          langgraph_thread_id: "t-skip",
          interrupt: true,
          interrupt_tool: "ask_location",
        },
      }),
    ]);
    await bulkInsertSpans([
      makeSpan({
        span_id: "tool-arrives",
        kind: "tool",
        name: "ask_location",
        meta: { langgraph_thread_id: "t-skip" },
      }),
    ]);
    const [row] = await db
      .select()
      .from(observabilitySpans)
      .where(eq(observabilitySpans.spanId, "done-human"));
    expect(row.status).toBe("completed");
    expect(row.endedAt).toBe(1234);
  });

  it("does not touch other threads' waiting human spans", async () => {
    await seedThread("t-mine");
    await seedThread("t-other");
    await bulkInsertSpans([
      makeSpan({
        span_id: "h-other",
        kind: "human",
        status: "waiting",
        ended_at: null,
        meta: {
          langgraph_thread_id: "t-other",
          interrupt: true,
          interrupt_tool: "ask_location",
        },
      }),
    ]);
    await bulkInsertSpans([
      makeSpan({
        span_id: "tool-mine",
        kind: "tool",
        name: "ask_location",
        meta: { langgraph_thread_id: "t-mine" },
      }),
    ]);
    const [row] = await db
      .select()
      .from(observabilitySpans)
      .where(eq(observabilitySpans.spanId, "h-other"));
    expect(row.status).toBe("waiting");
    expect(row.endedAt).toBeNull();
  });

  it("closes waiting chain wrappers (status=waiting kind=chain) when a resume tool arrives", async () => {
    // ponytail: handleChainError now flips the wrapper chains above an
    // interrupted subgraph to status="waiting" — same as the synthetic
    // human span, but kind="chain" instead of "human". The backfill
    // must also close them: a fresh tool span arriving on the thread
    // means the user resumed, so all the waiting wrappers in the
    // interrupted stack should flip to completed with ended_at stamped
    // to the resume tool's started_at.
    await seedThread("t-chain-resume");
    const base = Date.now();
    // Prior invoke: wrapper chains got `status="waiting"` from
    // handleChainError walking the GraphInterrupt up the stack.
    await bulkInsertSpans([
      makeSpan({
        span_id: "tools-rs",
        kind: "chain",
        name: "RunnableSequence",
        status: "waiting",
        ended_at: null,
        meta: { langgraph_thread_id: "t-chain-resume", langgraph_node: "weatherTools" },
      }),
      makeSpan({
        span_id: "wa-inner",
        kind: "chain",
        name: "CompiledStateGraph",
        status: "waiting",
        ended_at: null,
        meta: { langgraph_thread_id: "t-chain-resume", langgraph_node: "weatherAgent" },
      }),
      makeSpan({
        span_id: "wa-outer",
        kind: "chain",
        name: "RunnableSequence",
        status: "waiting",
        ended_at: null,
        meta: { langgraph_thread_id: "t-chain-resume", langgraph_node: "weatherAgent" },
      }),
    ]);
    // Resume: a new tool span lands.
    await bulkInsertSpans([
      makeSpan({
        span_id: "ask-location-resume",
        kind: "tool",
        name: "ask_location",
        started_at: base + 10000,
        meta: { langgraph_thread_id: "t-chain-resume", langgraph_node: "weatherTools" },
      }),
    ]);
    const rows = await db
      .select({
        spanId: observabilitySpans.spanId,
        status: observabilitySpans.status,
        endedAt: observabilitySpans.endedAt,
      })
      .from(observabilitySpans);
    const byId = Object.fromEntries(rows.map((r) => [r.spanId, r]));
    expect(byId["tools-rs"]?.status).toBe("completed");
    expect(byId["wa-inner"]?.status).toBe("completed");
    expect(byId["wa-outer"]?.status).toBe("completed");
    // ended_at is the resume tool's started_at so the waterfall bar
    // closes on the resume, not now().
    expect(byId["tools-rs"]?.endedAt).toBe(base + 10000);
    expect(byId["wa-inner"]?.endedAt).toBe(base + 10000);
    expect(byId["wa-outer"]?.endedAt).toBe(base + 10000);
  });

  it("does not close waiting chain wrappers on other threads", async () => {
    await seedThread("t-mine-chain");
    await seedThread("t-other-chain");
    await bulkInsertSpans([
      makeSpan({
        span_id: "other-chain",
        kind: "chain",
        name: "RunnableSequence",
        status: "waiting",
        ended_at: null,
        meta: { langgraph_thread_id: "t-other-chain" },
      }),
    ]);
    await bulkInsertSpans([
      makeSpan({
        span_id: "tool-mine",
        kind: "tool",
        name: "ask_location",
        meta: { langgraph_thread_id: "t-mine-chain" },
      }),
    ]);
    const [row] = await db
      .select()
      .from(observabilitySpans)
      .where(eq(observabilitySpans.spanId, "other-chain"));
    expect(row.status).toBe("waiting");
    expect(row.endedAt).toBeNull();
  });
});

describe("deleteSpansOlderThan (retention cron helper)", () => {
  it("removes rows whose created_at is older than the cutoff", async () => {
    await seedThread("t-old");
    await seedThread("t-new");
    await bulkInsertSpans([makeSpan({ span_id: "old", meta: { langgraph_thread_id: "t-old" } })]);
    // Manually backdate the row's created_at past the cutoff.
    await db
      .update(observabilitySpans)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(observabilitySpans.spanId, "old"));
    await bulkInsertSpans([makeSpan({ span_id: "new", meta: { langgraph_thread_id: "t-new" } })]);
    const removed = await deleteSpansOlderThan(30);
    expect(removed).toBe(1);
    const remaining = await db.select().from(observabilitySpans);
    expect(remaining.map((r) => r.spanId)).toEqual(["new"]);
  });
});
