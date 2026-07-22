// ponytail: KB hybridSearch refactor (issue #45, audit §3/§4) —
// type contracts frozen here so every leg / orchestrator / tool /
// UI can hang off the same shape. No runtime code — pure types.
//
// Two design points worth re-reading if you're tempted to change
// this file:
//   - `HybridSearchArgs` deliberately hides `qvec` / `entryTopK` /
//     `chunkTopK`. The orchestrator owns those (env-driven). The
//     tool layer only sees business fields; B-phase graph legs
//     share the same orchestrator without changes.
//   - `HybridSearchResult.graphContext?` is reserved NOW so the
//     A→B rollout doesn't change the result shape and force every
//     UI consumer to re-learn it.

/**
 * Inputs the orchestrator (`hybridSearch`) needs from callers.
 * Tool / API layers populate `rewriteQuery` / `originalQuery` /
 * `entities` / `themes`; the orchestrator handles embeddings,
 * per-leg caps, and reranking internally.
 */
export type HybridSearchArgs = {
  userId: string;
  /** LLM-rewritten, natural-language query — fed to BM25 + dense legs. */
  rewriteQuery: string;
  /**
   * Optional verbatim user message — when set, fed to a SECOND
   * dense sub-leg alongside `rewriteQuery` (multi-query / RAG-Fusion).
   * Missing → only the rewrite dense leg fires.
   */
  originalQuery?: string;
  /** Specific entities / named-terms → tag leg (exact match). */
  entities?: string[];
  /** Themes / high-level topics → tag leg (exact match). */
  themes?: string[];
  /** Filter to one document or one folder; both optional, both can be set. */
  scope: { documentId?: string; folderId?: string };
};

/**
 * What a leg returns to the orchestrator. Each leg is independently
 * mockable in tests and runtime-agnostic — see `rrfFuse`.
 */
export type HybridSearchLeg = {
  /** Stable chunk identifier the orchestrator can join on. */
  chunkId: string;
  /** 1-based rank within this leg's result set (1 = top hit). */
  rank: number;
};

/**
 * How a chunk's `score` column should be interpreted by the UI.
 * Replaces the magic-threshold `> 0.05` trick used to guess whether
 * the number was an RRF sum or a rerank score.
 */
export type ScoreKind = "rrf" | "rerank";

/**
 * Which retrieval leg(s) surfaced this chunk. `"full"` is reserved
 * for the empty-query scope-dump path. `"rel"` / `"entity"` /
 * `"graph"` are B-phase-only and never set in A.
 */
export type LegHit = "kw" | "vec" | "tag" | "rel" | "entity" | "graph" | "full";

export const LEG_HITS: readonly LegHit[] = [
  "kw",
  "vec",
  "tag",
  "rel",
  "entity",
  "graph",
  "full",
] as const;

/**
 * Single chunk surfaced to the LLM / UI.
 */
export type HybridSearchChunk = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  /** Empty until `kb_chunk` carries `page_numbers` (follow-up noted in audit §6). */
  pageNumbers: number[];
  content: string;
  score: number;
  scoreKind: ScoreKind;
  legsHit: LegHit[];
};

/**
 * Final shape returned by `hybridSearch`. `graphContext` is undefined
 * in A-phase; B-phase populates it without changing the surrounding
 * shape so consumers don't need a code change.
 */
export type HybridSearchResult = {
  chunks: HybridSearchChunk[];
  graphContext?: {
    entities: Array<{ name: string; type: string; description: string }>;
    relations: Array<{
      source: string;
      target: string;
      relation: string;
      description: string;
    }>;
  };
};
