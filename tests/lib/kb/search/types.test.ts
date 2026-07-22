import { describe, expect, expectTypeOf, it } from "vitest";

import { LEG_HITS } from "@/lib/kb/search/types";
import type {
  HybridSearchArgs,
  HybridSearchChunk,
  HybridSearchLeg,
  HybridSearchResult,
  LegHit,
  ScoreKind,
} from "@/lib/kb/search/types";

// ponytail: Step 1 interface freeze (audit §3 + §4). The test file
// guards the SHAPE — future leg / orchestrator / UI additions MUST
// import from here so a missed field surfaces as a type error rather
// than a runtime "undefined".

describe("lib/kb/search/types", () => {
  describe("LEG_HITS", () => {
    it("lists every retrieval leg surfaced in the audit", () => {
      // A-phase legs + the empty-query scope-dump marker + B-phase
      // placeholders (rel / entity / graph) reserved so the result
      // shape doesn't change at the A→B boundary.
      expect(new Set(LEG_HITS)).toEqual(
        new Set<LegHit>(["kw", "vec", "tag", "rel", "entity", "graph", "full"]),
      );
    });

    it("is a frozen readonly tuple at the type level", () => {
      expectTypeOf(LEG_HITS).toEqualTypeOf<readonly LegHit[]>();
    });
  });

  describe("HybridSearchArgs", () => {
    it("requires userId + rewriteQuery + scope and tolerates the rest", () => {
      const minimal: HybridSearchArgs = {
        userId: "u-1",
        rewriteQuery: "what is LightRAG?",
        scope: {},
      };
      // All optional fields absent — type system accepts.
      expect(minimal).toBeDefined();

      const full: HybridSearchArgs = {
        userId: "u-1",
        rewriteQuery: "what is LightRAG?",
        originalQuery: "它怎么做 entity 检索的?",
        entities: ["LightRAG"],
        themes: ["graph retrieval"],
        scope: { documentId: "d-1", folderId: "f-1" },
      };
      expect(full).toBeDefined();
    });

    it("hides retrieval internals (qvec / entryTopK / chunkTopK / topK) from callers", () => {
      // The orchestrator owns these — keep them off the public surface
      // so the tool layer can't bypass the env-driven caps.
      expectTypeOf<HybridSearchArgs>().toHaveProperty("userId");
      expectTypeOf<HybridSearchArgs>().toHaveProperty("rewriteQuery");
      expectTypeOf<HybridSearchArgs>().toHaveProperty("scope");
      expectTypeOf<HybridSearchArgs["entities"]>().toEqualTypeOf<string[] | undefined>();
      expectTypeOf<HybridSearchArgs["themes"]>().toEqualTypeOf<string[] | undefined>();
      expectTypeOf<HybridSearchArgs>().not.toHaveProperty("qvec");
      expectTypeOf<HybridSearchArgs>().not.toHaveProperty("topK");
      expectTypeOf<HybridSearchArgs>().not.toHaveProperty("entryTopK");
      expectTypeOf<HybridSearchArgs>().not.toHaveProperty("chunkTopK");
    });
  });

  describe("HybridSearchLeg", () => {
    it("is just chunkId + 1-based rank", () => {
      const leg: HybridSearchLeg = { chunkId: "c-1", rank: 1 };
      expectTypeOf(leg.chunkId).toEqualTypeOf<string>();
      expectTypeOf(leg.rank).toEqualTypeOf<number>();
      expectTypeOf<HybridSearchLeg>().not.toHaveProperty("score");
    });
  });

  describe("ScoreKind", () => {
    it("is the literal union 'rrf' | 'rerank' (no magic-threshold guessing)", () => {
      const rrf: ScoreKind = "rrf";
      const rerank: ScoreKind = "rerank";
      expect([rrf, rerank]).toHaveLength(2);
      expectTypeOf<ScoreKind>().toEqualTypeOf<"rrf" | "rerank">();
    });
  });

  describe("HybridSearchChunk", () => {
    it("carries score + scoreKind + legsHit (replaces the rrfScore magic-threshold hack)", () => {
      const c: HybridSearchChunk = {
        chunkId: "c-1",
        documentId: "d-1",
        docTitle: "alpha.pdf",
        pageNumbers: [],
        content: "...",
        score: 0.92,
        scoreKind: "rerank",
        legsHit: ["kw", "vec"],
      };
      expect(c.scoreKind).toBe("rerank");
      expectTypeOf<HybridSearchChunk>().not.toHaveProperty("rrfScore");
    });
  });

  describe("HybridSearchResult", () => {
    it("returns chunks always, graphContext only when B is active", () => {
      const a: HybridSearchResult = { chunks: [] };
      const b: HybridSearchResult = {
        chunks: [],
        graphContext: {
          entities: [{ name: "LightRAG", type: "System", description: "Graph RAG" }],
          relations: [
            { source: "LightRAG", target: "HippoRAG", relation: "extends", description: "..." },
          ],
        },
      };
      expect(a.graphContext).toBeUndefined();
      expect(b.graphContext?.entities).toHaveLength(1);
    });
  });
});
