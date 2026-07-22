import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getEmbeddingModel } from "@/backend/model";
import {
  findCanonicalEntitiesByDocId,
  findCanonicalRelationshipsByDocId,
  findKbChunksGraphContext,
  findKbChunksByDocumentId,
  findKbThemesByChunkIds,
  upsertChunkEmbedding,
  upsertEntityEmbedding,
  upsertRelationshipEmbedding,
} from "@/lib/kb/queries";

// ponytail: prepend this chunk's macro themes into the entity /
// relationship embed text (audit §13b 456). Themes live flat on
// kb_theme now (single source of truth); the embed path reads them
// per chunk instead of relying on a per-entity themes column.
function withThemesSuffix(base: string, themes: readonly string[]): string {
  if (themes.length === 0) return base;
  return `${base} ${themes.join(" ")}`;
}

// ponytail: union-dedup themes that any of `chunkIds` carry. Order
// preserved (insertion order from the Map).
function themesForChunkIds(
  themesByChunk: Map<string, string[]>,
  chunkIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const cid of chunkIds) {
    for (const t of themesByChunk.get(cid) ?? []) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ponytail: LightRAG-style augmentation for chunk vectors. The chunk
// row's own content is the ground truth; the per-chunk entities + rels
// + themes act as a high-level "second view" of the same span, so
// bge-m3 ends up encoding both surface text AND the structured
// abstraction. Order is fixed: content first, then each section only
// if non-empty (avoid trailing punctuation when a chunk has no graphs).
function buildChunkEmbedText(
  content: string,
  entities: ReadonlyArray<{ name: string; type: string }>,
  rels: ReadonlyArray<{ source: string; target: string; relation: string }>,
  themes: readonly string[],
): string {
  const sections: string[] = [content];
  if (entities.length > 0) {
    sections.push(`\nEntities: ${entities.map((e) => `${e.name} (${e.type})`).join(", ")}`);
  }
  if (rels.length > 0) {
    sections.push(
      `\nRelationships: ${rels.map((r) => `${r.source} -> ${r.relation} -> ${r.target}`).join("; ")}`,
    );
  }
  if (themes.length > 0) {
    sections.push(`\nThemes: ${themes.join(", ")}`);
  }
  return sections.join("\n");
}

export async function chunkEmbedNode(
  state: KbAgentStateShape,
  _config?: RunnableConfig,
): Promise<Partial<KbAgentStateShape>> {
  console.log(
    `[kbAgent] Entering chunkEmbedNode, files=`,
    state.processedFiles.map((p) => ({ docId: p.docId, status: p.pipelineStatus })),
  );

  const embeddedIds: string[] = [];
  try {
    const embedder = await getEmbeddingModel();
    for (const pf of state.processedFiles) {
      if (
        pf.docId &&
        pf.pipelineStatus !== "failed" &&
        pf.pipelineStatus !== "unknown" &&
        state.userId
      ) {
        const userId = state.userId;
        const docId = pf.docId;
        const entityTouchedChunkIds = new Set<string>(state.entityExtractedChunks ?? []);

        // 1. CHUNK leg — fresh DB read for graph metadata (entities /
        //    rels / themes) so we capture the POST-alignment canonical
        //    names. Why: chunks get re-embedded whenever LLM extract
        //    touches them this run (first ingest → all chunks; retry →
        //    only the retried ones). The trigger set comes from
        //    state.entityExtractedChunks — list of chunkIds that
        //    entity-extract-node finished writing LLM output for.
        //    We re-query the doc for graph metadata at embed time so
        //    it reflects canonical names after entityAlignmentNode.
        const allChunks = await findKbChunksByDocumentId(userId, docId);
        const chunksToEmbed = allChunks.filter(
          (c) =>
            c.status === "success" && (c.embedding === null || entityTouchedChunkIds.has(c.id)),
        );
        if (chunksToEmbed.length > 0) {
          const chunkIds = chunksToEmbed.map((c) => c.id);
          // ponytail: bulk read graph metadata for the chunk set
          // (single round-trip for both entities and relationships).
          const { entitiesByChunk, relsByChunk } = await findKbChunksGraphContext(
            userId,
            docId,
            chunkIds,
          );
          const themesByChunk = await findKbThemesByChunkIds(userId, chunkIds);
          const texts = chunksToEmbed.map((c) =>
            buildChunkEmbedText(
              c.content,
              entitiesByChunk.get(c.id) ?? [],
              relsByChunk.get(c.id) ?? [],
              themesByChunk.get(c.id) ?? [],
            ),
          );
          const vectors = await embedder.embedDocuments(texts);
          for (let i = 0; i < chunksToEmbed.length; i++) {
            await upsertChunkEmbedding(chunksToEmbed[i].id, vectors[i]);
            embeddedIds.push(chunksToEmbed[i].id);
          }
        }

        // 2. ENTITY leg.
        const entities = await findCanonicalEntitiesByDocId(userId, docId);
        const entitiesToEmbed = entities.filter((e) => !e.embedding);
        if (entitiesToEmbed.length > 0) {
          const sourceChunkIds = Array.from(
            new Set(entitiesToEmbed.flatMap((e) => e.sourceChunkIds ?? [])),
          );
          const themesByChunk =
            sourceChunkIds.length > 0
              ? await findKbThemesByChunkIds(userId, sourceChunkIds)
              : new Map<string, string[]>();
          const texts = entitiesToEmbed.map((e) => {
            const themes = themesForChunkIds(themesByChunk, e.sourceChunkIds ?? []);
            const base = `${e.name} (${e.type}): ${e.description ?? ""}`;
            return withThemesSuffix(base, themes);
          });
          const vectors = await embedder.embedDocuments(texts);
          for (let i = 0; i < entitiesToEmbed.length; i++) {
            await upsertEntityEmbedding(entitiesToEmbed[i].id, vectors[i]);
            embeddedIds.push(entitiesToEmbed[i].id);
          }
        }

        // 3. RELATIONSHIP leg.
        const relationships = await findCanonicalRelationshipsByDocId(userId, docId);
        const relsToEmbed = relationships.filter((r) => !r.embedding);
        if (relsToEmbed.length > 0) {
          const sourceChunkIds = Array.from(
            new Set(relsToEmbed.flatMap((r) => r.sourceChunkIds ?? [])),
          );
          const themesByChunk =
            sourceChunkIds.length > 0
              ? await findKbThemesByChunkIds(userId, sourceChunkIds)
              : new Map<string, string[]>();
          const texts = relsToEmbed.map((r) => {
            const themes = themesForChunkIds(themesByChunk, r.sourceChunkIds ?? []);
            const base = `${r.source} -> ${r.relation} -> ${r.target}: ${r.description ?? ""}`;
            return withThemesSuffix(base, themes);
          });
          const vectors = await embedder.embedDocuments(texts);
          for (let i = 0; i < relsToEmbed.length; i++) {
            await upsertRelationshipEmbedding(relsToEmbed[i].id, vectors[i]);
            embeddedIds.push(relsToEmbed[i].id);
          }
        }
      }
    }
  } catch (err) {
    console.error(`kbAgent chunkEmbedNode failed:`, err);
  }

  const hasFailed = state.processedFiles.some((p) => p.pipelineStatus === "failed");
  const allUnknown =
    state.processedFiles.length > 0 &&
    state.processedFiles.every((p) => p.pipelineStatus === "unknown");
  const isFailed = state.status === "failed" || hasFailed || allUnknown;

  return { entityEmbeddings: embeddedIds, status: isFailed ? "failed" : "success" };
}
