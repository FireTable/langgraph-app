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

  it("throws on payload containing api_key (FR-009)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", openai_api_key: "sk-leak" },
    });
    await expect(bulkInsertSpans([span])).rejects.toThrow(/forbidden sensitive field/);
  });

  it("throws on payload containing baseURL (FR-009)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", baseURL: "https://internal-proxy" },
    });
    await expect(bulkInsertSpans([span])).rejects.toThrow(/forbidden sensitive field/);
  });

  it("throws on payload containing a Bearer token value (FR-009)", async () => {
    await seedThread("t-1");
    const span = makeSpan({
      meta: { langgraph_thread_id: "t-1", header: "Bearer abcdef" },
    });
    await expect(bulkInsertSpans([span])).rejects.toThrow(/forbidden sensitive field/);
  });

  it("throws when the span has no thread_id in meta", async () => {
    const span = makeSpan({ meta: { langgraph_node: "agent" } });
    // ponytail: threadIdOf accepts both `meta.thread_id` (LC v1.x) and
    // `meta.langgraph_thread_id` (older LC). Neither present → throw.
    await expect(bulkInsertSpans([span])).rejects.toThrow(/thread_id/);
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
