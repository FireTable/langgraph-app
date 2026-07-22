import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { hybridSearch } from "@/lib/kb/search";
import { _resetKbEnvCache } from "@/lib/kb/env";
import { TEST_USER, ensureTestUser, makeUser } from "@/tests/helpers/auth";

vi.mock("@/backend/model", () => ({
  getEmbeddingModel: vi.fn(async () => ({
    embedQuery: vi.fn(async (q: string) => {
      const out: number[] = [];
      for (let i = 0; i < 1024; i++) out.push(Math.sin(q.length + i * 0.01) * 0.001);
      return out;
    }),
  })),
}));

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;
const DOC_B_ID = `d-${randomUUID()}`;

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

async function seedFixture() {
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });

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
  ]);

  await db.insert(kbChunk).values([
    {
      id: `c-kw-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 0,
      content: "Acme was founded in 2020 in San Francisco.",
      embedding: makeEmbedding(1),
      status: "success",
    },
    {
      id: `c-vec-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 1,
      content: "Unrelated prose about gardening and soil composition.",
      embedding: makeEmbedding(2),
      status: "success",
    },
    {
      id: `c-both-${randomUUID()}`,
      documentId: DOC_B_ID,
      ordinal: 0,
      content: "Acme acquired BetaCorp in early 2024.",
      embedding: makeEmbedding(3),
      status: "success",
    },
    {
      id: `c-market-${randomUUID()}`,
      documentId: DOC_B_ID,
      ordinal: 1,
      content: "Stock market analysis paragraph with finance terms.",
      embedding: makeEmbedding(4),
      status: "success",
    },
    {
      id: `c-safety-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 2,
      content: "Manufacturing safety chapter — regulatory and operational notes.",
      embedding: makeEmbedding(5),
      status: "success",
    },
    {
      id: `c-rel-${randomUUID()}`,
      documentId: DOC_B_ID,
      ordinal: 2,
      content: "Quarterly financial position review and risk disclosures.",
      embedding: makeEmbedding(6),
      status: "success",
    },
  ] as never);

  await db.insert(kbEntity).values([
    {
      id: `e-1-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: "Acme",
      type: "Organization",
      description: "Acme company",
    },
    {
      id: `e-2-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: "San Francisco",
      type: "Location",
      description: "SF city",
    },
    {
      id: `e-3-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      name: "Acme",
      type: "Organization",
      description: "Acme company",
    },
    {
      id: `e-4-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      name: "BetaCorp",
      type: "Organization",
      description: "BetaCorp acquired",
    },
  ]);

  await db.insert(kbRelationship).values([
    {
      id: `r-1-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      source: "phoenixhold",
      target: "Treasury",
      relation: "MANAGES",
      description: "phoenixhold manages treasury exposures",
    },
  ]);
}

beforeEach(async () => {
  _resetKbEnvCache();
  await ensureTestUser();
  await db.delete(kbEntity);
  await db.delete(kbRelationship);
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  await seedFixture();
});

afterEach(async () => {
  await db.delete(kbEntity);
  await db.delete(kbRelationship);
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
});

describe("lib/kb/search — hybridSearch Step 4", () => {
  it("kw-only query returns BM25 hits in rrf order", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme founded",
      scope: { folderId: FOLDER_ID },
    });
    const out = res.chunks;
    expect(out.length).toBeGreaterThan(0);
    const first = out[0];
    expect(first.content).toMatch(/Acme was founded/);
    expect(first.legsHit).toContain("kw");
  });

  it("vec-only query returns cosine hits", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "zebra xylophone",
      scope: { folderId: FOLDER_ID },
    });
    const out = res.chunks;
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].legsHit).toContain("vec");
  });

  it("hybrid RRF ranks dual-hit chunks above single-hit", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      scope: { folderId: FOLDER_ID },
    });
    const out = res.chunks;
    expect(out.length).toBeGreaterThan(0);
    const dualHit = out.find((r) => r.content.match(/Acme acquired/));
    expect(dualHit).toBeDefined();
    expect(dualHit!.legsHit).toContain("kw");
    expect(dualHit!.legsHit).toContain("vec");
  });

  it("explicit entities enables the tag leg", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "what does the source say",
      entities: ["Acme"],
      scope: { folderId: FOLDER_ID },
    });
    const out = res.chunks;
    const acmeHit = out.find((r) => r.content.match(/Acme/));
    expect(acmeHit).toBeDefined();
    expect(acmeHit!.legsHit).toContain("tag");
  });

  it("tag leg matches via relationship source/target", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "anything irrelevant",
      entities: ["phoenixhold"],
      scope: { folderId: FOLDER_ID },
    });
    const out = res.chunks;
    const relHit = out.find((r) => r.content.match(/Quarterly financial/));
    expect(relHit).toBeDefined();
    expect(relHit!.legsHit).toContain("tag");
  });

  it("truncates chunk content to chunkMaxChars", async () => {
    process.env.KB_CHUNK_MAX_CHARS = "30";
    _resetKbEnvCache();
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      scope: { folderId: FOLDER_ID },
    });
    for (const r of res.chunks) {
      expect(r.content.length).toBeLessThanOrEqual(30);
    }
  });

  it("returns [] fallback scope dump when no documents are in status=success", async () => {
    await db
      .update(kbDocument)
      .set({ status: "failed" })
      .where(eq(kbDocument.userId, TEST_USER.id));
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      scope: { folderId: FOLDER_ID },
    });
    expect(res.chunks).toEqual([]);
  });

  it("scopes by user — other user's KB invisible", async () => {
    const other = await makeUser();
    await db.insert(kbFolder).values({
      id: `f-${randomUUID()}`,
      userId: other.id,
      name: "Attachments",
    });
    const otherFolderId = (await db.query.kbFolder.findFirst({
      where: eq(kbFolder.userId, other.id),
    }))!.id;
    const otherDocId = `d-${randomUUID()}`;
    await db.insert(kbDocument).values({
      id: otherDocId,
      userId: other.id,
      folderId: otherFolderId,
      title: "other.pdf",
      contentType: "application/pdf",
      contentHash: `hash-other-${randomUUID()}`,
      status: "success",
    });
    await db.insert(kbChunk).values({
      id: `c-${randomUUID()}`,
      documentId: otherDocId,
      ordinal: 0,
      content: "Acme private data for another user.",
      embedding: makeEmbedding(1),
    } as never);

    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      scope: { folderId: FOLDER_ID },
    });
    for (const r of res.chunks) {
      expect(r.documentId).not.toBe(otherDocId);
    }

    await db.delete(kbChunk).where(eq(kbChunk.documentId, otherDocId));
    await db.delete(kbDocument).where(eq(kbDocument.id, otherDocId));
    await db.delete(kbFolder).where(eq(kbFolder.userId, other.id));
  });
});
