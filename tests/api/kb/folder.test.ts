import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments, kbChunk, kbDocument, kbFolder, user } from "@/db/schema";
import { setCurrentUser } from "@/tests/helpers/session";

import { DELETE, GET } from "@/app/api/kb/folders/[id]/route";

// ponytail: GET /api/kb/folders/[id] returns the folder shape plus the
// content + entities + status of every chunk across every doc in the
// folder. Auth-gated by withAuth; 404 for missing or other-user folders.

const USER_A = { id: "user-a", email: "a@x" };
const USER_B = { id: "user-b", email: "b@x" };

async function seedUser(u: { id: string; email: string }) {
  await db
    .insert(user)
    .values({ id: u.id, email: u.email, name: "Test User" })
    .onConflictDoNothing();
}

async function seedFolderRow(userId: string, id: string, name = "Folder") {
  await db.insert(kbFolder).values({ id, userId, name });
}

async function seedDocRow(userId: string, folderId: string, id: string, title = "doc.pdf") {
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

beforeAll(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
});

beforeEach(async () => {
  await db.delete(kbChunk);
  await db.delete(kbDocument);
  await db.delete(kbFolder);
  await db.delete(attachments);
  await db.delete(user).where(eq(user.id, USER_A.id));
  await db.delete(user).where(eq(user.id, USER_B.id));
  await seedUser(USER_A);
  await seedUser(USER_B);
  setCurrentUser(USER_A);
});

afterAll(() => {
  setCurrentUser(null);
});

function newRequest(id: string): Request {
  return new Request(`http://localhost/api/kb/folders/${id}`, { method: "GET" });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/kb/folders/[id]", () => {
  it("returns 401 when no session", async () => {
    setCurrentUser(null);
    await seedFolderRow(USER_A.id, "f-1");
    const res = await GET(newRequest("f-1"), ctxFor("f-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown folder id (no existence leak)", async () => {
    setCurrentUser(USER_A);
    const res = await GET(newRequest("f-nope"), ctxFor("f-nope"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the folder belongs to another user", async () => {
    await seedFolderRow(USER_B.id, "f-b", "Other user's folder");
    const res = await GET(newRequest("f-b"), ctxFor("f-b"));
    expect(res.status).toBe(404);
  });

  it("returns the folder shape + empty chunks array when no docs in folder", async () => {
    setCurrentUser(USER_A);
    await seedFolderRow(USER_A.id, "f-1", "Empty");
    const res = await GET(newRequest("f-1"), ctxFor("f-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folder.name).toBe("Empty");
    expect(body.chunks).toEqual([]);
  });

  it("returns content + entities + status across every doc in the folder", async () => {
    setCurrentUser(USER_A);
    await seedFolderRow(USER_A.id, "f-1", "Graph A");
    await seedDocRow(USER_A.id, "f-1", "d-a", "alpha.pdf");
    await seedDocRow(USER_A.id, "f-1", "d-b", "beta.pdf");

    // ponytail: cover the field shape on real DB rows. We don't need
    // to populate themes / relationships here — findKbChunksByFolderId
    // returns whatever the column holds.
    const embedLiteral = `'[${Array.from({ length: 1024 }, () => "0").join(",")}]'::vector`;
    await db.execute(
      // language=postgresql
      `INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding)
       VALUES (
         'c-a0', 'd-a', 0, 'alpha intro', ${embedLiteral}
       )` as never,
    );
    await db.execute(
      // language=postgresql
      `INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding)
       VALUES (
         'c-b0', 'd-b', 0, 'beta intro', ${embedLiteral}
       )` as never,
    );

    const res = await GET(newRequest("f-1"), ctxFor("f-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folder.name).toBe("Graph A");
    expect(body.chunks).toHaveLength(2);
    const contents = body.chunks.map((c: { content: string }) => c.content).sort();
    expect(contents).toEqual(["alpha intro", "beta intro"]);
    expect(body.chunks).toHaveLength(2);
  });
});

describe("DELETE /api/kb/folders/[id]", () => {
  it("returns 409 NON_EMPTY when folder has docs and deleteAll is false", async () => {
    setCurrentUser(USER_A);
    await seedFolderRow(USER_A.id, "f-1", "Folder 1");
    await seedDocRow(USER_A.id, "f-1", "d-1", "doc1.pdf");

    const req = new Request("http://localhost/api/kb/folders/f-1", { method: "DELETE" });
    const res = await DELETE(req, ctxFor("f-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("NON_EMPTY");
    expect(body.docCount).toBe(1);
  });

  it("deletes folder and all its documents when deleteAll=true", async () => {
    setCurrentUser(USER_A);
    await seedFolderRow(USER_A.id, "f-1", "Folder 1");
    await seedDocRow(USER_A.id, "f-1", "d-1", "doc1.pdf");
    await seedDocRow(USER_A.id, "f-1", "d-2", "doc2.pdf");

    const req = new Request("http://localhost/api/kb/folders/f-1?deleteAll=true", {
      method: "DELETE",
    });
    const res = await DELETE(req, ctxFor("f-1"));
    expect(res.status).toBe(204);

    const remainingDocs = await db.query.kbDocument.findMany({
      where: eq(kbDocument.folderId, "f-1"),
    });
    expect(remainingDocs).toHaveLength(0);

    const folderRow = await db.query.kbFolder.findFirst({
      where: eq(kbFolder.id, "f-1"),
    });
    expect(folderRow).toBeUndefined();
  });
});
