import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { expandFromEntities } from "@/lib/kb/search/graph-context";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

// ponytail: graph traversal unit tests — audit §7.
// Fixture builds: A—PARTNERED_WITH→B, B—ACQUIRED→C. Entry {A} should
// hop to B (1-hop) and C (2-hop) with both chunk_ids surfaced.

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;
const ENTITY_A = `A-${randomUUID()}`;
const ENTITY_B = `B-${randomUUID()}`;
const ENTITY_C = `C-${randomUUID()}`;
const CHUNK_AB_ID = `c-${randomUUID()}`;
const CHUNK_BC_ID = `c-${randomUUID()}`;
const CHUNK_A_ID = `c-${randomUUID()}`;

async function seedFixture() {
  await ensureTestUser();
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });
  await db.insert(kbDocument).values({
    id: DOC_A_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "graph-expand.pdf",
    contentType: "application/pdf",
    contentHash: `hash-${randomUUID()}`,
    status: "success",
  });
  await db.insert(kbChunk).values([
    {
      id: CHUNK_A_ID,
      documentId: DOC_A_ID,
      ordinal: 0,
      content: "intro",
      embedding: makeEmbedding(1),
      status: "success",
    } as typeof kbChunk.$inferInsert,
    {
      id: CHUNK_AB_ID,
      documentId: DOC_A_ID,
      ordinal: 1,
      content: "A partners B",
      embedding: makeEmbedding(2),
      status: "success",
    } as typeof kbChunk.$inferInsert,
    {
      id: CHUNK_BC_ID,
      documentId: DOC_A_ID,
      ordinal: 2,
      content: "B acquires C",
      embedding: makeEmbedding(3),
      status: "success",
    } as typeof kbChunk.$inferInsert,
  ]);
  await db.insert(kbEntity).values([
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: ENTITY_A,
      type: "Co",
      description: "first",
      sourceChunkIds: [CHUNK_A_ID],
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: ENTITY_B,
      type: "Co",
      description: "second",
      sourceChunkIds: [CHUNK_AB_ID],
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: ENTITY_C,
      type: "Co",
      description: "third",
      sourceChunkIds: [CHUNK_BC_ID],
    },
  ]);
  await db.insert(kbRelationship).values([
    {
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      source: ENTITY_A,
      target: ENTITY_B,
      relation: "PARTNERED_WITH",
      description: "",
      sourceChunkIds: [CHUNK_AB_ID],
      weight: 1,
    },
    {
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      source: ENTITY_B,
      target: ENTITY_C,
      relation: "ACQUIRED",
      description: "",
      sourceChunkIds: [CHUNK_BC_ID],
      weight: 1,
    },
  ]);
}

describe("expandFromEntities — graph traversal (audit §7)", () => {
  beforeEach(async () => {
    await seedFixture();
  });
  afterEach(async () => {
    await db.delete(kbRelationship).where(eq(kbRelationship.userId, TEST_USER.id));
    await db.delete(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    await db.delete(kbChunk);
    await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  });

  it("hops=1: from A reaches B but not C", async () => {
    const out = await expandFromEntities({
      userId: TEST_USER.id,
      scope: { folderId: FOLDER_ID },
      entryEntities: [ENTITY_A],
      hops: 1,
    });
    expect(out.neighborEntities).toContain(ENTITY_B);
    expect(out.neighborEntities).not.toContain(ENTITY_C);
    expect(out.chunkIds).toContain(CHUNK_AB_ID);
    expect(out.chunkIds).not.toContain(CHUNK_BC_ID);
    expect(out.edgeTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: ENTITY_A, target: ENTITY_B, relation: "PARTNERED_WITH" }),
      ]),
    );
  });

  it("hops=2: from A reaches B and C with chunk_ids from both edges", async () => {
    const out = await expandFromEntities({
      userId: TEST_USER.id,
      scope: { folderId: FOLDER_ID },
      entryEntities: [ENTITY_A],
      hops: 2,
    });
    expect(out.neighborEntities).toContain(ENTITY_B);
    expect(out.neighborEntities).toContain(ENTITY_C);
    expect(out.chunkIds).toContain(CHUNK_AB_ID);
    expect(out.chunkIds).toContain(CHUNK_BC_ID);
  });

  it("empty entry list → empty result", async () => {
    const out = await expandFromEntities({
      userId: TEST_USER.id,
      scope: { folderId: FOLDER_ID },
      entryEntities: [],
      hops: 2,
    });
    expect(out.neighborEntities).toEqual([]);
    expect(out.chunkIds).toEqual([]);
    expect(out.edgeTexts).toEqual([]);
  });

  it("scopes by documentId (cross-doc isolation)", async () => {
    // Empty scope.documentId matches none — A→B edge is filtered out.
    const out = await expandFromEntities({
      userId: TEST_USER.id,
      scope: { documentId: "d-nonexistent" },
      entryEntities: [ENTITY_A],
      hops: 2,
    });
    expect(out.neighborEntities).toEqual([]);
    expect(out.chunkIds).toEqual([]);
  });

  it("cycles are visited once (no infinite walk)", async () => {
    // Add a self-loop C→A so the BFS would loop without the visited set.
    await db.insert(kbRelationship).values({
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      source: ENTITY_C,
      target: ENTITY_A,
      relation: "ECHOES",
      description: "",
      sourceChunkIds: [CHUNK_A_ID],
      weight: 1,
    });
    const out = await expandFromEntities({
      userId: TEST_USER.id,
      scope: { folderId: FOLDER_ID },
      entryEntities: [ENTITY_A],
      hops: 5, // would loop forever without visited guard
    });
    // All three reachable, each surfaced once.
    expect(out.neighborEntities.filter((n) => n === ENTITY_A)).toHaveLength(0); // A is the entry, not a neighbor
    expect(out.neighborEntities).toContain(ENTITY_B);
    expect(out.neighborEntities).toContain(ENTITY_C);
  });
});
