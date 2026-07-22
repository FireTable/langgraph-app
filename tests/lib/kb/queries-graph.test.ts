import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { findKbChunksContentByDocumentId, insertKbChunks, withKbTx } from "@/lib/kb/queries";
import { user } from "@/lib/auth/schema";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

const dynamicUserIds: string[] = [];

async function makeIsolatedUser(): Promise<{ id: string; email: string }> {
  const id = `test-${randomUUID()}`;
  const email = `${id}@test.local`;
  await db.insert(user).values({ id, email, name: "Test User" });
  dynamicUserIds.push(id);
  return { id, email };
}

// ponytail: regression — audit §8 / Step 6 said "前端 0 改动" but the
// doc-detail UI reads `c.entities` / `c.relationships` / `c.themes`
// per chunk. The jsonB columns are gone from kb_chunk; we rehydrate
// them server-side by JOINing kb_entity / kb_relationship on
// `source_chunk_ids @> ARRAY[chunkId]`.

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_ID = `d-${randomUUID()}`;
const CHUNK_A = `c-${randomUUID()}`;
const CHUNK_B = `c-${randomUUID()}`;

async function seedFixture() {
  await ensureTestUser();
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });
  await db.insert(kbDocument).values({
    id: DOC_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "graph-api.pdf",
    contentType: "application/pdf",
    contentHash: `hash-${randomUUID()}`,
    status: "success",
  });
  await withKbTx(async (tx) => {
    await insertKbChunks(tx, [
      {
        id: CHUNK_A,
        documentId: DOC_ID,
        ordinal: 0,
        content: "Acme was founded in 2020.",
        embedding: makeEmbedding(1),
      },
      {
        id: CHUNK_B,
        documentId: DOC_ID,
        ordinal: 1,
        content: "Acme partnered with BetaCorp.",
        embedding: makeEmbedding(2),
      },
    ] as never);
  });

  // Two entities — one referenced by both chunks, one by chunk B only.
  await db.insert(kbEntity).values([
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_ID,
      name: "Acme",
      type: "Organization",
      description: "founded 2020",
      sourceChunkIds: [CHUNK_A, CHUNK_B],
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_ID,
      name: "BetaCorp",
      type: "Organization",
      description: "partner",
      sourceChunkIds: [CHUNK_B],
    },
  ]);
  await db.insert(kbRelationship).values([
    {
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_ID,
      source: "Acme",
      target: "BetaCorp",
      relation: "PARTNERED_WITH",
      description: "2020 alliance",
      sourceChunkIds: [CHUNK_B],
      weight: 1,
    },
  ]);
}

describe("findKbChunksContentByDocumentId — graph rehydration (audit §8)", () => {
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

  it("populates entities from kb_entity via source_chunk_ids", async () => {
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    expect(chunks).toHaveLength(2);

    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    const chunkB = chunks.find((c) => c.ordinal === 1)!;

    // Chunk A: only "Acme" appears in its source_chunk_ids.
    expect(chunkA.entities.map((e) => e.name)).toEqual(["Acme"]);
    // Chunk B: both "Acme" and "BetaCorp" reference it.
    expect(chunkB.entities.map((e) => e.name).sort()).toEqual(["Acme", "BetaCorp"]);
  });

  it("populates relationships from kb_relationship via source_chunk_ids", async () => {
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkB = chunks.find((c) => c.ordinal === 1)!;
    expect(chunkB.relationships).toHaveLength(1);
    expect(chunkB.relationships[0]).toEqual({
      source: "Acme",
      target: "BetaCorp",
      relation: "PARTNERED_WITH",
      description: "2020 alliance",
    });

    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    expect(chunkA.relationships).toEqual([]);
  });

  it("populates themes by union across entities referencing the chunk", async () => {
    // Acme has themes ["growth", "tech"]; BetaCorp has ["growth", "market"].
    // Chunk B references both → union = ["growth", "tech", "market"].
    // Chunk A references only Acme → ["growth", "tech"].
    await db
      .update(kbEntity)
      .set({ themes: ["growth", "tech"] })
      .where(eq(kbEntity.name, "Acme"));
    await db
      .update(kbEntity)
      .set({ themes: ["growth", "market"] })
      .where(eq(kbEntity.name, "BetaCorp"));
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    const chunkB = chunks.find((c) => c.ordinal === 1)!;
    expect(chunkA.themes.sort()).toEqual(["growth", "tech"]);
    expect(chunkB.themes.sort()).toEqual(["growth", "market", "tech"]);
  });

  it("themes default to empty when entity has no themes column populated", async () => {
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    for (const c of chunks) expect(Array.isArray(c.themes)).toBe(true);
  });

  it("dedupes the same entity when its source_chunk_ids includes multiple chunks", async () => {
    // Acme appears in both CHUNK_A and CHUNK_B → still only one row per chunk.
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkB = chunks.find((c) => c.ordinal === 1)!;
    expect(chunkB.entities.filter((e) => e.name === "Acme")).toHaveLength(1);
  });

  it("returns empty array for an unknown document", async () => {
    expect(await findKbChunksContentByDocumentId(TEST_USER.id, "d-nope")).toEqual([]);
  });

  it("does not leak entities / relationships across users", async () => {
    // Insert an entity owned by another user — should NOT appear in the
    // doc-detail payload for TEST_USER.
    const other = await makeIsolatedUser();
    const otherId = `e-${randomUUID()}`;
    await db.insert(kbEntity).values({
      id: otherId,
      userId: other.id,
      documentId: DOC_ID,
      name: "OtherUser",
      type: "Org",
      description: "should not appear",
      sourceChunkIds: [CHUNK_A],
    });
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    expect(chunkA.entities.map((e) => e.name)).not.toContain("OtherUser");
  });
});
