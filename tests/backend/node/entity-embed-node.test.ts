import { describe, it, expect, beforeEach, vi } from "vitest";

const mockEmbedDocuments = vi.fn();
const mockFindCanonicalEntities = vi.fn();
const mockFindCanonicalRelationships = vi.fn();
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
  upsertEntityEmbedding: (...args: unknown[]) => mockUpsertEntityEmbedding(...args),
  upsertRelationshipEmbedding: (...args: unknown[]) => mockUpsertRelationshipEmbedding(...args),
}));

import { entityEmbedNode } from "@/backend/node/kb/entity-embed-node";
import type { KbAgentStateShape } from "@/backend/state";

beforeEach(() => {
  mockEmbedDocuments.mockReset();
  mockFindCanonicalEntities.mockReset();
  mockFindCanonicalRelationships.mockReset();
  mockUpsertEntityEmbedding.mockReset();
  mockUpsertRelationshipEmbedding.mockReset();
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

    const state = {
      userId: "u-1",
      messages: [],
      mode: "full",
      docId: null,
      pagesByDocId: {},
      processedFiles: [
        {
          messageIndex: 0,
          filePart: { type: "file", data: "d" },
          docId: "d-1",
          attachmentId: "a-1",
          r2Key: "k-1",
          title: "doc",
          contentHash: "h-1",
          contentType: "application/pdf",
          pipelineStatus: "new",
          errorMessage: null,
        },
      ],
      status: "parsing",
      errorMessage: null,
      entityExtractedChunks: [],
      alignedEntities: [],
      entityEmbeddings: [],
    } as unknown as KbAgentStateShape;

    const result = await entityEmbedNode(state);

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

  it("skips embedding if entities and relationships already have embeddings", async () => {
    mockFindCanonicalEntities.mockResolvedValueOnce([
      { id: "e-1", name: "AWS", type: "Org", description: "Cloud", embedding: [0.1] },
    ]);
    mockFindCanonicalRelationships.mockResolvedValueOnce([
      { id: "r-1", source: "AWS", relation: "PROVIDES", target: "S3", embedding: [0.2] },
    ]);

    const state = {
      userId: "u-1",
      messages: [],
      mode: "full",
      docId: null,
      pagesByDocId: {},
      processedFiles: [
        {
          messageIndex: 0,
          filePart: { type: "file", data: "d" },
          docId: "d-1",
          attachmentId: "a-1",
          r2Key: "k-1",
          title: "doc",
          contentHash: "h-1",
          contentType: "application/pdf",
          pipelineStatus: "new",
          errorMessage: null,
        },
      ],
      status: "parsing",
      errorMessage: null,
      entityExtractedChunks: [],
      alignedEntities: [],
      entityEmbeddings: [],
    } as unknown as KbAgentStateShape;

    const result = await entityEmbedNode(state);

    expect(result.status).toBe("success");
    expect(result.entityEmbeddings).toEqual([]);
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });

  it("skips files with pipelineStatus failed or unknown", async () => {
    const state = {
      userId: "u-1",
      messages: [],
      mode: "full",
      docId: null,
      pagesByDocId: {},
      processedFiles: [
        {
          messageIndex: 0,
          filePart: { type: "file", data: "d" },
          docId: "d-1",
          attachmentId: "a-1",
          r2Key: "k-1",
          title: "doc",
          contentHash: "h-1",
          contentType: "application/pdf",
          pipelineStatus: "failed",
          errorMessage: "ocr failed",
        },
      ],
      status: "failed",
      errorMessage: "ocr failed",
      entityExtractedChunks: [],
      alignedEntities: [],
      entityEmbeddings: [],
    } as unknown as KbAgentStateShape;

    const result = await entityEmbedNode(state);

    expect(result.status).toBe("failed");
    expect(mockFindCanonicalEntities).not.toHaveBeenCalled();
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });
});
