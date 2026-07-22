import { describe, it, expect, beforeEach, vi } from "vitest";

const mockEmbedDocuments = vi.fn();
const mockFindCanonicalEntities = vi.fn();
const mockFindCanonicalRelationships = vi.fn();
const mockFindKbThemesByChunkIds = vi.fn();
const mockFindKbChunksByDocumentId = vi.fn();
const mockFindKbChunksGraphContext = vi.fn();
const mockUpsertEntityEmbedding = vi.fn();
const mockUpsertRelationshipEmbedding = vi.fn();
const mockUpsertChunkEmbedding = vi.fn();

vi.mock("@/backend/model", () => ({
  getEmbeddingModel: async () => ({
    embedDocuments: (...args: unknown[]) => mockEmbedDocuments(...args),
  }),
}));

vi.mock("@/lib/kb/queries", () => ({
  findCanonicalEntitiesByDocId: (...args: unknown[]) => mockFindCanonicalEntities(...args),
  findCanonicalRelationshipsByDocId: (...args: unknown[]) =>
    mockFindCanonicalRelationships(...args),
  findKbChunksByDocumentId: (...args: unknown[]) => mockFindKbChunksByDocumentId(...args),
  findKbChunksGraphContext: (...args: unknown[]) => mockFindKbChunksGraphContext(...args),
  findKbThemesByChunkIds: (...args: unknown[]) => mockFindKbThemesByChunkIds(...args),
  upsertEntityEmbedding: (...args: unknown[]) => mockUpsertEntityEmbedding(...args),
  upsertRelationshipEmbedding: (...args: unknown[]) => mockUpsertRelationshipEmbedding(...args),
  upsertChunkEmbedding: (...args: unknown[]) => mockUpsertChunkEmbedding(...args),
}));

import { entityEmbedNode } from "@/backend/node/kb/entity-embed-node";
import type { KbAgentStateShape } from "@/backend/state";

const baseFile = {
  messageIndex: 0,
  filePart: { type: "file", data: "d" },
  docId: "d-1",
  attachmentId: "a-1",
  r2Key: "k-1",
  title: "doc",
  contentHash: "h-1",
  contentType: "application/pdf",
  errorMessage: null,
};

const baseState = (
  overrides: Partial<KbAgentStateShape> & { pipelineStatus: string },
): KbAgentStateShape =>
  ({
    userId: "u-1",
    messages: [],
    mode: "full",
    docId: null,
    pagesByDocId: {},
    processedFiles: [{ ...baseFile, pipelineStatus: overrides.pipelineStatus }],
    status: "parsing",
    errorMessage: null,
    entityExtractedChunks: [],
    alignedEntities: [],
    entityEmbeddings: [],
    ...overrides,
  }) as unknown as KbAgentStateShape;

beforeEach(() => {
  mockEmbedDocuments.mockReset();
  mockFindCanonicalEntities.mockReset();
  mockFindCanonicalRelationships.mockReset();
  mockFindKbChunksByDocumentId.mockReset();
  mockFindKbChunksGraphContext.mockReset();
  mockFindKbThemesByChunkIds.mockReset();
  mockUpsertEntityEmbedding.mockReset();
  mockUpsertRelationshipEmbedding.mockReset();
  mockUpsertChunkEmbedding.mockReset();
  // Default: no themes — matches the audit §13b 456 case where the
  // chunk has no row in kb_theme and the embed text uses just name /
  // type / description.
  mockFindKbThemesByChunkIds.mockResolvedValue(new Map<string, string[]>());
  // Default: no chunks — entity / relationship legs only. Tests that
  // exercise the new chunk leg override this.
  mockFindKbChunksByDocumentId.mockResolvedValue([]);
  // Default: empty graph context for any chunk set we receive.
  mockFindKbChunksGraphContext.mockResolvedValue({
    entitiesByChunk: new Map<string, Array<{ name: string; type: string }>>(),
    relsByChunk: new Map<string, Array<{ source: string; target: string; relation: string }>>(),
  });
});

describe("entityEmbedNode", () => {
  it("embeds entities and relationships for new docs lacking embeddings", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      { id: "e-1", name: "AWS", type: "Org", description: "Cloud provider", embedding: null },
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([
      {
        id: "r-1",
        source: "AWS",
        relation: "PROVIDES",
        target: "S3",
        description: "Storage service",
        embedding: null,
      },
    ]);

    mockEmbedDocuments
      .mockResolvedValueOnce([[0.1, 0.2]]) // entity vector
      .mockResolvedValueOnce([[0.3, 0.4]]); // rel vector

    const result = await entityEmbedNode(baseState({ pipelineStatus: "new" } as never));

    expect(result.status).toBe("success");
    expect(result.entityEmbeddings).toEqual(["e-1", "r-1"]);

    expect(mockEmbedDocuments).toHaveBeenCalledTimes(2);
    expect(mockEmbedDocuments).toHaveBeenNthCalledWith(1, ["AWS (Org): Cloud provider"]);
    expect(mockEmbedDocuments).toHaveBeenNthCalledWith(2, [
      "AWS -> PROVIDES -> S3: Storage service",
    ]);

    expect(mockUpsertEntityEmbedding).toHaveBeenCalledWith("e-1", [0.1, 0.2]);
    expect(mockUpsertRelationshipEmbedding).toHaveBeenCalledWith("r-1", [0.3, 0.4]);
  });

  it("prepends chunk themes to entity embed text (audit §13b 456)", async () => {
    // The entity references two source chunks; both carry themes.
    // Embed text should suffix the themes so the ANN vector reflects
    // the chunk-level macro topics, not just the entity-level fields.
    mockFindKbThemesByChunkIds.mockResolvedValueOnce(
      new Map([
        ["c-1", ["Funding", "Growth"]],
        ["c-2", ["Funding", "Market"]],
      ]),
    );
    mockFindCanonicalEntities.mockResolvedValueOnce([
      {
        id: "e-1",
        name: "Acme",
        type: "Org",
        description: "founded 2020",
        embedding: null,
        sourceChunkIds: ["c-1", "c-2"],
      },
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockEmbedDocuments.mockResolvedValueOnce([[0.1, 0.2]]);

    const result = await entityEmbedNode(baseState({ pipelineStatus: "new" } as never));

    expect(result.entityEmbeddings).toEqual(["e-1"]);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(1);
    const embedArgs = mockEmbedDocuments.mock.calls[0]![0] as string[];
    expect(embedArgs).toHaveLength(1);
    expect(embedArgs[0]).toMatch(/^Acme \(Org\): founded 2020 /);
    // Themes tail of the embed text — order preserved, deduped.
    const tail = embedArgs[0]!.split(": founded 2020 ")[1] ?? "";
    expect(tail.split(" ").sort()).toEqual(["Funding", "Growth", "Market"]);
  });

  it("prepends chunk themes to relationship embed text", async () => {
    mockFindKbThemesByChunkIds.mockResolvedValueOnce(new Map([["c-1", ["Partnership"]]]));
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([
      {
        id: "r-1",
        source: "Acme",
        relation: "PARTNERED",
        target: "Beta",
        description: "2020 deal",
        embedding: null,
        sourceChunkIds: ["c-1"],
      },
    ]);
    mockEmbedDocuments.mockResolvedValueOnce([[0.5, 0.6]]);

    const result = await entityEmbedNode(baseState({ pipelineStatus: "new" } as never));

    expect(result.entityEmbeddings).toEqual(["r-1"]);
    expect(mockEmbedDocuments).toHaveBeenCalledWith([
      "Acme -> PARTNERED -> Beta: 2020 deal Partnership",
    ]);
  });

  it("omits themes suffix entirely when entity has no sourceChunkIds", async () => {
    // No sourceChunkIds → findKbThemesByChunkIds is never called and
    // the embed text uses only name / type / description.
    mockFindCanonicalEntities.mockResolvedValueOnce([
      {
        id: "e-1",
        name: "Acme",
        type: "Org",
        description: "founded 2020",
        embedding: null,
        // sourceChunkIds intentionally omitted
      },
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockEmbedDocuments.mockResolvedValueOnce([[0.1, 0.2]]);

    await entityEmbedNode(baseState({ pipelineStatus: "new" } as never));

    expect(mockFindKbThemesByChunkIds).not.toHaveBeenCalled();
    expect(mockEmbedDocuments).toHaveBeenCalledWith(["Acme (Org): founded 2020"]);
  });

  it("skips embedding if entities and relationships already have embeddings", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      { id: "e-1", name: "AWS", type: "Org", description: "Cloud", embedding: [0.1] },
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([
      { id: "r-1", source: "AWS", relation: "PROVIDES", target: "S3", embedding: [0.2] },
    ]);

    const result = await entityEmbedNode(baseState({ pipelineStatus: "new" } as never));

    expect(result.status).toBe("success");
    expect(result.entityEmbeddings).toEqual([]);
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });

  it("skips files with pipelineStatus failed or unknown", async () => {
    const state = baseState({
      pipelineStatus: "failed",
      status: "failed",
      errorMessage: "ocr failed",
    } as never);

    const result = await entityEmbedNode(state);

    expect(result.status).toBe("failed");
    expect(mockFindCanonicalEntities).not.toHaveBeenCalled();
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });
});

// ponytail: chunk-embed leg added — chunk vectors now encode the
// augmented text (content + per-chunk entities + per-chunk rels +
// per-chunk themes) so the ANN dense leg matches LightRAG's
// dual-level concept. entityExtractNode inserts chunks with NULL
// embedding, entityEmbedNode fills them in after alignment runs.

describe("entityEmbedNode — chunk leg (lightRAG augmented text)", () => {
  it("embeds a fresh chunk with augmented text (content + entities + rels + themes)", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockFindKbChunksByDocumentId.mockResolvedValueOnce([
      {
        id: "c-1",
        documentId: "d-1",
        ordinal: 0,
        content: "Acme partnered with BetaCorp in 2020.",
        embedding: null,
        status: "success",
      } as never,
    ]);
    mockFindKbChunksGraphContext.mockResolvedValueOnce({
      entitiesByChunk: new Map([
        [
          "c-1",
          [
            { name: "Acme", type: "Organization" },
            { name: "BetaCorp", type: "Organization" },
          ],
        ],
      ]),
      relsByChunk: new Map([
        ["c-1", [{ source: "Acme", relation: "PARTNERED_WITH", target: "BetaCorp" }]],
      ]),
    });
    mockFindKbThemesByChunkIds.mockResolvedValueOnce(new Map([["c-1", ["Funding", "Market"]]]));
    mockEmbedDocuments.mockResolvedValueOnce([[0.7, 0.8, 0.9]]);

    const result = await entityEmbedNode(
      baseState({
        pipelineStatus: "new",
        entityExtractedChunks: ["c-1"],
      } as never),
    );

    expect(result.entityEmbeddings).toEqual(["c-1"]);
    expect(mockEmbedDocuments).toHaveBeenCalledTimes(1);
    const embedArgs = mockEmbedDocuments.mock.calls[0]![0] as string[];
    expect(embedArgs).toHaveLength(1);
    // Order: content first, then Entities / Relationships / Themes only
    // if non-empty.
    expect(embedArgs[0]).toContain("Acme partnered with BetaCorp in 2020.");
    expect(embedArgs[0]).toContain("Entities: Acme (Organization), BetaCorp (Organization)");
    expect(embedArgs[0]).toContain("Relationships: Acme -> PARTNERED_WITH -> BetaCorp");
    expect(embedArgs[0]).toContain("Themes: Funding, Market");
    expect(mockUpsertChunkEmbedding).toHaveBeenCalledWith("c-1", [0.7, 0.8, 0.9]);
  });

  it("re-embeds a chunk when state.entityExtractedChunks names it (retry path)", async () => {
    // Simulating a retried chunk: status=success, embedding exists
    // already (older bge-m3 vector), but entityExtractedChunks
    // contains its id because LLM extract re-ran and got new graph
    // metadata. entityEmbedNode must recompute so the vector reflects
    // the post-alignment canonical names.
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockFindKbChunksByDocumentId.mockResolvedValueOnce([
      {
        id: "c-1",
        documentId: "d-1",
        ordinal: 0,
        content: "Updated text.",
        embedding: [0.1, 0.2],
        status: "success",
      } as never,
    ]);
    mockFindKbChunksGraphContext.mockResolvedValueOnce({
      entitiesByChunk: new Map(),
      relsByChunk: new Map(),
    });
    mockFindKbThemesByChunkIds.mockResolvedValueOnce(new Map());
    mockEmbedDocuments.mockResolvedValueOnce([[0.5, 0.6]]);

    const result = await entityEmbedNode(
      baseState({
        pipelineStatus: "parsing",
        entityExtractedChunks: ["c-1"],
      } as never),
    );

    expect(result.entityEmbeddings).toEqual(["c-1"]);
    expect(mockUpsertChunkEmbedding).toHaveBeenCalledWith("c-1", [0.5, 0.6]);
  });

  it("skips chunks whose embedding exists AND entityExtractedChunks does not name them", async () => {
    // Path: doc was processed previously, all chunks already have
    // valid embeddings and LLM extract didn't run this pass. No
    // recompute.
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockFindKbChunksByDocumentId.mockResolvedValueOnce([
      {
        id: "c-1",
        documentId: "d-1",
        ordinal: 0,
        content: "stale text.",
        embedding: [0.1, 0.2],
        status: "success",
      } as never,
    ]);

    const result = await entityEmbedNode(
      baseState({
        pipelineStatus: "new",
        entityExtractedChunks: [],
      } as never),
    );

    expect(mockEmbedDocuments).not.toHaveBeenCalled();
    expect(mockUpsertChunkEmbedding).not.toHaveBeenCalled();
    // Entity / rel legs also fire-zero; status was reported as success
    // because the doc had no work to do this pass.
    expect(result.entityEmbeddings).toEqual([]);
  });

  it("skips chunks with status='failed' even if name is in entityExtractedChunks", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockFindKbChunksByDocumentId.mockResolvedValueOnce([
      // Failed chunk re-appears in entityExtractedChunks (LLM extract
      // retried it then marked success later). Defensive: only the
      // post-success chunk passes through; status='failed' is skipped.
      // For this test we mark it failed so the filter excludes it.
      {
        id: "c-1",
        documentId: "d-1",
        ordinal: 0,
        content: "x",
        embedding: null,
        status: "failed",
      } as never,
    ]);

    const result = await entityEmbedNode(
      baseState({
        pipelineStatus: "new",
        entityExtractedChunks: ["c-1"],
      } as never),
    );

    expect(mockEmbedDocuments).not.toHaveBeenCalled();
    expect(mockUpsertChunkEmbedding).not.toHaveBeenCalled();
    expect(result.entityEmbeddings).toEqual([]);
  });

  it("augmented text omits empty sections — content alone if no graph metadata", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([]);
    mockFindKbChunksByDocumentId.mockResolvedValueOnce([
      {
        id: "c-1",
        documentId: "d-1",
        ordinal: 0,
        content: "Solo text.",
        embedding: null,
        status: "success",
      } as never,
    ]);
    // graph context for c-1 is empty (default mockFindKbChunksGraphContext
    // would return empty maps — keep them but make sure c-1 is missing).
    mockFindKbChunksGraphContext.mockResolvedValueOnce({
      entitiesByChunk: new Map(),
      relsByChunk: new Map(),
    });
    mockFindKbThemesByChunkIds.mockResolvedValueOnce(new Map());
    mockEmbedDocuments.mockResolvedValueOnce([[0.9]]);

    await entityEmbedNode(
      baseState({
        pipelineStatus: "new",
        entityExtractedChunks: ["c-1"],
      } as never),
    );

    const embedArgs = mockEmbedDocuments.mock.calls[0]![0] as string[];
    expect(embedArgs).toHaveLength(1);
    // Empty graph sections → no trailing headers like "Entities:" etc.
    expect(embedArgs[0]).toBe("Solo text.");
  });
});
