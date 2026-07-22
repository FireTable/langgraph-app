import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship, kbTheme } from "@/lib/kb/schema";
import { findKbChunksByFolderId, insertKbChunks, withKbTx } from "@/lib/kb/queries";
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

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

const FOLDER_ID = `f-${randomUUID()}`;
const OTHER_FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;
const DOC_B_ID = `d-${randomUUID()}`;
const DOC_OTHER_ID = `d-${randomUUID()}`;
const CHUNK_A1 = `c-${randomUUID()}`;
const CHUNK_A2 = `c-${randomUUID()}`;
const CHUNK_B1 = `c-${randomUUID()}`;
const CHUNK_OTHER = `c-${randomUUID()}`;

async function seedFixture() {
  await ensureTestUser();
  await db.insert(kbFolder).values([
    { id: FOLDER_ID, userId: TEST_USER.id, name: "Folder Under Test" },
    { id: OTHER_FOLDER_ID, userId: TEST_USER.id, name: "Other Folder (cross-user isolation)" },
  ]);
  await db.insert(kbDocument).values([
    {
      id: DOC_A_ID,
      userId: TEST_USER.id,
      folderId: FOLDER_ID,
      title: "alpha.pdf",
      contentType: "application/pdf",
      contentHash: `hash-A-${randomUUID()}`,
      status: "success",
    },
    {
      id: DOC_B_ID,
      userId: TEST_USER.id,
      folderId: FOLDER_ID,
      title: "beta.pdf",
      contentType: "application/pdf",
      contentHash: `hash-B-${randomUUID()}`,
      status: "success",
    },
    {
      id: DOC_OTHER_ID,
      userId: TEST_USER.id,
      folderId: OTHER_FOLDER_ID,
      title: "other-folder.pdf",
      contentType: "application/pdf",
      contentHash: `hash-O-${randomUUID()}`,
      status: "success",
    },
  ]);

  await withKbTx(async (tx) => {
    await insertKbChunks(tx, [
      {
        id: CHUNK_A1,
        documentId: DOC_A_ID,
        ordinal: 0,
        content: "Acme was founded in 2020.",
        embedding: makeEmbedding(1),
      },
      {
        id: CHUNK_A2,
        documentId: DOC_A_ID,
        ordinal: 1,
        content: "Acme partnered with BetaCorp in 2024.",
        embedding: makeEmbedding(2),
      },
      {
        id: CHUNK_B1,
        documentId: DOC_B_ID,
        ordinal: 0,
        content: "BetaCorp acquired Gamma in 2023.",
        embedding: makeEmbedding(3),
      },
      {
        id: CHUNK_OTHER,
        documentId: DOC_OTHER_ID,
        ordinal: 0,
        content: "Delta unrelated content.",
        embedding: makeEmbedding(4),
      },
    ] as never);
  });

  // Entities: Acme lives across CHUNK_A1 + CHUNK_A2.
  //          Gamma only in CHUNK_B1.
  //          OtherFolderEntity lives ONLY in CHUNK_OTHER (must NOT
  //          leak into the FOLDER_ID rollup).
  await db.insert(kbEntity).values([
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: "Acme",
      type: "Organization",
      description: "founded 2020",
      sourceChunkIds: [CHUNK_A1, CHUNK_A2],
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      name: "Gamma",
      type: "Organization",
      description: "acquired",
      sourceChunkIds: [CHUNK_B1],
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_OTHER_ID,
      name: "OtherFolderEntity",
      type: "Organization",
      description: "must not leak",
      sourceChunkIds: [CHUNK_OTHER],
    },
  ]);

  // Themes live flat on kb_theme (single source of truth). CHUNK_A1
  // + CHUNK_A2 → ["growth","tech"]; CHUNK_B1 → ["growth"].
  await db.insert(kbTheme).values([
    {
      id: `t-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      chunkId: CHUNK_A1,
      name: "growth",
    },
    {
      id: `t-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      chunkId: CHUNK_A1,
      name: "tech",
    },
    {
      id: `t-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      chunkId: CHUNK_A2,
      name: "growth",
    },
    {
      id: `t-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      chunkId: CHUNK_A2,
      name: "tech",
    },
    {
      id: `t-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      chunkId: CHUNK_B1,
      name: "growth",
    },
  ]);

  await db.insert(kbRelationship).values([
    {
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      source: "Acme",
      target: "BetaCorp",
      relation: "PARTNERED_WITH",
      description: "2024 alliance",
      sourceChunkIds: [CHUNK_A2],
    },
    {
      id: `r-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      source: "BetaCorp",
      target: "Gamma",
      relation: "ACQUIRED",
      description: "2023 deal",
      sourceChunkIds: [CHUNK_B1],
    },
  ]);
}

describe("findKbChunksByFolderId — folder-level JOIN (audit §8)", () => {
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

  it("returns chunks from every doc in the folder (3 rows: a1, a2, b1)", async () => {
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    expect(chunks).toHaveLength(3);
    // Content provenance is by content; alphabetize to dedupe ordering.
    const contents = chunks.map((c) => c.content).sort();
    expect(contents).toEqual([
      "Acme partnered with BetaCorp in 2024.",
      "Acme was founded in 2020.",
      "BetaCorp acquired Gamma in 2023.",
    ]);
  });

  it("populates entities on each chunk via source_chunk_ids overlap", async () => {
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    const a1 = chunks.find((c) => c.content.startsWith("Acme was founded"))!;
    const a2 = chunks.find((c) => c.content.startsWith("Acme partnered"))!;
    const b1 = chunks.find((c) => c.content.startsWith("BetaCorp acquired"))!;

    expect(a1.entities.map((e) => e.name)).toEqual(["Acme"]);
    // a2 also references Acme (same entity, second source chunk).
    expect(a2.entities.map((e) => e.name)).toEqual(["Acme"]);
    // b1 references Gamma only.
    expect(b1.entities.map((e) => e.name)).toEqual(["Gamma"]);
  });

  it("populates relationships on each chunk", async () => {
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    const a2 = chunks.find((c) => c.content.startsWith("Acme partnered"))!;
    const b1 = chunks.find((c) => c.content.startsWith("BetaCorp acquired"))!;
    expect(a2.relationships).toHaveLength(1);
    expect(a2.relationships[0]).toEqual({
      source: "Acme",
      target: "BetaCorp",
      relation: "PARTNERED_WITH",
      description: "2024 alliance",
    });
    expect(b1.relationships).toHaveLength(1);
    expect(b1.relationships[0]).toEqual({
      source: "BetaCorp",
      target: "Gamma",
      relation: "ACQUIRED",
      description: "2023 deal",
    });
  });

  it("themes union across entities referencing the chunk", async () => {
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    const a1 = chunks.find((c) => c.content.startsWith("Acme was founded"))!;
    expect(a1.themes.sort()).toEqual(["growth", "tech"]);
    const b1 = chunks.find((c) => c.content.startsWith("BetaCorp acquired"))!;
    expect(b1.themes.sort()).toEqual(["growth"]);
  });

  it("does NOT leak entities / relationships from other folders", async () => {
    // The OTHER folder has OtherFolderEntity referencing CHUNK_OTHER,
    // and CHUNK_OTHER is in DOC_OTHER_ID (different folder). The
    // FOLDER_ID query must not see it — neither as chunk nor as
    // entity/relationship bucket.
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    expect(chunks.map((c) => c.content)).not.toContain("Delta unrelated content.");
    for (const c of chunks) {
      expect(c.entities.map((e) => e.name)).not.toContain("OtherFolderEntity");
    }
  });

  it("does NOT leak entities / relationships across users", async () => {
    const other = await makeIsolatedUser();
    await db.insert(kbEntity).values({
      id: `e-${randomUUID()}`,
      userId: other.id,
      documentId: DOC_A_ID,
      name: "OtherUserEntity",
      type: "Org",
      description: "must not appear",
      sourceChunkIds: [CHUNK_A1],
    });
    const chunks = await findKbChunksByFolderId(TEST_USER.id, FOLDER_ID);
    const a1 = chunks.find((c) => c.content.startsWith("Acme was founded"))!;
    expect(a1.entities.map((e) => e.name)).not.toContain("OtherUserEntity");
  });

  it("returns empty array for an unknown folder", async () => {
    expect(await findKbChunksByFolderId(TEST_USER.id, "f-nope")).toEqual([]);
  });

  it("returns empty array when the folder has no docs", async () => {
    await db.insert(kbFolder).values({
      id: `f-${randomUUID()}`,
      userId: TEST_USER.id,
      name: "Empty Folder",
    });
    const chunks = await findKbChunksByFolderId(TEST_USER.id, `f-${randomUUID()}`);
    expect(chunks).toEqual([]);
  });
});
