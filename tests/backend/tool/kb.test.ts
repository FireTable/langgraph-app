import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

vi.mock("@/backend/model", () => ({
  getEmbeddingModel: vi.fn(async () => ({
    embedQuery: vi.fn(async (q: string) => {
      if (q.includes("unrelated")) {
        throw new Error("Simulated embedding failure for unrelated query");
      }
      const out = [];
      for (let i = 0; i < 1024; i++) out.push(0.001);
      return out;
    }),
  })),
}));

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import {
  _resetPgVectorCache,
  formatSearchResult,
  isPgVectorAvailable,
  listKbDocumentsForUser,
  listKbFoldersForUser,
  LIST_DOCUMENTS_STATUSES,
  searchKbTool,
  setKbToolUserId,
} from "@/backend/tool/kb";
import { TEST_USER, ensureTestUser, makeUser } from "@/tests/helpers/auth";

// ponytail: tool tests run against the real DB (pgvector is loaded in
// dev + test). The gating test stubs `_resetPgVectorCache(false)` to
// simulate a DB without the extension — the tool must throw a clear
// error rather than crash.

function makeEmbedding(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i * 0.01) * 0.001);
  return out;
}

const FOLDER_ID = `f-${randomUUID()}`;
const DOC_A_ID = `d-${randomUUID()}`;

async function seedFixture() {
  await db.insert(kbFolder).values({ id: FOLDER_ID, userId: TEST_USER.id, name: "Attachments" });
  await db.insert(kbDocument).values({
    id: DOC_A_ID,
    userId: TEST_USER.id,
    folderId: FOLDER_ID,
    title: "alpha.pdf",
    contentType: "application/pdf",
    contentHash: `hash-${randomUUID()}`,
    status: "success",
  });
  await db.insert(kbChunk).values([
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 0,
      content: "Acme was founded in 2020 in San Francisco.",
      embedding: makeEmbedding(1),
      entities: [
        { name: "Acme", type: "Organization", description: "Acme company" },
        { name: "San Francisco", type: "Location", description: "SF city" },
      ],
      // ponytail: explicit status='success' because kb_chunk.status
      // defaults to 'pending' and lib/kb/search.ts filters on
      // status='success'. The fixture seeds a known-good pool.
      status: "success",
    },
    {
      id: `c-${randomUUID()}`,
      documentId: DOC_A_ID,
      ordinal: 1,
      content: "Acme acquired BetaCorp in early 2024.",
      embedding: makeEmbedding(3),
      entities: [
        { name: "Acme", type: "Organization", description: "Acme company" },
        { name: "BetaCorp", type: "Organization", description: "Acquired company" },
      ],
      status: "success",
    },
  ] as never);
}

beforeEach(async () => {
  _resetPgVectorCache(null); // re-check from DB
  await ensureTestUser();
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  setKbToolUserId(TEST_USER.id);
  await seedFixture();
});

afterEach(async () => {
  _resetPgVectorCache(null);
  setKbToolUserId("");
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
});

describe("backend/tool/kb — gating", () => {
  it("isPgVectorAvailable returns true in dev/test DB", async () => {
    expect(await isPgVectorAvailable()).toBe(true);
  });

  it("tool throws a clear error when pgvector is unavailable", async () => {
    _resetPgVectorCache(false);
    // search_kb is now registered unconditionally — the gate is inside.
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    await expect(tool.invoke({ query: "Acme", topK: 3 })).rejects.toThrow(
      /pgvector extension is not installed/,
    );
  });
});

describe("backend/tool/kb — search_kb ToolMessage shape", () => {
  it("returns structured JSON with content (numbered) + documents array", async () => {
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    const raw = await tool.invoke({ query: "Acme", topK: 3 });
    const parsed = JSON.parse(raw);
    expect(parsed.empty).toBe(false);
    expect(typeof parsed.content).toBe("string");
    expect(Array.isArray(parsed.documents)).toBe(true);
    expect(parsed.documents.length).toBeGreaterThan(0);
  });

  it("content embeds [1] [2] markers and NEVER exposes numeric rrfScore", async () => {
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    const raw = await tool.invoke({ query: "Acme", topK: 3 });
    const parsed = JSON.parse(raw);
    // ponytail: the LLM string never contains the score (community
    // consensus — scores are ranking metadata only).
    expect(parsed.content).toMatch(/^\[1\] /);
    expect(parsed.content).not.toMatch(/0\.\d/); // no rrfScore-like decimal
    expect(parsed.content).not.toMatch(/legs_hit/i);
  });

  it("documents array carries rrfScore + legsHit + chunkId for UI", async () => {
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    const raw = await tool.invoke({ query: "Acme", topK: 3 });
    const parsed = JSON.parse(raw);
    const doc = parsed.documents[0];
    expect(doc).toHaveProperty("chunkId");
    expect(doc).toHaveProperty("documentId");
    expect(doc).toHaveProperty("docTitle");
    expect(doc).toHaveProperty("content");
    expect(typeof doc.rrfScore).toBe("number");
    expect(Array.isArray(doc.legsHit)).toBe(true);
  });

  it("clamps topK above KB_HYBRID_TOPK_MAX", async () => {
    process.env.KB_HYBRID_TOPK_MAX = "1";
    // env cached at module load — clear cache for next read.
    const { _resetKbEnvCache } = await import("@/lib/kb/env");
    _resetKbEnvCache();
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    const raw = await tool.invoke({ query: "Acme", topK: 99 });
    const parsed = JSON.parse(raw);
    expect(parsed.documents.length).toBeLessThanOrEqual(1);
    delete process.env.KB_HYBRID_TOPK_MAX;
    _resetKbEnvCache();
  });

  it("returns empty result when no docs match", async () => {
    const tool = searchKbTool as unknown as { invoke: (args: unknown) => Promise<string> };
    const raw = await tool.invoke({ query: "completely-unrelated-zzz", topK: 3 });
    const parsed = JSON.parse(raw);
    expect(parsed.empty).toBe(true);
    expect(parsed.documents).toEqual([]);
    expect(parsed.content).toBe("");
  });
});

describe("backend/tool/kb — list_documents SQL helper", () => {
  it("lists user's success docs by default", async () => {
    const out = await listKbDocumentsForUser({ userId: TEST_USER.id });
    expect(out.total).toBe(1);
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0].id).toBe(DOC_A_ID);
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(20);
  });

  it("filters by status", async () => {
    const out = await listKbDocumentsForUser({
      userId: TEST_USER.id,
      status: "failed",
    });
    expect(out.documents).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("filters by title substring (case-insensitive)", async () => {
    const out = await listKbDocumentsForUser({
      userId: TEST_USER.id,
      titleQuery: "ALPHA",
    });
    expect(out.documents).toHaveLength(1);

    const miss = await listKbDocumentsForUser({
      userId: TEST_USER.id,
      titleQuery: "no-match-xxx",
    });
    expect(miss.documents).toEqual([]);
  });

  it("filters by folderId", async () => {
    const out = await listKbDocumentsForUser({
      userId: TEST_USER.id,
      folderId: "f-nonexistent",
    });
    expect(out.documents).toEqual([]);
  });

  it("paginates", async () => {
    const out = await listKbDocumentsForUser({
      userId: TEST_USER.id,
      pageSize: 1,
    });
    expect(out.documents).toHaveLength(1);
    expect(out.total).toBe(1);
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
    await db.insert(kbDocument).values({
      id: `d-${randomUUID()}`,
      userId: other.id,
      folderId: otherFolderId,
      title: "secret.pdf",
      contentType: "application/pdf",
      contentHash: `hash-other-${randomUUID()}`,
      status: "success",
    });

    const out = await listKbDocumentsForUser({ userId: TEST_USER.id });
    expect(out.documents.find((d) => d.userId === other.id)).toBeUndefined();

    // cleanup
    await db.delete(kbDocument).where(eq(kbDocument.userId, other.id));
    await db.delete(kbFolder).where(eq(kbFolder.userId, other.id));
  });
});

describe("backend/tool/kb — listKbFoldersForUser", () => {
  it("returns the user's folders", async () => {
    const folders = await listKbFoldersForUser(TEST_USER.id);
    expect(folders.find((f) => f.id === FOLDER_ID)).toBeDefined();
  });
});

describe("backend/tool/kb — formatSearchResult", () => {
  it("formats empty results", () => {
    const r = formatSearchResult([], 2000);
    expect(r.empty).toBe(true);
    expect(r.content).toBe("");
    expect(r.documents).toEqual([]);
  });

  it("numbers chunks [1] [2] in order", () => {
    const r = formatSearchResult(
      [
        {
          chunkId: "c1",
          documentId: "d1",
          docTitle: "doc.pdf",
          pageNumbers: [],
          content: "alpha content",
          rrfScore: 0.1,
          legsHit: ["kw"],
        },
        {
          chunkId: "c2",
          documentId: "d1",
          docTitle: "doc.pdf",
          pageNumbers: [],
          content: "beta content",
          rrfScore: 0.05,
          legsHit: ["vec"],
        },
      ],
      2000,
    );
    expect(r.content).toBe("[1] alpha content\n\n[2] beta content");
    expect(r.documents[0].chunkId).toBe("c1");
    expect(r.documents[1].chunkId).toBe("c2");
  });

  it("truncates per chunk to chunkMaxChars", () => {
    const long = "x".repeat(500);
    const r = formatSearchResult(
      [
        {
          chunkId: "c1",
          documentId: "d1",
          docTitle: "doc.pdf",
          pageNumbers: [],
          content: long,
          rrfScore: 0.1,
          legsHit: ["kw"],
        },
      ],
      100,
    );
    // content has [1] prefix (3 chars) + space + 100 chars + ellipsis
    expect(r.content.length).toBeLessThanOrEqual(110);
    expect(r.content).toMatch(/…$/);
    // documents[].content keeps the full chunk for UI
    expect(r.documents[0].content).toBe(long);
  });
});

describe("backend/tool/kb — LIST_DOCUMENTS_STATUSES", () => {
  it("exposes the four valid statuses", () => {
    expect(LIST_DOCUMENTS_STATUSES).toEqual(["success", "failed", "parsing", "pending"]);
  });
});
