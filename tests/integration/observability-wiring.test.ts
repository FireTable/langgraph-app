import "@/tests/helpers/session";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// ponytail: see tests/api/threads/observability.test.ts for the why —
// bulkInsertSpans → backfillParentMessageIds hits
// langGraphClient.threads.getState, which hangs in CI without a dev
// server. Stub the HTTP call so the wiring test stays fast + deterministic.
vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    threads: {
      getState: async () => ({ values: { messages: [] } }),
      create: async () => ({}),
    },
    runs: { create: async () => ({ run_id: "test" }) },
  },
}));
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { observabilitySpans } from "@/lib/observability/schema";
import { bulkInsertSpans, getSpansByThreadId } from "@/lib/observability/queries";
import { ensureTestUser, TEST_USER, cleanupUsers } from "@/tests/helpers/auth";

beforeAll(async () => {
  await ensureTestUser();
  await db.delete(observabilitySpans).where(eq(observabilitySpans.threadId, "t-wiring-probe"));
  await db.delete(threads).where(eq(threads.id, "t-wiring-probe"));
  await db.insert(threads).values({
    id: "t-wiring-probe",
    userId: TEST_USER.id,
    title: "probe",
  });
});

afterAll(async () => {
  await db.delete(observabilitySpans).where(eq(observabilitySpans.threadId, "t-wiring-probe"));
  await db.delete(threads).where(eq(threads.id, "t-wiring-probe"));
  await cleanupUsers();
});

describe("observability wiring — bulkInsert against live DB", () => {
  // ponytail: the wiring layer's only runtime invariant is that a
  // CapturedSpan-shaped object reaches DB and is read back intact.
  // Every other step in the chain (LC callbacks, our handler, the
  // FORBIDDEN regex, the ON CONFLICT clause) is exercised by the
  // existing tests; this integration case proves the persistence
  // path end-to-end through db/client.
  it("bulkInsertSpans → observability_spans → getSpansByThreadId", async () => {
    const span = {
      span_id: `probe-${Date.now()}`,
      parent_span_id: null,
      name: "probe-chain",
      kind: "chain" as const,
      status: "completed" as const,
      started_at: Date.now() - 50,
      ended_at: Date.now(),
      input: { hello: "world" },
      output: { result: "ok" },
      usage: null,
      error: null,
      meta: {
        langgraph_thread_id: "t-wiring-probe",
        langgraph_node: "probe",
        langgraph_checkpoint_ns: "t-wiring-probe",
        langgraph_step: 1,
      },
    };
    const inserted = await bulkInsertSpans([span]);
    expect(inserted).toBe(1);

    const rows = await getSpansByThreadId("t-wiring-probe");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta.langgraph_thread_id).toBe("t-wiring-probe");
    expect(rows[0]?.kind).toBe("chain");
    expect(rows[0]?.status).toBe("completed");
  });

  it("ON CONFLICT DO NOTHING makes a duplicate insert a no-op", async () => {
    const spanId = `probe-dup-${Date.now()}`;
    const span = {
      span_id: spanId,
      parent_span_id: null,
      name: "probe-chain",
      kind: "chain" as const,
      status: "completed" as const,
      started_at: Date.now() - 50,
      ended_at: Date.now(),
      input: null,
      output: null,
      usage: null,
      error: null,
      meta: { langgraph_thread_id: "t-wiring-probe" },
    };
    expect(await bulkInsertSpans([span])).toBe(1);
    // Second insert with same span_id — handler re-fires when an outer
    // chain closes after the inner did.
    expect(await bulkInsertSpans([span])).toBe(0);
  });
});
