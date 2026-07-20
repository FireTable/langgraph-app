import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { observabilitySpans } from "@/lib/observability/schema";
import { threads } from "@/lib/threads/schema";
import { kbDocument, kbFolder } from "@/lib/kb/schema";
import { ensureTestUser, TEST_USER } from "@/tests/helpers/auth";
import { getSpansByThreadId } from "@/lib/observability/queries";

// ponytail: integration test for the KB observability chain end-to-end.
// Verifies that after prepareKBDataNode-style upsert + fake span writes:
//   1. the threads row exists with kind='kb' (NOT 'chat') so the
//      sidebar filter hides it
//   2. the observability_spans thread_id matches the docId-derived
//      threadId (strip d- prefix)
//   3. getSpansByThreadId with parentMessageId returns only that run's
//      spans, which is exactly what the per-turn panel route queries

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_ID = `d-${randomUUID()}`;
const THREAD_ID = DOC_ID.replace(/^d-/, "");
const TRACE_ID_1 = randomUUID();
const TRACE_ID_2 = randomUUID();

async function seedFixtures() {
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });
  await db.insert(kbDocument).values({
    id: DOC_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "roundtrip.pdf",
    contentType: "application/pdf",
    contentHash: `hash-${randomUUID()}`,
    status: "success",
  });
}

beforeEach(async () => {
  await ensureTestUser();
  await db.delete(observabilitySpans).where(eq(observabilitySpans.threadId, THREAD_ID));
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  await db.delete(threads).where(eq(threads.id, THREAD_ID));
  await seedFixtures();
});

afterEach(async () => {
  await db.delete(observabilitySpans).where(eq(observabilitySpans.threadId, THREAD_ID));
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  await db.delete(threads).where(eq(threads.id, THREAD_ID));
});

async function fakeSpan(threadId: string, pmid: string, name: string, startedAt: number) {
  await db.insert(observabilitySpans).values({
    spanId: randomUUID(),
    threadId,
    parentSpanId: null,
    name,
    kind: "llm",
    status: "completed",
    startedAt,
    endedAt: startedAt + 1000,
    meta: { parent_message_id: pmid } as never,
    parentMessageId: pmid,
  } as never);
}

describe("kb-observability roundtrip", () => {
  it("preparing a kb run creates a threads row with kind='kb' (sidebar-hidden)", async () => {
    // simulate prepareKBDataNode's upsert
    await db
      .insert(threads)
      .values({ id: THREAD_ID, userId: TEST_USER.id, kind: "kb" })
      .onConflictDoNothing({ target: threads.id });

    const [row] = await db.select().from(threads).where(eq(threads.id, THREAD_ID));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("kb");
    // status defaults to 'regular' — sidebar hides via kind filter, not status
    expect(row!.status).toBe("regular");
  });

  it("reuses an existing chat thread row when called with that id (chat path safety)", async () => {
    // simulate chat path: thread row already exists with kind='chat'
    await db.insert(threads).values({
      id: THREAD_ID,
      userId: TEST_USER.id,
      kind: "chat",
      title: "Chat conversation",
    });

    // prepareKBDataNode-style upsert with kind='kb'
    await db
      .insert(threads)
      .values({ id: THREAD_ID, userId: TEST_USER.id, kind: "kb" })
      .onConflictDoNothing({ target: threads.id });

    const [row] = await db.select().from(threads).where(eq(threads.id, THREAD_ID));
    expect(row!.kind).toBe("chat"); // ON CONFLICT DO NOTHING preserves chat kind
    expect(row!.title).toBe("Chat conversation");
  });

  it("spans written by capturingHandler are keyed correctly + queryable per run", async () => {
    // Set up thread row + two runs worth of spans (different traceIds = different runs)
    await db
      .insert(threads)
      .values({ id: THREAD_ID, userId: TEST_USER.id, kind: "kb" })
      .onConflictDoNothing({ target: threads.id });

    const baseTs = Date.now();
    await fakeSpan(THREAD_ID, TRACE_ID_1, "run1-llm-call-1", baseTs);
    await fakeSpan(THREAD_ID, TRACE_ID_1, "run1-llm-call-2", baseTs + 100);
    await fakeSpan(THREAD_ID, TRACE_ID_2, "run2-llm-call-1", baseTs + 10000);
    await fakeSpan(THREAD_ID, TRACE_ID_2, "run2-llm-call-2", baseTs + 10100);

    // Per-thread-wide view: all 4 spans
    const all = await getSpansByThreadId(THREAD_ID);
    expect(all).toHaveLength(4);

    // Per-turn view (what the panel route queries): only run 1's 2 spans
    const run1 = await getSpansByThreadId(THREAD_ID, { parentMessageId: TRACE_ID_1 });
    expect(run1).toHaveLength(2);
    expect(run1.every((s) => s.name.startsWith("run1-"))).toBe(true);

    const run2 = await getSpansByThreadId(THREAD_ID, { parentMessageId: TRACE_ID_2 });
    expect(run2).toHaveLength(2);
    expect(run2.every((s) => s.name.startsWith("run2-"))).toBe(true);
  });
});
