import { getKbEnv } from "@/lib/kb/env";
import { getRerankModelFromDB } from "@/lib/provider/model-registry";
import type { HybridSearchChunk } from "./types";

export interface RerankInput {
  chunks: HybridSearchChunk[];
  query: string;
  topK: number;
}

export async function rerankChunks(input: RerankInput): Promise<HybridSearchChunk[]> {
  if (input.chunks.length === 0) return [];

  const env = getKbEnv();

  try {
    const reranker = (await getRerankModelFromDB()) as any;
    if (reranker) {
      if (typeof reranker.rerank === "function") {
        const docTexts = input.chunks.map((c) => c.content);
        const rerankedIndexes = (await reranker.rerank(input.query, docTexts)) as Array<{
          index: number;
          score: number;
        }>;

        if (Array.isArray(rerankedIndexes) && rerankedIndexes.length > 0) {
          const res: HybridSearchChunk[] = [];
          for (const item of rerankedIndexes) {
            const chunk = input.chunks[item.index];
            if (chunk) {
              res.push({
                ...chunk,
                score: item.score,
                scoreKind: "rerank",
              });
            }
          }
          res.sort((a, b) => b.score - a.score);
          const filtered = res.filter((c) => c.score >= env.rerankMinScore).slice(0, input.topK);
          if (filtered.length > 0) {
            return filtered;
          }
        }
      } else if (typeof reranker.compressDocuments === "function") {
        const docInput = input.chunks.map((c) => ({
          pageContent: c.content,
          metadata: { chunk: c },
        }));

        const compressedDocs = await reranker.compressDocuments(docInput, input.query);
        if (Array.isArray(compressedDocs) && compressedDocs.length > 0) {
          const reranked: HybridSearchChunk[] = [];
          for (const item of compressedDocs) {
            const origChunk = item.metadata?.chunk as HybridSearchChunk | undefined;
            const score =
              typeof item.metadata?.relevanceScore === "number" ? item.metadata.relevanceScore : 0;

            if (origChunk) {
              reranked.push({
                ...origChunk,
                score,
                scoreKind: "rerank",
              });
            }
          }

          const filtered = reranked
            .filter((c) => c.score >= env.rerankMinScore)
            .slice(0, input.topK);

          if (filtered.length > 0) {
            return filtered;
          }
        }
      }
    }
  } catch (_err) {
    // Fallback on RRF
  }

  return input.chunks.slice(0, input.topK);
}
