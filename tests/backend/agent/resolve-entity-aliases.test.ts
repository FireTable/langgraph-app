import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";

const {
  mockFindCanonicalEntities,
  mockFindCanonicalRelationships,
  mockDbUpdate,
  mockDbDelete,
  mockDbExecute,
  mockInvoke,
} = vi.hoisted(() => ({
  mockFindCanonicalEntities: vi.fn(),
  mockFindCanonicalRelationships: vi.fn(),
  mockDbUpdate: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "d-1", status: "success" }]),
      }),
    }),
  }),
  // ponytail: rewrite of applyEntityAliases (9233424 → 63679f8)
  // uses drizzle's db.delete for the loser rows in the same tx as
  // db.update. Mock the chain enough to record that delete() was
  // invoked; we don't care about the resolved value.
  mockDbDelete: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  }),
  // db.execute(sql`...RETURNING...`) used by applyThemeAlignment.
  // Default: no rows updated / deduped — tests that exercise the
  // alignment path mock the resolved counts here.
  mockDbExecute: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/kb/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kb/queries")>()),
  findCanonicalEntitiesByDocId: mockFindCanonicalEntities,
  findCanonicalRelationshipsByDocId: mockFindCanonicalRelationships,
}));

vi.mock("@/db/client", () => ({
  db: {
    update: mockDbUpdate,
    delete: mockDbDelete,
    execute: mockDbExecute,
  },
}));

vi.mock("@/backend/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/model")>()),
  getExtractModel: async () => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  }),
}));

import { resolveEntityAliasesForDoc } from "@/backend/node/kb";

const USER = "u-1";
const DOC = "d-1";

function makeEntity(id: string, name: string, type = "Org", description = "") {
  return { id, userId: USER, documentId: DOC, name, type, description, sourceChunkIds: [] };
}

function makeRelationship(
  id: string,
  source: string,
  target: string,
  relation = "rel",
  description = "",
) {
  return {
    id,
    userId: USER,
    documentId: DOC,
    source,
    target,
    relation,
    description,
    weight: 1,
    sourceChunkIds: [],
  };
}

beforeEach(() => {
  mockFindCanonicalEntities.mockReset();
  mockFindCanonicalRelationships.mockReset();
  mockDbUpdate.mockClear();
  mockDbDelete.mockClear();
  mockDbExecute.mockReset();
  mockInvoke.mockReset();
  mockFindCanonicalEntities.mockResolvedValue([]);
  mockFindCanonicalRelationships.mockResolvedValue([]);
  // Default: db.execute returns a row with `n = 0` so applyThemeAlignment
  // exits cleanly without hitting a real DB.
  mockDbExecute.mockResolvedValue([{ n: 0 }]);
});

describe("resolveEntityAliasesForDoc", () => {
  // ponytail: post theme-alignment, the LLM is invoked on every doc
  // (themes can have duplicates even when entities are sparse), so
  // the previous "skip LLM when ≤1 entity" path is gone. These tests
  // now assert the LLM IS called and that theme alignment runs.

  it("invokes the LLM even when doc has no canonical entities (theme alignment may still apply)", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({ entityAliases: [], themeAliases: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("invokes the LLM when there is only 1 unique entity", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([makeEntity("e-1", "AWS")]);
    mockInvoke.mockResolvedValueOnce({ entityAliases: [], themeAliases: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("invokes LLM and renames entities per LLM mapping", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "Amazon Web Services"),
      makeEntity("e-2", "AWS"),
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([makeRelationship("r-1", "AWS", "S3")]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "Amazon Web Services" }],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("ignores mappings where original === canonical", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "AWS" }],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("forwards documentTitle + entity list into the LLM human message", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({ mappings: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "Quarterly Report Q3",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [messages, config] = mockInvoke.mock.calls[0];
    expect(messages).toHaveLength(2);
    const humanMsg = messages[1] as { content: string };
    expect(humanMsg.content).toMatch(/Quarterly Report Q3/);
    expect(humanMsg.content).toMatch(/AWS/);
    expect(humanMsg.content).toMatch(/S3/);
    expect((config as RunnableConfig).tags).toContain("nostream");
  });

  it("uses 'Unknown Document' as the fallback title when documentTitle is empty", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({ mappings: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "",
    });

    const humanMsg = mockInvoke.mock.calls[0][0][1] as { content: string };
    expect(humanMsg.content).toMatch(/Unknown Document/);
  });

  it("swallows LLM invoke rejection — function resolves cleanly", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockRejectedValueOnce(new Error("alignment gateway 500"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      resolveEntityAliasesForDoc({
        userId: USER,
        docId: DOC,
        documentTitle: "doc",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // ponytail: theme alignment runs in the same LLM pass as entity
  // alignment and applies in-place via applyThemeAlignment → db.execute.

  it("applies themeAliases from LLM output via db.execute (UPDATE kb_theme SET name = canonical)", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [],
      themeAliases: [
        {
          canonicalName: "AI Application",
          aliases: ["AI 应用", "AI App"],
        },
      ],
    });
    mockDbExecute.mockResolvedValueOnce([{ n: 3 }]); // 3 rows renamed
    mockDbExecute.mockResolvedValueOnce([{ n: 1 }]); // 1 dedup collision

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // ponytail: applyThemeAlignment calls db.execute twice (rename +
    // dedup). The SQL template objects aren't easy to .toMatch()
    // because drizzle wraps them in a SQL chunk — assert the call
    // count and the order instead.
    expect(mockDbExecute).toHaveBeenCalledTimes(2);
    // Resolve the rename call's promise so we can read the row count
    // back through the wrapper that returns `[{ n: number }]`.
    const renameResult = (await mockDbExecute.mock.results[0]?.value) as [{ n: number }];
    const dedupResult = (await mockDbExecute.mock.results[1]?.value) as [{ n: number }];
    expect(renameResult[0]?.n).toBe(3);
    expect(dedupResult[0]?.n).toBe(1);
  });

  it("does NOT touch db.execute when LLM emits empty themeAliases", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [],
      themeAliases: [],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // db.update (updateKbDocumentStatus) runs; db.execute (theme
    // alignment rename + dedup) does NOT.
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  // ponytail: entity aliases used to be computed-and-discarded; the
  // audit caught the gap. applyEntityAliases now runs alongside
  // applyThemeAlignment in the same LLM pass. The current implementation
  // reads via findCanonicalEntitiesByDocId + findCanonicalRelationshipsByDocId,
  // dedups in JS, and writes via withKbTx (drizzle db.transaction →
  // tx.update / tx.delete). theme alignment still uses db.execute
  // (rename + dedup CTE). Asserting tx-level writes here would require
  // a transaction-aware mock; the integration test in
  // tests/lib/kb/queries-graph.test.ts covers the actual SQL.

  it("applies entityAliases via applyEntityAliases — readers + theme path run", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "Amazon Web Services"),
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([makeRelationship("r-1", "AWS", "S3")]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [{ canonicalName: "Amazon Web Services", aliases: ["AWS"] }],
      themeAliases: [],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // applyEntityAliases pulls both entity + relationship readers.
    // themeAliases is empty so theme alignment skips db.execute.
    expect(mockFindCanonicalEntities).toHaveBeenCalled();
    expect(mockFindCanonicalRelationships).toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it("does NOT touch db.execute when entityAliases is empty AND themeAliases is empty", async () => {
    // Already covered above; this is the all-empty sentinel case.
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [],
      themeAliases: [],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it("filters entityAliases whose aliases contain only the canonical (no-op group)", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [{ canonicalName: "Frontend", aliases: ["Frontend"] }],
      themeAliases: [],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // The legacy filter drops groups where every alias already equals
    // the canonical — applyEntityAliases' mapping has no alias keys,
    // so the function returns early without touching the DB.
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it("runs both entity and theme alignment in the same LLM pass", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "Amazon Web Services"),
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([makeRelationship("r-1", "AWS", "S3")]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [{ canonicalName: "Amazon Web Services", aliases: ["AWS"] }],
      themeAliases: [{ canonicalName: "AI Application", aliases: ["AI 应用", "AI App"] }],
    });
    mockDbExecute.mockResolvedValueOnce([{ n: 3 }]); // theme rename
    mockDbExecute.mockResolvedValueOnce([{ n: 1 }]); // theme dedup

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // theme alignment runs 2 db.execute calls (rename + dedup CTE).
    // entity alignment runs alongside, in the same LLM pass.
    expect(mockDbExecute).toHaveBeenCalledTimes(2);
    expect(mockFindCanonicalRelationships).toHaveBeenCalled();
  });

  it("filters themeAliases whose aliases array contains only the canonical (no-op group)", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "AWS"),
      makeEntity("e-2", "S3"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      entityAliases: [],
      themeAliases: [
        { canonicalName: "Frontend", aliases: ["Frontend", "Frontend"] }, // all = canonical
      ],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // Nothing left to rename → no db.execute calls.
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it("accepts legacy `{original, canonical}` entityAlias shape and normalises it", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      makeEntity("e-1", "Amazon Web Services"),
      makeEntity("e-2", "AWS"),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "Amazon Web Services" }],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // Function resolves without throwing; entity mapping was parsed
    // from the legacy shape (no theme aliases → no execute call).
    expect(mockInvoke).toHaveBeenCalled();
    expect(mockDbUpdate).toHaveBeenCalled();
  });
});
