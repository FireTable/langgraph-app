import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { relationLeg } from "@/lib/kb/search/relation-leg";
import { entityLeg } from "@/lib/kb/search/entity-leg";
import { hybridSearch } from "@/lib/kb/search";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

// ponytail: B-phase graph legs (relation-leg, entity-leg,
// assembleGraphContext) used to gate on KB_GRAPH_ENABLED — that env
// flag was removed in the audit §5 cleanup. The legs now run on
// every search and return empty hits when no kb_entity /
// kb_relationship rows exist for the user's scope.

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
const DOC_ID = `d-${randomUUID()}`;

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

async function seedFixture() {
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Graph Docs" });

  await db.insert(kbDocument).values({
    id: DOC_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "graph-report.pdf",
    contentType: "application/pdf",
    contentHash: `hash-G-${randomUUID()}`,
    status: "success",
  });

  await db.insert(kbChunk).values({
    id: `c-graph-${randomUUID()}`,
    documentId: DOC_ID,
    ordinal: 0,
    content: "OpenAI announced GPT-5 partnership with Microsoft in Redmond.",
    embedding: makeEmbedding(1),
    status: "success",
  } as never);

  await db.insert(kbEntity).values({
    id: `e-${randomUUID()}`,
    userId: TEST_USER.id,
    documentId: DOC_ID,
    name: "OpenAI",
    type: "Organization",
    description: "AI research organization",
    sourceChunkIds: [],
    embedding: makeEmbedding(1),
  });

  await db.insert(kbRelationship).values({
    id: `r-${randomUUID()}`,
    userId: TEST_USER.id,
    documentId: DOC_ID,
    source: "OpenAI",
    target: "Microsoft",
    relation: "PARTNERED_WITH",
    description: "Multi-year AI cloud compute alliance",
    sourceChunkIds: [],
    weight: 1,
    embedding: makeEmbedding(1),
  });
}

describe("relationLeg & entityLeg Hybrid Search Tests", () => {
  beforeEach(async () => {
    await ensureTestUser();
    await seedFixture();
  });

  afterEach(async () => {
    await db.delete(kbRelationship).where(eq(kbRelationship.userId, TEST_USER.id));
    await db.delete(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    await db.delete(kbChunk);
    await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  });

  it("relationLeg returns vector hits against kb_relationship", async () => {
    const res = await relationLeg({
      userId: TEST_USER.id,
      query: "OpenAI partnership",
      scope: { folderId: FOLDER_ID },
      topK: 5,
    });

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].docTitle).toBe("graph-report.pdf");
    expect(res.legs[0].rank).toBe(1);
  });

  it("entityLeg returns vector hits against kb_entity", async () => {
    const res = await entityLeg({
      userId: TEST_USER.id,
      query: "OpenAI AI research",
      scope: { folderId: FOLDER_ID },
      topK: 5,
    });

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].docTitle).toBe("graph-report.pdf");
    expect(res.legs[0].rank).toBe(1);
  });

  it("hybridSearch integrates all legs and builds graphContext", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "What is OpenAI's relationship with Microsoft?",
      originalQuery: "What is OpenAI's relationship with Microsoft?",
      entities: ["OpenAI"],
      scope: { folderId: FOLDER_ID },
    });

    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.graphContext).toBeDefined();
    expect(res.graphContext?.entities.some((e) => e.name === "OpenAI")).toBe(true);
    expect(res.graphContext?.relations.some((r) => r.relation === "PARTNERED_WITH")).toBe(true);
  });
});
