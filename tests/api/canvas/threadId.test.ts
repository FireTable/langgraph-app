import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { user as userTable } from "@/lib/auth/schema";
import { canvasSnapshots } from "@/lib/canvas/schema";
import { GET, PUT, DELETE } from "@/app/api/canvas/[threadId]/route";
import { upsertCanvasSnapshot } from "@/lib/canvas/queries";
import { setCurrentUser } from "@/tests/helpers/session";
import { ensureTestUser, makeUser, TEST_USER } from "@/tests/helpers/auth";

const owner = TEST_USER.id;
let threadId: string;
const extraUserIds: string[] = [];

beforeEach(async () => {
  // ponytail: ensureTestUser is module-gated; after another file's
  // cleanupUsers() the test owner can vanish. Re-insert unconditionally
  // so the threads.user_id FK is satisfied.
  await ensureTestUser();
  await db
    .insert(userTable)
    .values({ id: owner, email: TEST_USER.email, name: "Test Owner" })
    .onConflictDoNothing();
  await db.delete(canvasSnapshots);
  await db.delete(threads).where(eq(threads.userId, owner));
  threadId = `t-${randomUUID()}`;
  await db.insert(threads).values({ id: threadId, userId: owner, title: "test", kind: "chat" });
  setCurrentUser({ id: owner, email: TEST_USER.email });
});

afterEach(async () => {
  await db.delete(canvasSnapshots);
  await db.delete(threads).where(eq(threads.userId, owner));
  // ponytail: track and remove extra users; do NOT call cleanupUsers()
  // here — it nukes TEST_USER and breaks the next beforeEach.
  if (extraUserIds.length) {
    for (const id of extraUserIds) await db.delete(userTable).where(eq(userTable.id, id));
    extraUserIds.length = 0;
  }
  setCurrentUser(null);
});

const CTX = (id: string) => ({ params: Promise.resolve({ threadId: id }) });

function jsonPut(body: unknown): Request {
  return new Request("http://localhost/api/canvas/" + threadId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/canvas/[threadId]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(401);
  });

  it("returns 200 + empty document when no snapshot exists for an owned thread", async () => {
    const res = await GET(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threadId).toBe(threadId);
    expect(body.document).toEqual({ nodes: [], edges: [] });
  });

  it("returns the saved snapshot", async () => {
    await upsertCanvasSnapshot({
      threadId,
      userId: owner,
      document: {
        nodes: [
          {
            id: "n1",
            position: { x: 0, y: 0 },
            data: { type: "generate", fields: { text: "hi" } },
          },
        ],
        edges: [],
      },
    });
    const res = await GET(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threadId).toBe(threadId);
    expect(body.document).toEqual({
      nodes: [
        { id: "n1", position: { x: 0, y: 0 }, data: { type: "generate", fields: { text: "hi" } } },
      ],
      edges: [],
    });
  });

  it("returns 404 for a thread owned by another user", async () => {
    const other = await makeUser();
    extraUserIds.push(other.id);
    const otherId = `t-${randomUUID()}`;
    await db
      .insert(threads)
      .values({ id: otherId, userId: other.id, title: "theirs", kind: "chat" });
    await upsertCanvasSnapshot({
      threadId: otherId,
      userId: other.id,
      document: { "shape:b": { id: "shape:b" } },
    });
    const res = await GET(new Request("http://localhost"), CTX(otherId));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/canvas/[threadId]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await PUT(jsonPut({ document: {} }), CTX(threadId));
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed body (missing document)", async () => {
    const res = await PUT(jsonPut({}), CTX(threadId));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body (string)", async () => {
    const res = await PUT(jsonPut({ document: "nope" }), CTX(threadId));
    expect(res.status).toBe(400);
  });

  it("creates the row on first save", async () => {
    const doc = {
      nodes: [{ id: "n1", position: { x: 0, y: 0 }, data: { type: "generate", fields: {} } }],
      edges: [],
    };
    const res = await PUT(jsonPut({ document: doc }), CTX(threadId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document).toEqual(doc);
  });

  it("upserts on second save (last write wins)", async () => {
    const doc1 = {
      nodes: [{ id: "n1", position: { x: 0, y: 0 }, data: { type: "generate", fields: {} } }],
      edges: [],
    };
    const doc2 = {
      nodes: [
        { id: "n2", position: { x: 10, y: 10 }, data: { type: "preview", fields: { url: "x" } } },
      ],
      edges: [],
    };
    await PUT(jsonPut({ document: doc1 }), CTX(threadId));
    const res = await PUT(jsonPut({ document: doc2 }), CTX(threadId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document).toEqual(doc2);
  });

  it("returns 404 for a thread owned by another user", async () => {
    const other = await makeUser();
    extraUserIds.push(other.id);
    const otherId = `t-${randomUUID()}`;
    await db
      .insert(threads)
      .values({ id: otherId, userId: other.id, title: "theirs", kind: "chat" });
    const res = await PUT(jsonPut({ document: {} }), CTX(otherId));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/canvas/[threadId]", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await DELETE(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(401);
  });

  it("returns 204 and removes the row", async () => {
    await upsertCanvasSnapshot({ threadId, userId: owner, document: {} });
    const res = await DELETE(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(204);
    // ponytail: after delete the row is gone but the thread is still
    // owned by us, so GET returns 200 + empty document (the canvas
    // editor treats that as "no nodes yet"); see route.ts.
    const after = await GET(new Request("http://localhost"), CTX(threadId));
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.document).toEqual({ nodes: [], edges: [] });
  });

  it("returns 204 even when no row exists (idempotent)", async () => {
    const res = await DELETE(new Request("http://localhost"), CTX(threadId));
    expect(res.status).toBe(204);
  });
});
