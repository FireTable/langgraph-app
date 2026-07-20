// ponytail: TDD coverage for `resolveEntityAliasesForDoc` — the
// alignment step that runs after a doc's chunks are all `success`.
// Currently inlined inside generateChunkEmbedNode's IIFE; extracted
// here so it can be unit-tested without spinning up the whole graph
// and waiting on the fire-and-forget background pipeline. Function
// signature stays pure (args in, void out) — not a LangGraph node.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";

const { mockFindChunks, mockUpdateGraphData, mockInvoke } = vi.hoisted(() => ({
  mockFindChunks: vi.fn(),
  mockUpdateGraphData: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/kb/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kb/queries")>()),
  findKbChunksByDocumentId: mockFindChunks,
  updateKbChunkGraphData: mockUpdateGraphData,
}));

vi.mock("@/backend/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/model")>()),
  getExtractModel: async () => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  }),
}));

import { resolveEntityAliasesForDoc } from "@/backend/agent/kb-agent";

const USER = "u-1";
const DOC = "d-1";

function makeChunk(
  id: string,
  entities: Array<{ name: string; type: string; description: string }>,
  relationships: Array<{
    source: string;
    target: string;
    relation: string;
    description: string;
  }> = [],
  status: "pending" | "parsing" | "success" | "failed" = "success",
) {
  return { id, status, entities, relationships };
}

beforeEach(() => {
  mockFindChunks.mockReset();
  mockUpdateGraphData.mockReset();
  mockInvoke.mockReset();
  // Default: empty chunks — per-test overrides.
  mockFindChunks.mockResolvedValue([]);
});

describe("resolveEntityAliasesForDoc", () => {
  it("does not invoke the LLM when the doc has no chunks", async () => {
    mockFindChunks.mockResolvedValueOnce([]);
    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockUpdateGraphData).not.toHaveBeenCalled();
  });

  it("does not invoke the LLM when no chunks have entities", async () => {
    mockFindChunks.mockResolvedValueOnce([makeChunk("c-1", []), makeChunk("c-2", [])]);
    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockUpdateGraphData).not.toHaveBeenCalled();
  });

  it("skips chunks whose status is not 'success' when collecting entity names", async () => {
    // ponytail: the post-processor only renames entities inside
    // successfully-embedded chunks — failed / parsing chunks are
    // excluded so a half-broken doc doesn't pollute the alignment
    // pass with stale names. Two surviving entities (sourced from
    // success chunks) force the LLM call — singleton short-circuits
    // before it.
    mockFindChunks.mockResolvedValueOnce([
      makeChunk(
        "c-ok-1",
        [{ name: "Amazon Web Services", type: "Org", description: "" }],
        [],
        "success",
      ),
      makeChunk("c-ok-2", [{ name: "AWS", type: "Org", description: "" }], [], "success"),
      makeChunk(
        "c-failed",
        [{ name: "ShouldNotInfluence", type: "X", description: "" }],
        [],
        "failed",
      ),
      makeChunk("c-parsing", [{ name: "AlsoIgnored", type: "X", description: "" }], [], "parsing"),
    ]);
    mockInvoke.mockResolvedValueOnce({ mappings: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const humanMsg = mockInvoke.mock.calls[0][0][1] as { content: string };
    expect(humanMsg.content).toContain("Amazon Web Services");
    expect(humanMsg.content).toContain("AWS");
    expect(humanMsg.content).not.toContain("ShouldNotInfluence");
    expect(humanMsg.content).not.toContain("AlsoIgnored");
  });

  it("does not invoke the LLM when there is only one unique entity (can't align singletons)", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [{ name: "AWS", type: "Org", description: "" }]),
    ]);
    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockUpdateGraphData).not.toHaveBeenCalled();
  });

  it("renames entities + relationship endpoints per LLM mapping", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk(
        "c-1",
        [
          { name: "Amazon Web Services", type: "Org", description: "cloud" },
          { name: "AWS", type: "Org", description: "same cloud" },
        ],
        [
          {
            source: "AWS",
            target: "S3",
            relation: "offers",
            description: "AWS offers S3",
          },
          {
            source: "Amazon Web Services",
            target: "EC2",
            relation: "offers",
            description: "AWS offers EC2",
          },
        ],
      ),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [
        { original: "AWS", canonical: "Amazon Web Services" },
        { original: "aws", canonical: "Amazon Web Services" }, // duplicate lowercase
      ],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // Only the affected chunk gets a write-back.
    expect(mockUpdateGraphData).toHaveBeenCalledTimes(1);
    const [chunkId, entities, relationships] = mockUpdateGraphData.mock.calls[0];
    expect(chunkId).toBe("c-1");
    // Both entity names converge to the canonical.
    expect(entities).toEqual([
      { name: "Amazon Web Services", type: "Org", description: "cloud" },
      { name: "Amazon Web Services", type: "Org", description: "same cloud" },
    ]);
    // Both relationships' source renames; targets untouched.
    expect(relationships).toEqual([
      {
        source: "Amazon Web Services",
        target: "S3",
        relation: "offers",
        description: "AWS offers S3",
      },
      {
        source: "Amazon Web Services",
        target: "EC2",
        relation: "offers",
        description: "AWS offers EC2",
      },
    ]);
  });

  it("passes through chunks that have no renamed elements", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk(
        "c-affected",
        [
          { name: "AWS", type: "Org", description: "" },
          { name: "Amazon Web Services", type: "Org", description: "" },
        ],
        [],
      ),
      makeChunk("c-clean", [{ name: "S3", type: "Service", description: "" }], []),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "Amazon Web Services" }],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    // Only the chunk that actually had a renamed entity gets a write.
    expect(mockUpdateGraphData).toHaveBeenCalledTimes(1);
    expect(mockUpdateGraphData.mock.calls[0][0]).toBe("c-affected");
  });

  it("ignores mappings where original === canonical (no-op entries)", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [
        { name: "AWS", type: "Org", description: "" },
        { name: "S3", type: "Service", description: "" },
      ]),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "AWS" }],
    });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "doc",
    });

    expect(mockUpdateGraphData).not.toHaveBeenCalled();
  });

  it("forwards documentTitle + entity list into the LLM human message", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [
        { name: "AWS", type: "Org", description: "" },
        { name: "S3", type: "Service", description: "" },
      ]),
    ]);
    mockInvoke.mockResolvedValueOnce({ mappings: [] });

    await resolveEntityAliasesForDoc({
      userId: USER,
      docId: DOC,
      documentTitle: "Quarterly Report Q3",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [messages, config] = mockInvoke.mock.calls[0];
    // System + human message order.
    expect(messages).toHaveLength(2);
    const humanMsg = messages[1] as { content: string };
    expect(humanMsg.content).toMatch(/Quarterly Report Q3/);
    expect(humanMsg.content).toMatch(/"AWS"/);
    expect(humanMsg.content).toMatch(/"S3"/);
    // Tags pinned so alignment calls don't get streamed to the UI.
    expect((config as RunnableConfig).tags).toContain("nostream");
  });

  it("uses 'Unknown Document' as the fallback title when documentTitle is empty", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [
        { name: "AWS", type: "Org", description: "" },
        { name: "S3", type: "Service", description: "" },
      ]),
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

  it("swallows LLM invoke rejection — function resolves cleanly, no writes", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [
        { name: "AWS", type: "Org", description: "" },
        { name: "S3", type: "Service", description: "" },
      ]),
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

    expect(mockUpdateGraphData).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/alignment failed/);
    errorSpy.mockRestore();
  });

  it("swallows DB write rejection — function still resolves cleanly", async () => {
    mockFindChunks.mockResolvedValueOnce([
      makeChunk("c-1", [
        { name: "AWS", type: "Org", description: "" },
        { name: "Amazon Web Services", type: "Org", description: "" },
      ]),
    ]);
    mockInvoke.mockResolvedValueOnce({
      mappings: [{ original: "AWS", canonical: "Amazon Web Services" }],
    });
    mockUpdateGraphData.mockRejectedValueOnce(new Error("DB connection lost"));
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
