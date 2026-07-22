import { describe, it, expect, beforeEach, vi } from "vitest";

const mockEmbedDocuments = vi.fn();
const mockFindCanonicalEntities = vi.fn();
const mockFindCanonicalRelationships = vi.fn();
const mockFindKbThemesByChunkIds = vi.fn();
const mockUpsertEntityEmbedding = vi.fn();
const mockUpsertRelationshipEmbedding = vi.fn();

vi.mock("@/backend/model", () => ({
  getEmbeddingModel: async () => ({
    embedDocuments: (...args: unknown[]) => mockEmbedDocuments(...args),
  }),
}));

vi.mock("@/lib/kb/queries", () => ({
  findCanonicalEntitiesByDocId: (...args: unknown[]) => mockFindCanonicalEntities(...args),
  findCanonicalRelationshipsByDocId: (...args: unknown[]) =>
    mockFindCanonicalRelationships(...args),
  findKbThemesByChunkIds: (...args: unknown[]) => mockFindKbThemesByChunkIds(...args),
  upsertEntityEmbedding: (...args: unknown[]) => mockUpsertEntityEmbedding(...args),
  upsertRelationshipEmbedding: (...args: unknown[]) => mockUpsertRelationshipEmbedding(...args),
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
  mockFindKbThemesByChunkIds.mockReset();
  mockUpsertEntityEmbedding.mockReset();
  mockUpsertRelationshipEmbedding.mockReset();
  // Default: no themes — matches the audit §13b 456 case where the
  // chunk has no row in kb_theme and the embed text uses just name /
  // type / description.
  mockFindKbThemesByChunkIds.mockResolvedValue(new Map<string, string[]>());
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
