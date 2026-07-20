import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { kbDocument, kbFolder, kbObservability, user } from "@/db/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { GET } from "@/app/api/kb/documents/[id]/observability/route";

// ponytail: GET /api/kb/documents/[id]/observability — Settings → KB
// → doc row → Activity icon → popover data source. Reads the
// kb_observability table directly (no SDK call), so a chat-uploaded
// doc shows the chat thread's run alongside any standalone ones.

const USER_A = { id: "user-a-observability", email: "a-observability@x" };
const USER_B = { id: "user-b-observability", email: "b-observability@x" };

beforeAll(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
});

async function seedUser(u: { id: string; email: string }) {
  await db
    .insert(user)
    .values({ id: u.id, email: u.email, name: "Test User" })
    .onConflictDoNothing();
}

async function seedFolder(userId: string, id: string, name: string) {
  await db.insert(kbFolder).values({ id, userId, name });
}

async function seedDoc(userId: string, folderId: string, id: string, title: string) {
  await db.insert(kbDocument).values({
    id,
    userId,
    folderId,
    attachmentId: null,
    title,
    contentType: "application/pdf",
    contentHash: `h-${id}`,
    status: "success",
  });
}

async function seedObservabilityRow(row: {
  docId: string;
  threadId: string;
  parentMessageId: string;
  runId?: string | null;
  source: "kb-upload" | "kb-reprocess" | "chat";
  mode: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";
  createdAt?: Date;
}) {
  await db.insert(kbObservability).values({
    docId: row.docId,
    threadId: row.threadId,
    parentMessageId: row.parentMessageId,
    runId: row.runId ?? null,
    source: row.source,
    mode: row.mode,
    createdAt: row.createdAt,
  });
}

beforeEach(async () => {
  await db.delete(kbObservability);
  await db.delete(kbDocument);
  await db.delete(kbFolder);
  await seedUser(USER_A);
  await seedUser(USER_B);
});

afterAll(async () => {
  await db.delete(kbObservability);
  await db.delete(kbDocument);
  await db.delete(kbFolder);
});

describe("GET /api/kb/documents/[id]/observability", () => {
  it("401 when not logged in", async () => {
    setCurrentUser(null);
    const req = new Request("http://localhost/api/kb/documents/d-abc/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-abc" }) });
    expect(res.status).toBe(401);
  });

  it("404 when doc doesn't belong to the user (cross-user 404, not 403)", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_B.id, "f-b", "Other folder");
    await seedDoc(USER_B.id, "f-b", "d-b-1", "Other user's doc");
    const req = new Request("http://localhost/api/kb/documents/d-b-1/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-b-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns runs from kb_observability, newest first", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-a", "My folder");
    await seedDoc(USER_A.id, "f-a", "d-abc", "Mine");
    await seedObservabilityRow({
      docId: "d-abc",
      threadId: "abc",
      parentMessageId: "msg-1",
      runId: "run-1",
      source: "kb-upload",
      mode: "full",
      createdAt: new Date("2026-07-20T00:00:00Z"),
    });
    await seedObservabilityRow({
      docId: "d-abc",
      threadId: "abc",
      parentMessageId: "msg-2",
      runId: null,
      source: "kb-reprocess",
      mode: "chunksOnly",
      createdAt: new Date("2026-07-20T01:00:00Z"),
    });
    const req = new Request("http://localhost/api/kb/documents/d-abc/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-abc" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      doc_id: string;
      runs: Array<{
        runId: string | null;
        threadId: string;
        parentMessageId: string;
        source: string;
        mode: string;
        createdAt: string;
      }>;
    };
    expect(body.doc_id).toBe("d-abc");
    expect(body.runs).toHaveLength(2);
    // newest first
    expect(body.runs[0].source).toBe("kb-reprocess");
    expect(body.runs[0].parentMessageId).toBe("msg-2");
    expect(body.runs[0].runId).toBeNull();
    expect(body.runs[1].source).toBe("kb-upload");
    expect(body.runs[1].parentMessageId).toBe("msg-1");
    expect(body.runs[1].runId).toBe("run-1");
    // every row carries its own threadId (per-row, not top-level)
    expect(body.runs[0].threadId).toBe("abc");
    expect(body.runs[1].threadId).toBe("abc");
  });

  it("merges chat-thread runs with standalone runs in one list", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-a", "My folder");
    await seedDoc(USER_A.id, "f-a", "d-chat", "Chat-uploaded");
    await seedObservabilityRow({
      docId: "d-chat",
      threadId: "abc",
      parentMessageId: "msg-standalone",
      source: "kb-upload",
      mode: "full",
      createdAt: new Date("2026-07-20T00:00:00Z"),
    });
    // chat-thread row lives on a DIFFERENT threadId — this is the
    // case the old runs.list(threadId) path couldn't see.
    await seedObservabilityRow({
      docId: "d-chat",
      threadId: "chat-thread-xyz",
      parentMessageId: "msg-chat",
      source: "chat",
      mode: "full",
      createdAt: new Date("2026-07-20T01:00:00Z"),
    });
    const req = new Request("http://localhost/api/kb/documents/d-chat/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-chat" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ threadId: string; source: string }>;
    };
    expect(body.runs).toHaveLength(2);
    const threads = body.runs.map((r) => r.threadId).sort();
    expect(threads).toEqual(["abc", "chat-thread-xyz"]);
    const sources = body.runs.map((r) => r.source).sort();
    expect(sources).toEqual(["chat", "kb-upload"]);
  });

  it("returns empty runs for a doc with no kb_observability rows", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-a", "My folder");
    await seedDoc(USER_A.id, "f-a", "d-empty", "Empty");
    const req = new Request("http://localhost/api/kb/documents/d-empty/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-empty" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("does not leak another user's kb_observability rows", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_B.id, "f-b", "Other folder");
    await seedDoc(USER_B.id, "f-b", "d-leak", "Other");
    await seedObservabilityRow({
      docId: "d-leak",
      threadId: "leak-thread",
      parentMessageId: "msg",
      source: "chat",
      mode: "full",
    });
    const req = new Request("http://localhost/api/kb/documents/d-leak/observability");
    const res = await GET(req, { params: Promise.resolve({ id: "d-leak" }) });
    // rule #9: 404, not 200-with-empty-array, to avoid existence leak
    expect(res.status).toBe(404);
  });
});
