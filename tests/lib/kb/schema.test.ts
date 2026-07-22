import { describe, expect, it } from "vitest";
import { kbChunk, kbEntity, kbRelationship } from "@/lib/kb/schema";
import { getTableColumns } from "drizzle-orm";

describe("Step 3 — GraphRAG DB Schema (kb_entity & kb_relationship)", () => {
  it("defines kb_entity table with canonical fields and HNSW vector index", () => {
    const cols = getTableColumns(kbEntity);
    expect(cols.id).toBeDefined();
    expect(cols.userId).toBeDefined();
    expect(cols.documentId).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.type).toBeDefined();
    expect(cols.description).toBeDefined();
    expect(cols.sourceChunkIds).toBeDefined();
    expect(cols.embedding).toBeDefined();
  });

  it("defines kb_relationship table with directed edge fields and HNSW vector index", () => {
    const cols = getTableColumns(kbRelationship);
    expect(cols.id).toBeDefined();
    expect(cols.userId).toBeDefined();
    expect(cols.documentId).toBeDefined();
    expect(cols.source).toBeDefined();
    expect(cols.target).toBeDefined();
    expect(cols.relation).toBeDefined();
    expect(cols.description).toBeDefined();
    expect(cols.sourceChunkIds).toBeDefined();
    expect(cols.weight).toBeDefined();
    expect(cols.embedding).toBeDefined();
  });

  it("removes legacy jsonb columns (entities, relationships, themes) from kb_chunk", () => {
    const cols = getTableColumns(kbChunk) as Record<string, unknown>;
    expect(cols.entities).toBeUndefined();
    expect(cols.relationships).toBeUndefined();
    expect(cols.themes).toBeUndefined();
  });
});
