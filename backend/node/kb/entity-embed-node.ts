import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getEmbeddingModel } from "@/backend/model";
import {
  findCanonicalEntitiesByDocId,
  findCanonicalRelationshipsByDocId,
  findKbThemesByChunkIds,
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

export async function entityEmbedNode(
  state: KbAgentStateShape,
  _config?: RunnableConfig,
): Promise<Partial<KbAgentStateShape>> {
  console.log(
    `[kbAgent] Entering entityEmbedNode, files=`,
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
    console.error(`kbAgent entityEmbedNode failed:`, err);
  }

  const hasFailed = state.processedFiles.some((p) => p.pipelineStatus === "failed");
  const allUnknown =
    state.processedFiles.length > 0 &&
    state.processedFiles.every((p) => p.pipelineStatus === "unknown");
  const isFailed = state.status === "failed" || hasFailed || allUnknown;

  return { entityEmbeddings: embeddedIds, status: isFailed ? "failed" : "success" };
}
