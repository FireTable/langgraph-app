import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship, kbTheme } from "@/lib/kb/schema";
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
// per chunk. Themes live flat on kb_theme (single source of truth);
// we rehydrate by JOINing it on chunk_id. Schema rewrite keeps the
// wire shape so the UI does not need to change.

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
    await db.delete(kbTheme).where(eq(kbTheme.userId, TEST_USER.id));
    await db.delete(kbRelationship).where(eq(kbRelationship.userId, TEST_USER.id));
    await db.delete(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    await db.delete(kbChunk);
    await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
    for (const id of dynamicUserIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    dynamicUserIds.length = 0;
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

  it("populates themes from kb_theme by chunk_id", async () => {
    // ponytail: themes live flat on kb_theme (one row per chunk +
    // name), populated by replaceChunkThemes from entity-extract-node.
    // Acme → CHUNK_A carries ["growth", "tech"]; Acme + BetaCorp on
    // CHUNK_B carries ["growth", "tech", "market"]. Each chunk should
    // surface its own theme set — there is no entity-union fan-out.
    await db.insert(kbTheme).values([
      {
        id: `t-${randomUUID()}`,
        userId: TEST_USER.id,
        documentId: DOC_ID,
        chunkId: CHUNK_A,
        name: "growth",
      },
      {
        id: `t-${randomUUID()}`,
        userId: TEST_USER.id,
        documentId: DOC_ID,
        chunkId: CHUNK_A,
        name: "tech",
      },
      {
        id: `t-${randomUUID()}`,
        userId: TEST_USER.id,
        documentId: DOC_ID,
        chunkId: CHUNK_B,
        name: "growth",
      },
      {
        id: `t-${randomUUID()}`,
        userId: TEST_USER.id,
        documentId: DOC_ID,
        chunkId: CHUNK_B,
        name: "tech",
      },
      {
        id: `t-${randomUUID()}`,
        userId: TEST_USER.id,
        documentId: DOC_ID,
        chunkId: CHUNK_B,
        name: "market",
      },
    ]);
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    const chunkB = chunks.find((c) => c.ordinal === 1)!;
    expect(chunkA.themes.sort()).toEqual(["growth", "tech"]);
    expect(chunkB.themes.sort()).toEqual(["growth", "market", "tech"]);
  });

  it("themes default to empty when no kb_theme rows exist for the chunks", async () => {
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    for (const c of chunks) expect(Array.isArray(c.themes)).toBe(true);
    expect(chunks.every((c) => c.themes.length === 0)).toBe(true);
  });

  it("does NOT leak entities / relationships across users", async () => {
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
    const otherThemeId = `t-${randomUUID()}`;
    await db.insert(kbTheme).values({
      id: otherThemeId,
      userId: other.id,
      documentId: DOC_ID,
      chunkId: CHUNK_A,
      name: "should-not-leak",
    });
    const chunks = await findKbChunksContentByDocumentId(TEST_USER.id, DOC_ID);
    const chunkA = chunks.find((c) => c.ordinal === 0)!;
    expect(chunkA.entities.map((e) => e.name)).not.toContain("OtherUser");
    expect(chunkA.themes).not.toContain("should-not-leak");
  });
});
