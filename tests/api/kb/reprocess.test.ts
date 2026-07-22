// Mock the shared SDK Client so we can assert what fireIngestionRun
// dispatches without standing up a real langgraphjs dev server.
const { mockThreadsCreate, mockRunsCreate } = vi.hoisted(() => ({
  mockThreadsCreate: vi.fn<(args: { threadId: string }) => Promise<{ thread_id: string }>>(
    async (args) => ({ thread_id: args.threadId }),
  ),
  mockRunsCreate: vi.fn<
    (
      threadId: string,
      assistantId: string,
      payload: { metadata: { source: string; docId: string; title: string } },
    ) => Promise<{ run_id: string }>
  >(async () => ({ run_id: "ignored" })),
}));
vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    threads: { create: mockThreadsCreate },
    runs: { create: mockRunsCreate },
  },
}));

import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and as aAnd, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments, kbChunk, kbDocument, kbFolder, user } from "@/db/schema";
import { setCurrentUser } from "@/tests/helpers/session";

import { POST } from "@/app/api/kb/documents/[id]/reprocess/route";

// ponytail: 1024-dim zero vector literal. pgvector requires the
// bracket-wrapped form — `'[0,0,...]'::vector`, not bare comma-list.
const embeddingLiteral = sql.raw(
  `'[${Array.from({ length: 1024 }, () => "0").join(",")}]'::vector`,
);

const USER_A = { id: "user-a", email: "a@x" };
const USER_B = { id: "user-b", email: "b@x" };

const ctxModel = (id: string) => ({ params: Promise.resolve({ id }) });

function newRequest(): Request {
  return new Request("http://localhost", { method: "POST" });
}

beforeAll(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
});

async function seedUser(u: { id: string; email: string }) {
  await db
    .insert(user)
    .values({ id: u.id, email: u.email, name: "Test User" })
    .onConflictDoNothing();
}

beforeEach(async () => {
  await db.delete(kbChunk);
  await db.delete(kbDocument);
  await db.delete(kbFolder);
  await db.delete(attachments);
  await db.delete(user).where(eq(user.id, USER_A.id));
  await db.delete(user).where(eq(user.id, USER_B.id));
  await seedUser(USER_A);
  await seedUser(USER_B);
  mockThreadsCreate.mockClear();
  mockRunsCreate.mockClear();
  setCurrentUser(USER_A);
});

afterAll(() => {
  setCurrentUser(null);
});

async function seedFolder(userId: string, folderId = "f-1") {
  await db.insert(kbFolder).values({
    id: folderId,
    userId,
    name: "Attachments",
  });
}

async function seedAttachment(userId: string) {
  const attId = "att-1";
  await db.insert(attachments).values({
    id: attId,
    userId,
    r2Key: "kb-tmp/page.png",
    contentType: "application/pdf",
    name: "resume.pdf",
    sizeBytes: 1024,
    status: "uploaded",
  });
  return attId;
}

async function seedDoc(opts: {
  userId: string;
  docId?: string;
  status?: "pending" | "parsing" | "success" | "failed";
  errorMessage?: string | null;
}) {
  const docId = opts.docId ?? "d-1";
  await db.insert(kbDocument).values({
    id: docId,
    userId: opts.userId,
    folderId: "f-1",
    attachmentId: "att-1",
    title: "resume.pdf",
    contentType: "application/pdf",
    contentHash: "h-1",
    status: opts.status ?? "success",
    errorMessage: opts.errorMessage ?? null,
  });
  return docId;
}

describe("POST /api/kb/documents/[id]/reprocess", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await POST(newRequest(), ctxModel("d-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the doc does not belong to the caller", async () => {
    await seedFolder(USER_B.id);
    await seedAttachment(USER_B.id);
    await seedDoc({ userId: USER_B.id, status: "failed", errorMessage: "OCR error" });
    const res = await POST(newRequest(), ctxModel("d-1"));
    // ponytail: no existence leak across users — same 404 as if the
    // row didn't exist at all.
    expect(res.status).toBe(404);
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when the doc id does not exist at all", async () => {
    const res = await POST(newRequest(), ctxModel("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the doc is already parsing", async () => {
    await seedFolder(USER_A.id);
    await seedAttachment(USER_A.id);
    await seedDoc({ userId: USER_A.id, status: "parsing" });
    const res = await POST(newRequest(), ctxModel("d-1"));
    expect(res.status).toBe(409);
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("returns 409 when the doc is already pending", async () => {
    await seedFolder(USER_A.id);
    await seedAttachment(USER_A.id);
    await seedDoc({ userId: USER_A.id, status: "pending" });
    const res = await POST(newRequest(), ctxModel("d-1"));
    expect(res.status).toBe(409);
  });

  it("flips status='pending' + clears errorMessage, deletes chunks, fires kbAgent with source='kb-reprocess'", async () => {
    await seedFolder(USER_A.id);
    await seedAttachment(USER_A.id);
    await seedDoc({ userId: USER_A.id, status: "failed", errorMessage: "OCR timeout" });

    // ponytail: raw SQL seeds for `kbChunk` so we don't fight pgvector's
    // bulk-insert type. `tsv` is GENERATED ALWAYS AS, can't be inserted
    // directly. The reprocess route only needs chunks to exist so the
    // deletion can be observed — content + embedding shapes are
    // irrelevant.
    await db.execute(
      sql`INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding, status)
          VALUES
            ('c-old-1', 'd-1', 0, 'old chunk 1', ${embeddingLiteral}, 'success'),
            ('c-old-2', 'd-1', 1, 'old chunk 2', ${embeddingLiteral}, 'success')`,
    );

    const res = await POST(newRequest(), ctxModel("d-1"));
    expect(res.status).toBe(202);

    const row = await db.query.kbDocument.findFirst({
      where: aAnd(eq(kbDocument.id, "d-1"), eq(kbDocument.userId, USER_A.id)),
    });
    expect(row?.status).toBe("pending");
    expect(row?.errorMessage).toBeNull();

    const remaining = await db.query.kbChunk.findMany({
      where: eq(kbChunk.documentId, "d-1"),
    });
    expect(remaining).toHaveLength(0);

    expect(mockRunsCreate).toHaveBeenCalledTimes(1);
    const [_threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
    expect(assistantId).toBe("kbAgent");
    expect(payload.metadata.source).toBe("kb-reprocess");
    expect(payload.metadata.docId).toBe("d-1");
    void _threadId;
  });

  // ponytail: retryFailedChunks mode — only retry chunks where
  // status='failed'. Successful chunks are kept verbatim. The route
  // UPDATEs failed chunks in place (status='parsing', clear
  // error_message + entities) so the IIFE inside generateChunkEmbedNode
  // can find them by status='parsing' and re-run entity-extract. No
  // DELETE — chunk.id, ordinal, embedding, and content all stay put
  // (embedding API is deterministic; the old vector is still valid).
  it("retryFailedChunks: marks failed chunks 'parsing' in place, keeps all 4 chunks, leaves doc.status='success'", async () => {
    await seedFolder(USER_A.id);
    await seedAttachment(USER_A.id);
    await seedDoc({ userId: USER_A.id, status: "success" });

    await db.execute(
      sql`INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding, status, error_message)
          VALUES
            ('c-ok-1', 'd-1', 0, 'good chunk 1', ${embeddingLiteral}, 'success', NULL),
            ('c-ok-2', 'd-1', 1, 'good chunk 2', ${embeddingLiteral}, 'success', NULL),
            ('c-bad-1', 'd-1', 2, 'bad chunk 1', ${embeddingLiteral}, 'failed', 'embed timeout'),
            ('c-bad-2', 'd-1', 3, 'bad chunk 2', ${embeddingLiteral}, 'failed', 'llm 502')`,
    );

    const req = new Request(
      "http://localhost/api/kb/documents/d-1/reprocess?mode=retryFailedChunks",
      {
        method: "POST",
      },
    );
    const res = await POST(req, ctxModel("d-1"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ docId: "d-1", mode: "retryFailedChunks" });

    // ponytail: doc.status STAYS 'success' the whole time —
    // flipping it to 'parsing' would make the live UI badge flicker
    // and pollute the user's mental model ("did my doc break again?").
    // The chunk-level "Indexed N/M" rollup is the progress signal;
    // doc.status reflects the OCR + chunk pipeline at a macro level,
    // and that hasn't changed.
    const row = await db.query.kbDocument.findFirst({
      where: aAnd(eq(kbDocument.id, "d-1"), eq(kbDocument.userId, USER_A.id)),
    });
    expect(row?.status).toBe("success");

    // ponytail: every chunk row survives — failed ones are marked
    // 'parsing' with entities/error_message cleared so the IIFE
    // can re-run entity-extract and UPDATE the row back to
    // success/failed. id/ordinal/embedding/content are all
    // preserved verbatim.
    const remaining = await db.query.kbChunk.findMany({
      where: eq(kbChunk.documentId, "d-1"),
      orderBy: (c, { asc }) => [asc(c.ordinal)],
    });
    expect(remaining).toHaveLength(4);

    const byId = new Map(remaining.map((c) => [c.id, c]));
    // survivor chunks: completely untouched
    expect(byId.get("c-ok-1")?.status).toBe("success");
    expect(byId.get("c-ok-2")?.status).toBe("success");
    // failed chunks: in-place reset, ready for entity-extract.
    // ponytail: ALL three LLM-derived fields get cleared on the
    // mark (entities, relationships, themes) — the next
    // entity-extract call rewrites all of them, so leaving any of
    // them stale would surface misleading graph nodes / themes in
    // the doc-detail panel until the LLM lands.
    const bad1 = byId.get("c-bad-1");
    expect(bad1?.status).toBe("parsing");
    expect(bad1?.errorMessage).toBeNull();
    const bad2 = byId.get("c-bad-2");
    expect(bad2?.status).toBe("parsing");
    expect(bad2?.errorMessage).toBeNull();

    expect(mockRunsCreate).toHaveBeenCalledTimes(1);
    const [_threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
    expect(assistantId).toBe("kbAgent");
    expect(payload.metadata.source).toBe("kb-reprocess");
    expect(payload.metadata.docId).toBe("d-1");
    void _threadId;
  });

  it("retryFailedChunks: returns 409 NOT_READY when doc.status is not 'success'", async () => {
    // ponytail: chunks must already be embedded once (doc reached
    // a terminal status) before retryFailedChunks makes sense. If
    // OCR hasn't finished or doc failed at OCR stage, the user
    // should pick 'Full re-run' or 'Retry failed pages' instead.
    await seedFolder(USER_A.id);
    await seedAttachment(USER_A.id);
    await seedDoc({ userId: USER_A.id, status: "failed", errorMessage: "OCR error" });

    const req = new Request(
      "http://localhost/api/kb/documents/d-1/reprocess?mode=retryFailedChunks",
      {
        method: "POST",
      },
    );
    const res = await POST(req, ctxModel("d-1"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("NOT_READY");

    // ponytail: failed dispatch would be the WORST UX — flip
    // nothing and silently ignore.
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });
});
