import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments, kbDocument, kbEntity, kbFolder, kbRelationship, user } from "@/db/schema";
import { setCurrentUser } from "@/tests/helpers/session";

import { GET } from "@/app/api/kb/documents/[id]/route";

// ponytail: GET /api/kb/documents/[id] — Settings → KB doc detail (right
// pane). The previous leftJoin(kbEntity, kbRelationship) cartesian-
// multiplied both counts whenever a doc had rows in both tables; the
// single-table subquery rewrite below fixes that. P1 from Greptile on PR
// #47.

const USER_A = { id: "user-a", email: "a@x" };
const USER_B = { id: "user-b", email: "b@x" };

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

async function seedDoc(
  userId: string,
  folderId: string,
  id: string,
  title: string,
  status: "pending" | "parsing" | "success" | "failed" = "success",
) {
  await db.insert(kbDocument).values({
    id,
    userId,
    folderId,
    attachmentId: null,
    title,
    contentType: "application/pdf",
    contentHash: `h-${id}`,
    status,
  });
}

async function seedEntity(userId: string, documentId: string, id: string, name: string) {
  await db.insert(kbEntity).values({
    id,
    userId,
    documentId,
    name,
    type: "person",
    description: "",
  });
}

async function seedRelationship(
  userId: string,
  documentId: string,
  id: string,
  source: string,
  target: string,
) {
  await db.insert(kbRelationship).values({
    id,
    userId,
    documentId,
    source,
    target,
    relation: "knows",
    description: "",
  });
}

beforeEach(async () => {
  await db.delete(kbRelationship);
  await db.delete(kbEntity);
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
  return new Request(`http://localhost/api/kb/documents/${id}`, { method: "GET" });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/kb/documents/[id] — graph counts", () => {
  it("returns entityCount and relationshipCount = 0 for a doc with no graph rows", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-1", "Folder 1");
    await seedDoc(USER_A.id, "f-1", "d-1", "doc.pdf");

    const res = await GET(newRequest("d-1"), ctxFor("d-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc.entityCount).toBe(0);
    expect(body.doc.relationshipCount).toBe(0);
  });

  it("returns correct counts when both entities and relationships exist (no cartesian inflation)", async () => {
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-1", "Folder 1");
    await seedDoc(USER_A.id, "f-1", "d-1", "doc.pdf");

    // 3 entities + 2 relationships — the old leftJoin would have
    // cartesian'd into 6 rows and reported entityCount=6, relationshipCount=6.
    await seedEntity(USER_A.id, "d-1", "e-1", "Alice");
    await seedEntity(USER_A.id, "d-1", "e-2", "Bob");
    await seedEntity(USER_A.id, "d-1", "e-3", "Carol");
    await seedRelationship(USER_A.id, "d-1", "r-1", "Alice", "Bob");
    await seedRelationship(USER_A.id, "d-1", "r-2", "Bob", "Carol");

    const res = await GET(newRequest("d-1"), ctxFor("d-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc.entityCount).toBe(3);
    expect(body.doc.relationshipCount).toBe(2);
  });

  it("returns correct counts when only relationships exist (no entities)", async () => {
    // Old leftJoin starting from kbEntity with no entity rows would
    // return 0/0 (the from-table was empty). The single-table subquery
    // rewrite counts each independently.
    setCurrentUser(USER_A);
    await seedFolder(USER_A.id, "f-1", "Folder 1");
    await seedDoc(USER_A.id, "f-1", "d-1", "doc.pdf");
    await seedRelationship(USER_A.id, "d-1", "r-1", "Alice", "Bob");

    const res = await GET(newRequest("d-1"), ctxFor("d-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc.entityCount).toBe(0);
    expect(body.doc.relationshipCount).toBe(1);
  });
});
