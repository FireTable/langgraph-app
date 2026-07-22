import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { hybridSearch, scopeDump } from "@/lib/kb/search";
import { _resetKbEnvCache } from "@/lib/kb/env";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

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
      content: "Acme corporation was founded in 2020 in San Francisco.",
      embedding: makeEmbedding(1),
      status: "success",
    },
    {
      id: `c-vec-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 1,
      content: "Unrelated text about gardening and soil composition.",
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
  ] as never);

  await db.insert(kbEntity).values([
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_A_ID,
      name: "Acme",
      type: "Organization",
      description: "Acme company",
    },
    {
      id: `e-${randomUUID()}`,
      userId: TEST_USER.id,
      documentId: DOC_B_ID,
      name: "BetaCorp",
      type: "Organization",
      description: "BetaCorp acquired",
    },
  ]);

  await db.insert(kbRelationship).values([
    {
      id: `r-${randomUUID()}`,
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

describe("Step 4 · Modular Hybrid Search Orchestrator", () => {
  it("hybridSearch: returns fused chunks with scoreKind='rrf' and legsHit", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      entities: ["Acme"],
      scope: { folderId: FOLDER_ID },
    });

    expect(res.chunks).toBeDefined();
    expect(res.chunks.length).toBeGreaterThan(0);
    const first = res.chunks[0];
    expect(first.scoreKind).toBe("rrf");
    expect(first.score).toBeGreaterThan(0);
    expect(first.legsHit.length).toBeGreaterThan(0);
  }, 15000);

  it("hybridSearch: empty rewriteQuery falls back to scopeDump", async () => {
    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "",
      scope: { folderId: FOLDER_ID },
    });

    expect(res.chunks).toBeDefined();
    expect(res.chunks.length).toBe(3);
    expect(res.chunks[0].legsHit).toEqual(["full"]);
  });

  it("scopeDump: returns document chunks ordered by ordinal and created_at", async () => {
    const chunks = await scopeDump({
      userId: TEST_USER.id,
      scope: { folderId: FOLDER_ID },
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0].legsHit).toEqual(["full"]);
    expect(chunks[0].score).toBe(1.0);
  });
});

describe("Step 4 · multi-query fusion (audit §2b)", () => {
  // ponytail: when originalQuery differs from rewriteQuery, the
  // orchestrator runs TWO dense sub-legs (embed of each) and RRF-fuses
  // them with the BM25 leg + tag leg. This protects against the LLM
  // rewriting the user's context-dependent question in a way that
  // drops an important signal.
  //
  // Reuses FOLDER_ID + seedFixture from the outer describe — folder
  // is wiped in beforeEach to clear orphans left by Step 6
  // GRAPH_ENABLED's missing cleanup.
  beforeEach(async () => {
    await ensureTestUser();
    await db.delete(kbRelationship).where(eq(kbRelationship.userId, TEST_USER.id));
    await db.delete(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    await db.delete(kbChunk);
    await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
    await seedFixture();
  });
  afterEach(async () => {
    await db.delete(kbRelationship).where(eq(kbRelationship.userId, TEST_USER.id));
    await db.delete(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    await db.delete(kbChunk);
    await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  });

  it("identical rewriteQuery + originalQuery: only ONE dense sub-leg fires", async () => {
    const embedSpy = vi.fn(async (_q: string) => {
      const out: number[] = [];
      for (let i = 0; i < 1024; i++) out.push(Math.sin(_q.length + i * 0.01) * 0.001);
      return out;
    });
    const embedder = await import("@/backend/model");
    vi.spyOn(embedder, "getEmbeddingModel").mockResolvedValueOnce({
      embedQuery: embedSpy,
    } as never);

    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "What about Acme?",
      originalQuery: "What about Acme?",
      scope: { folderId: FOLDER_ID },
    });
    expect(res.chunks.length).toBeGreaterThan(0);
    // Only one dense sub-leg → one embedQuery call.
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("distinct rewriteQuery + originalQuery: TWO dense sub-legs fire and fuse", async () => {
    const embedSpy = vi.fn(async (_q: string) => {
      const out: number[] = [];
      for (let i = 0; i < 1024; i++) out.push(Math.sin(_q.length + i * 0.01) * 0.001);
      return out;
    });
    const embedder = await import("@/backend/model");
    vi.spyOn(embedder, "getEmbeddingModel").mockResolvedValueOnce({
      embedQuery: embedSpy,
    } as never);

    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme partnership history",
      originalQuery: "那个跟 Acme 合作的公司",
      scope: { folderId: FOLDER_ID },
    });
    expect(res.chunks.length).toBeGreaterThan(0);
    // Two distinct queries → two embedQuery calls.
    expect(embedSpy).toHaveBeenCalledTimes(2);
    // The exact queries passed to embedder should match what we set.
    const calledWith = embedSpy.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain("Acme partnership history");
    expect(calledWith).toContain("那个跟 Acme 合作的公司");
  });

  it("originalQuery omitted: only ONE dense sub-leg (no fallback to scopeDump)", async () => {
    const embedSpy = vi.fn(async (_q: string) => {
      const out: number[] = [];
      for (let i = 0; i < 1024; i++) out.push(Math.sin(_q.length + i * 0.01) * 0.001);
      return out;
    });
    const embedder = await import("@/backend/model");
    vi.spyOn(embedder, "getEmbeddingModel").mockResolvedValueOnce({
      embedQuery: embedSpy,
    } as never);

    const res = await hybridSearch({
      userId: TEST_USER.id,
      rewriteQuery: "Acme",
      scope: { folderId: FOLDER_ID },
    });
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it("rerankChunks: performs Max-Score fusion across rewriteQuery and originalQuery", async () => {
    const { rerankChunks } = await import("@/lib/kb/search/rerank");
    const mockReranker = {
      rerank: vi.fn(async (q: string, _docs: string[]) => {
        if (q === "Original User Query") {
          return [{ index: 0, score: 0.95 }, { index: 1, score: 0.20 }];
        }
        return [{ index: 0, score: 0.30 }, { index: 1, score: 0.85 }];
      }),
    };

    const registry = await import("@/lib/provider/model-registry");
    vi.spyOn(registry, "getRerankModelFromDB").mockResolvedValueOnce(mockReranker as any);

    const sampleChunks = [
      {
        chunkId: "c1",
        documentId: "d1",
        docTitle: "Doc1",
        pageNumbers: [1],
        content: "Text 1",
        score: 0.5,
        scoreKind: "rrf" as const,
        legsHit: ["vec" as const],
      },
      {
        chunkId: "c2",
        documentId: "d1",
        docTitle: "Doc1",
        pageNumbers: [1],
        content: "Text 2",
        score: 0.4,
        scoreKind: "rrf" as const,
        legsHit: ["kw" as const],
      },
    ];

    const result = await rerankChunks({
      chunks: sampleChunks,
      query: "Rewrite LLM Query",
      originalQuery: "Original User Query",
      topK: 10,
    });

    expect(mockReranker.rerank).toHaveBeenCalledTimes(2);
    // Chunk c1 gets Max(0.30, 0.95) = 0.95 from originalQuery
    // Chunk c2 gets Max(0.85, 0.20) = 0.85 from rewriteQuery
    expect(result[0].chunkId).toBe("c1");
    expect(result[0].score).toBe(0.95);
    expect(result[1].chunkId).toBe("c2");
    expect(result[1].score).toBe(0.85);
  });
});
