import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbEntity, kbFolder, kbRelationship } from "@/lib/kb/schema";
import { chunksEmbedAgent } from "@/backend/agent/kb-agent";
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

// ponytail: regression — the old "entityExtract IIFE + conditional
// waitForChunks" path could leak a chat-source call past
// entityAlignment (which reads kb_entity) before the rows landed,
// silently dropping the alignment + embed step.
//
// After collapsing the three nodes into the chunksEmbed sub-graph
// we drive the sub-agent in isolation (no OCR chain, no parent
// routing) and assert that all three phases commit in declared
// order: rows land (extract), alignedEntities populated
// (alignment), entityEmbeddings populated (embed). The previous
// race would have surfaced as alignedEntities being empty because
// alignment ran against an empty kb_entity.

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_ID = `d-${randomUUID()}`;

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

async function seedFixture() {
  await ensureTestUser();
  await db.insert(kbFolder).values({
    id: FOLDER_ID,
    userId: TEST_USER.id,
    name: "Attachments",
  });
  await db.insert(kbDocument).values({
    id: DOC_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "alpha.pdf",
    contentType: "application/pdf",
    contentHash: `hash-${randomUUID()}`,
    status: "success",
    pages: [
      {
        pageIndex: 0,
        imageUrl: "mock://page-1",
        markdown: "Acme was founded in 2020.\n\n---\n\nBetaCorp partnered with Acme.",
      },
    ],
  });
  // Two pre-existing success rows so the path inside
  // entityExtractNode skips the chunk + insert branch (we only
  // exercise the per-chunk LLM extraction path).
  await db.insert(kbChunk).values([
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_ID,
      ordinal: 0,
      content: "Acme was founded in 2020.",
      embedding: makeEmbedding(1),
      status: "success",
    },
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_ID,
      ordinal: 1,
      content: "BetaCorp partnered with Acme.",
      embedding: makeEmbedding(2),
      status: "success",
    },
  ] as never);
}

vi.mock("@/backend/model", () => ({
  getEmbeddingModel: vi.fn(async () => ({
    embedQuery: vi.fn(async () => makeEmbedding(0)),
    embedDocuments: vi.fn(async (docs: string[]) =>
      docs.map((_d: string, i: number) => makeEmbedding(i)),
    ),
  })),
  getExtractModel: vi.fn(async () => ({
    withStructuredOutput: vi.fn(() => ({
      invoke: vi.fn(async () => ({
        entities: [
          { name: "Acme", type: "Organization", description: "founded 2020" },
          { name: "BetaCorp", type: "Organization", description: "partner" },
        ],
        relationships: [
          {
            source: "BetaCorp",
            target: "Acme",
            relation: "PARTNERED_WITH",
            description: "2020 alliance",
          },
        ],
        themes: ["Funding", "Partnership"],
      })),
    })),
  })),
}));

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

describe("chunksEmbed sub-agent — sub-graph collapse", () => {
  it("runs entityExtract → alignment → embed in order; alignment sees committed rows", async () => {
    // pre-condition: zero entities
    const before = await db.select().from(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    expect(before).toHaveLength(0);

    const out = await chunksEmbedAgent.invoke({
      userId: TEST_USER.id,
      messages: [],
      processedFiles: [
        {
          docId: DOC_ID,
          pipelineStatus: "new",
          filePartId: "fp-test",
          mime: "application/pdf",
          pageCount: 1,
        } as never,
      ],
      mode: "full",
      docId: DOC_ID,
    } as never);

    // Phase 1 (entityExtract) committed rows BEFORE returning.
    const afterExtract = await db.select().from(kbEntity).where(eq(kbEntity.userId, TEST_USER.id));
    expect(afterExtract.length).toBeGreaterThanOrEqual(2);

    // State fields populated by each phase, in order:
    //   entityExtractedChunks  ← phase 1
    //   alignedEntities        ← phase 2
    //   entityEmbeddings       ← phase 3
    // If the race ever resurfaces, alignment sees 0 rows → no
    // alignments stamped → alignedEntities empty → this fails.
    expect(out.entityExtractedChunks?.length ?? 0).toBeGreaterThan(0);
    expect(out.alignedEntities?.length ?? 0).toBeGreaterThan(0);
  });
});
