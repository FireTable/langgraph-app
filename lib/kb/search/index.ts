/**
 * =========================================================================================
 *                         KB HYBRID SEARCH ARCHITECTURE & FLOW
 * =========================================================================================
 *
 *                             +------------------------+
 *                             |   HybridSearchArgs     |
 *                             | (rewriteQuery, etc.)   |
 *                             +-----------+------------+
 *                                         |
 *                                 [ Check Empty? ]
 *                                   /          \
 *                       (Yes: Empty)            (No: Non-empty Query)
 *                           /                      \
 *                +------------------+     +-------------------------------+
 *                |   scopeDump()    |     |  Parallel Multi-Leg Retrieval |
 *                | (Scope Full Dump)|     |        (Promise.all)          |
 *                +--------+---------+     +---------------+---------------+
 *                         |                               |
 *                         |       +-----------------------+-----------------------+
 *                         |       |           |           |           |           |
 *                         |   [Leg 1]     [Leg 2 & 3]  [Leg 4]     [Leg 5]     [Leg 6]
 *                         |  keywordLeg    denseLeg    tagLeg    relationLeg  entityLeg
 *                         |   (BM25)      (Rewrite +   (Exact)    (Relation    (Entity
 *                         |   simple       Original)              Vector)      Vector)
 *                         |       |           |           |           |           |
 *                         |       +-----------+-----------+-----------+-----------+
 *                         |                               |
 *                         |                     +---------v----------+
 *                         |                     |  RawHits Map       |
 *                         |                     | (De-duplication)   |
 *                         |                     +---------+----------+
 *                         |                               |
 *                         |                     +---------v----------+
 *                         |                     |   rrfFuse()        |
 *                         |                     | (Reciprocal Rank)  |
 *                         |                     +---------+----------+
 *                         |                               |
 *                         |                     +---------v----------+
 *                         |                     |   rerankChunks()   |
 *                         |                     | (Reranker Model)   |
 *                         |                     +---------+----------+
 *                         |                               |
 *                         |                     +---------v----------+
 *                         |                     | assembleGraphCtx() |
 *                         |                     | (Graph RAG Context)|
 *                         |                     +---------+----------+
 *                         |                               |
 *                         +---------------+---------------+
 *                                         |
 *                             +-----------v------------+
 *                             |  HybridSearchResult    |
 *                             | (chunks + graphContext)|
 *                             +------------------------+
 *
 * -----------------------------------------------------------------------------------------
 * 流程说明 / Workflow Summary:
 * 1. 【Scope Dump 降级】：若 rewriteQuery / originalQuery 均为空，则认为用户需要全量概括，走 scopeDump()。
 * 2. 【多腿并行召回】：
 *    - Leg 1 (keywordLeg): 基于 tsvector ('simple') 的 BM25 全文检索。
 *    - Leg 2 & 3 (denseLeg): 基于 pgvector 的 Chunk 向量检索 (包含 rewriteQuery 与 originalQuery 多查询 RAG-Fusion)。
 *    - Leg 4 (tagLeg): 基于实体/主题名 (entities/themes) 的精确匹配过滤。
 *    - Leg 5 (relationLeg): 基于关系 (kb_relationship) 1024 维向量的相似度 ANN 检索。
 *    - Leg 6 (entityLeg): 基于实体 (kb_entity) 1024 维向量的相似度 ANN 检索。
 * 3. 【去重与 RRF 融合】：汇总 Hits 并提取 Chunk 文本，通过倒数排名融合 (RRF) 计算综合 score。
 * 4. 【Rerank 精排】：若配置了重排序模型，对 Top-K 候选打分精排 (scoreKind = 'rerank')。
 * 5. 【GraphContext 组装】：拉取召回 Chunk 关联的拓扑实体与关系三元组，填充 graphContext 供 LLM 结构化理解。
 * =========================================================================================
 */

import { getKbEnv } from "@/lib/kb/env";
import type { HybridSearchArgs, HybridSearchResult } from "./types";
import { keywordLeg } from "./keyword-leg";
import { denseLeg } from "./dense-leg";
import { tagLeg } from "./tag-leg";
import { relationLeg } from "./relation-leg";
import { entityLeg } from "./entity-leg";
import { rrfFuse, type RawHitMeta } from "./rrf-fuse";
import { rerankChunks } from "./rerank";
import { scopeDump } from "./scope-dump";
import { assembleGraphContext } from "./graph-context";

export async function hybridSearch(args: HybridSearchArgs): Promise<HybridSearchResult> {
  const queryText = args.rewriteQuery?.trim() || args.originalQuery?.trim() || "";
  const env = getKbEnv();

  // Exit 1: empty query → fallback scope dump
  if (!queryText) {
    const chunks = await scopeDump(args);
    return { chunks };
  }

  const entryTopK = env.kbHybridEntryTopK ?? 50;
  const chunkTopK = Math.max(1, Math.min(env.hybridTopKDefault ?? 10, env.hybridTopKMax ?? 20));
  const graphEnabled = env.kbGraphEnabled;

  const hasOriginalDense =
    Boolean(args.originalQuery?.trim()) && args.originalQuery?.trim() !== args.rewriteQuery?.trim();

  // ponytail: embed once in the orchestrator and hand the vector to
  // every vector leg. Audit §3 keeps `qvec` off the public surface —
  // legs accept it as an internal optimization (skip re-embed when
  // the orchestrator already has it), with their own internal
  // fallback for standalone callers / tests.
  const { getEmbeddingModel } = await import("@/backend/model");
  const embedder = await getEmbeddingModel().catch(() => null);
  const [qvecRewrite, qvecOriginal] = await Promise.all([
    embedder?.embedQuery(queryText).catch(() => null) ?? Promise.resolve(null),
    hasOriginalDense && embedder
      ? embedder.embedQuery(args.originalQuery!.trim()).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Run kw, vec (rewrite + original multi-query), tag, rel, entity search legs in parallel
  const [kwRes, vecRes, vecOrigRes, tagRes, relRes, entRes] = await Promise.all([
    keywordLeg({
      userId: args.userId,
      rewriteQuery: queryText,
      scope: args.scope,
      topK: entryTopK,
    }),
    denseLeg({
      userId: args.userId,
      rewriteQuery: queryText,
      scope: args.scope,
      topK: entryTopK,
      qvec: qvecRewrite ?? undefined,
    }),
    hasOriginalDense
      ? denseLeg({
          userId: args.userId,
          rewriteQuery: args.originalQuery!.trim(),
          scope: args.scope,
          topK: entryTopK,
          qvec: qvecOriginal ?? undefined,
        })
      : Promise.resolve({ legs: [], hits: [] }),
    tagLeg({
      userId: args.userId,
      entities: args.entities,
      themes: args.themes,
      scope: args.scope,
      topK: entryTopK,
    }),
    // ponytail: B-phase graph legs gate on KB_GRAPH_ENABLED (default
    // false). Audit §5 — A phase runs kw/vec/tag only, B adds rel/entity
    // + assembleGraphContext. Flip on with `KB_GRAPH_ENABLED=true`.
    graphEnabled
      ? relationLeg({
          userId: args.userId,
          query: queryText,
          scope: args.scope,
          topK: entryTopK,
          qvec: qvecRewrite ?? undefined,
        })
      : Promise.resolve({ legs: [], hits: [] }),
    graphEnabled
      ? entityLeg({
          userId: args.userId,
          query: queryText,
          scope: args.scope,
          topK: entryTopK,
          qvec: qvecRewrite ?? undefined,
        })
      : Promise.resolve({ legs: [], hits: [] }),
  ]);

  // Aggregate metadata for RRF fusing
  const rawHitsMap = new Map<string, RawHitMeta>();
  for (const h of [
    ...kwRes.hits,
    ...vecRes.hits,
    ...vecOrigRes.hits,
    ...tagRes.hits,
    ...relRes.hits,
    ...entRes.hits,
  ]) {
    if (!rawHitsMap.has(h.chunkId)) {
      rawHitsMap.set(h.chunkId, {
        chunkId: h.chunkId,
        documentId: h.documentId,
        docTitle: h.docTitle,
        content: h.content.slice(0, env.chunkMaxChars),
      });
    }
  }

  // Perform RRF fusion across kw, vec (including multi-query dense), tag, rel, entity legs
  const fusedChunks = rrfFuse({
    kwLeg: kwRes.legs,
    vecLeg: [...vecRes.legs, ...vecOrigRes.legs],
    tagLeg: tagRes.legs,
    relationLeg: relRes.legs,
    entityLeg: entRes.legs,
    rawHitsMap,
    topK: entryTopK,
  });

  // If search legs yielded 0 results for a non-empty query, return empty result
  if (fusedChunks.length === 0) {
    return { chunks: [] };
  }

  const finalChunks = await rerankChunks({
    chunks: fusedChunks,
    query: queryText,
    topK: chunkTopK,
  });

  const truncatedChunks = finalChunks.map((c) => ({
    ...c,
    content: c.content.slice(0, env.chunkMaxChars),
  }));

  const docIds = Array.from(new Set(finalChunks.map((c) => c.documentId)));
  const graphContext = graphEnabled
    ? await assembleGraphContext({
        userId: args.userId,
        scope: args.scope,
        entities: args.entities,
        themes: args.themes,
        docIds,
        maxHops: env.kbGraphHops ?? 2,
      })
    : undefined;

  return { chunks: truncatedChunks, graphContext };
}

export { scopeDump, getKbEnv };
