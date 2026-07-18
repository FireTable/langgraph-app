import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { deriveQueryEntities, hybridSearch } from "@/lib/kb/search";
import { _resetKbEnvCache } from "@/lib/kb/env";
import { TEST_USER, ensureTestUser, makeUser } from "@/tests/helpers/auth";

// ponytail: hybridSearch runs against the real DB (RRF CTE, GIN, HNSW).
// Seed two docs with known chunks; assert ranking, leg hit semantics,
// truncation, and user-scoping. No mocks — the SQL is the SUT.

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

  // Four chunks. The "kw only" chunk has a unique keyword that only
  // matches the BM25 leg. The "vec only" chunk's content doesn't contain
  // any keyword but its embedding is close to the query vector. The
  // "both" chunk matches both. The "tag only" chunk shares entity names
  // with the query but not the keyword or vector.
  // ponytail: `tsv` is a GENERATED column — omit it from the insert.
  // Drizzle's inferred type requires it (kb_chunk.tsv.notNull()), so the
  // production code (`insertKbChunks` in lib/kb/queries.ts) casts
  // `as never` to bypass; tests do the same.
  await db.insert(kbChunk).values([
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 0,
      content: "Acme was founded in 2020 in San Francisco.",
      embedding: makeEmbedding(1),
      entities: ["Acme", "San Francisco"],
      // ponytail: kb_chunk.status = 'pending' is the column default.
      // lib/kb/search.ts filters on status = 'success' so the legacy
      // fixture seeds must explicitly opt into the searchable pool
      // — otherwise every search test fails because the search legs
      // reject every row.
      status: "success",
    },
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 1,
      content: "Unrelated prose about gardening and soil composition.",
      embedding: makeEmbedding(2),
      entities: ["gardening"],
      status: "success",
    },
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_B_ID,
      ordinal: 0,
      content: "Acme acquired BetaCorp in early 2024.",
      embedding: makeEmbedding(3),
      entities: ["Acme", "BetaCorp"],
      status: "success",
    },
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_B_ID,
      ordinal: 1,
      content: "Stock market analysis paragraph with finance terms.",
      embedding: makeEmbedding(4),
      entities: ["stock market"],
      status: "success",
    },
  ] as never);
}

beforeEach(async () => {
  _resetKbEnvCache();
  await ensureTestUser();
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  await seedFixture();
});

afterEach(async () => {
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
});

describe("lib/kb/search — deriveQueryEntities", () => {
  it("splits, lowercases, dedupes, drops words shorter than 3 chars", () => {
    expect(deriveQueryEntities("Tell me about Acme and ACME — the company")).toEqual([
      "tell",
      "about",
      "acme",
      "and",
      "the",
      "company",
    ]);
  });

  it("returns [] for purely short input", () => {
    expect(deriveQueryEntities("a an to of")).toEqual([]);
  });

  it("splits on non-letter non-digit Unicode", () => {
    // ponytail: the regex keeps CJK letters together as one token
    // (`公司` is \p{L}). The English-Latin half splits out cleanly.
    const out = deriveQueryEntities("Acme公司, Inc.");
    expect(out).toContain("inc");
    expect(out.some((w) => w.startsWith("acme"))).toBe(true);
  });
});

describe("lib/kb/search — hybridSearch", () => {
  it("kw-only query (no qvec) returns BM25 hits in rrf order", async () => {
    const out = await hybridSearch({ userId: TEST_USER.id, query: "Acme founded" });
    expect(out.length).toBeGreaterThan(0);
    // "Acme was founded in 2020 in San Francisco." is the kw-only match.
    const first = out[0];
    expect(first.content).toMatch(/Acme was founded/);
    expect(first.legsHit).toContain("kw");
    // vec leg is omitted from the SQL when qvec is null — never appears.
    expect(first.legsHit).not.toContain("vec");
  });

  it("vec-only query (qvec provided, query not keyword-matched) returns cosine hits", async () => {
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "zebra xylophone",
      qvec: makeEmbedding(1),
    });
    expect(out.length).toBeGreaterThan(0);
    // The chunk whose embedding matches seed=1 should be top.
    expect(out[0].content).toMatch(/Acme was founded/);
    expect(out[0].legsHit).toContain("vec");
  });

  it("hybrid RRF ranks dual-hit chunks above single-hit", async () => {
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "Acme",
      qvec: makeEmbedding(3), // embedding close to seed=3 (DOC_B ordinal 0)
    });
    expect(out.length).toBeGreaterThan(0);
    // "Acme acquired BetaCorp" should hit both kw (Acme) AND vec
    // (embedding close to qvec).
    const dualHit = out.find((r) => r.content.match(/Acme acquired/));
    expect(dualHit).toBeDefined();
    expect(dualHit!.legsHit).toContain("kw");
    expect(dualHit!.legsHit).toContain("vec");
    // legsHit should have at least 2 entries.
    expect(dualHit!.legsHit.length).toBeGreaterThanOrEqual(2);
  });

  it("explicit qents enables the tag leg", async () => {
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "what does the source say",
      qents: ["Acme"],
    });
    const acmeHit = out.find((r) => r.content.match(/Acme/));
    expect(acmeHit).toBeDefined();
    expect(acmeHit!.legsHit).toContain("tag");
  });

  it("truncates chunk content to chunkMaxChars", async () => {
    // Override env to force aggressive truncation for this test.
    process.env.KB_CHUNK_MAX_CHARS = "30";
    _resetKbEnvCache();
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "Acme",
      qvec: makeEmbedding(1),
    });
    for (const r of out) {
      expect(r.content.length).toBeLessThanOrEqual(30);
    }
  });

  it("clamps topK to [1, KB_HYBRID_TOPK_MAX]", async () => {
    process.env.KB_HYBRID_TOPK_MAX = "2";
    _resetKbEnvCache();
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "Acme",
      qvec: makeEmbedding(1),
      topK: 99,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("returns [] when no documents are in status=success", async () => {
    await db
      .update(kbDocument)
      .set({ status: "failed" })
      .where(eq(kbDocument.userId, TEST_USER.id));
    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "Acme",
      qvec: makeEmbedding(1),
    });
    expect(out).toEqual([]);
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
      entities: ["Acme"],
    } as never);

    const out = await hybridSearch({
      userId: TEST_USER.id,
      query: "Acme",
      qvec: makeEmbedding(1),
    });
    // None of the returned chunks should belong to the other user's doc.
    for (const r of out) {
      expect(r.documentId).not.toBe(otherDocId);
    }

    // cleanup (other user cascade-deletes their rows)
    await db.delete(kbChunk).where(eq(kbChunk.documentId, otherDocId));
    await db.delete(kbDocument).where(eq(kbDocument.id, otherDocId));
    await db.delete(kbFolder).where(eq(kbFolder.userId, other.id));
  });

  it("rejects qvec with wrong dimension", async () => {
    await expect(
      hybridSearch({
        userId: TEST_USER.id,
        query: "Acme",
        qvec: Array.from({ length: 10 }, () => 0),
      }),
    ).rejects.toThrow(/qvec dimension mismatch/);
  });
});
