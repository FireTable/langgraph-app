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
      sql`INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding, entities)
          VALUES
            ('c-old-1', 'd-1', 0, 'old chunk 1', ${embeddingLiteral}, '[]'::jsonb),
            ('c-old-2', 'd-1', 1, 'old chunk 2', ${embeddingLiteral}, '[]'::jsonb)`,
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
});
