import type { HybridSearchChunk, HybridSearchLeg, LegHit, ScoreKind } from "./types";

export interface RawHitMeta {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  pageNumbers?: number[];
}

export interface RrfFuseInput {
  kwLeg: HybridSearchLeg[];
  vecLeg: HybridSearchLeg[];
  tagLeg: HybridSearchLeg[];
  relationLeg?: HybridSearchLeg[];
  entityLeg?: HybridSearchLeg[];
  rawHitsMap: Map<string, RawHitMeta>;
  topK: number;
  rrfK?: number;
}

export function rrfFuse(input: RrfFuseInput): HybridSearchChunk[] {
  const rrfK = input.rrfK ?? 60;
  const chunkScores = new Map<string, number>();
  const chunkLegs = new Map<string, Set<LegHit>>();

  function processLeg(legHits: HybridSearchLeg[] | undefined, kind: LegHit) {
    if (!legHits) return;
    for (const item of legHits) {
      const currentScore = chunkScores.get(item.chunkId) ?? 0;
      const legScore = 1.0 / (rrfK + item.rank);
      chunkScores.set(item.chunkId, currentScore + legScore);

      let legsSet = chunkLegs.get(item.chunkId);
      if (!legsSet) {
        legsSet = new Set<LegHit>();
        chunkLegs.set(item.chunkId, legsSet);
      }
      legsSet.add(kind);
    }
  }

  processLeg(input.kwLeg, "kw");
  processLeg(input.vecLeg, "vec");
  processLeg(input.tagLeg, "tag");
  processLeg(input.relationLeg, "rel");
  processLeg(input.entityLeg, "entity");

  const sortedChunkIds = Array.from(chunkScores.keys()).sort((a, b) => {
    const scoreA = chunkScores.get(a) ?? 0;
    const scoreB = chunkScores.get(b) ?? 0;
    return scoreB - scoreA;
  });

  const topIds = sortedChunkIds.slice(0, input.topK);
  const scoreKind: ScoreKind = "rrf";

  const results: HybridSearchChunk[] = [];
  for (const chunkId of topIds) {
    const meta = input.rawHitsMap.get(chunkId);
    if (!meta) continue;

    const legsSet = chunkLegs.get(chunkId);
    const legsHit: LegHit[] = legsSet ? Array.from(legsSet) : [];

    results.push({
      chunkId: meta.chunkId,
      documentId: meta.documentId,
      docTitle: meta.docTitle,
      pageNumbers: meta.pageNumbers ?? [],
      content: meta.content,
      score: chunkScores.get(chunkId) ?? 0,
      scoreKind,
      legsHit,
    });
  }

  return results;
}
