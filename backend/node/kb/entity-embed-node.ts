import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getEmbeddingModel } from "@/backend/model";
import {
  findCanonicalEntitiesByDocId,
  findCanonicalRelationshipsByDocId,
  upsertEntityEmbedding,
  upsertRelationshipEmbedding,
} from "@/lib/kb/queries";

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
          const texts = entitiesToEmbed.map((e) => `${e.name} (${e.type}): ${e.description ?? ""}`);
          const vectors = await embedder.embedDocuments(texts);
          for (let i = 0; i < entitiesToEmbed.length; i++) {
            await upsertEntityEmbedding(entitiesToEmbed[i].id, vectors[i]);
            embeddedIds.push(entitiesToEmbed[i].id);
          }
        }

        const relationships = await findCanonicalRelationshipsByDocId(userId, docId);
        const relsToEmbed = relationships.filter((r) => !r.embedding);
        if (relsToEmbed.length > 0) {
          const texts = relsToEmbed.map(
            (r) => `${r.source} -> ${r.relation} -> ${r.target}: ${r.description ?? ""}`,
          );
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
