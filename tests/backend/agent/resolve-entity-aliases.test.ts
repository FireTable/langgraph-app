import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";

const { mockFindCanonicalEntities, mockFindCanonicalRelationships, mockDbUpdate, mockInvoke } =
  vi.hoisted(() => ({
    mockFindCanonicalEntities: vi.fn(),
    mockFindCanonicalRelationships: vi.fn(),
    mockDbUpdate: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "d-1", status: "success" }]),
        }),
      }),
    }),
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
  mockInvoke.mockReset();
  mockFindCanonicalEntities.mockResolvedValue([]);
  mockFindCanonicalRelationships.mockResolvedValue([]);
});

describe("resolveEntityAliasesForDoc", () => {
  it("does not invoke the LLM when doc has no canonical entities", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("does not invoke the LLM when there is only 1 unique entity", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([makeEntity("e-1", "AWS")]);
    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
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
});
