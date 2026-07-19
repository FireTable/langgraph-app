import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { getKbEnv } from "@/lib/kb/env";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import { getRerankModelFromDB } from "@/lib/provider/model-registry";

// ponytail: hybrid search (issue #13 v3) — RRF (k=60) over three legs:
//   1. kw   — tsvector + GIN, ranked by ts_rank_cd
//   2. vec  — pgvector cosine, ranked by embedding <=> qvec
//   3. tag  — entities TEXT[] && qents overlap (GIN)
//
// Community survey (`.claude/13-kb-v3.md`):
//   per-leg topK = 50 (LangChain EnsembleRetriever / LlamaIndex
//   QueryFusionRetriever / Haystack DocumentJoiner consensus)
//   fused topK   = KB_HYBRID_TOPK_DEFAULT (default 8, clamped to KB_HYBRID_TOPK_MAX)
//   chunk trunc  = KB_CHUNK_MAX_CHARS (default 2000 chars ≈ 512 tokens)
//   entity extract = INDEX-TIME ONLY (already done in kbAgent); qents
//                    comes from cheap string-split on the query.
//
// qvec nullable → vec leg no-ops. qents empty → tag leg no-ops
// (Postgres `entities && '{}'` returns no rows).
//
// MISSING FIELD NOTE: kb_chunk does NOT yet have a `page_numbers` column
// (per `lib/kb/schema.ts` and migration `0005_past_grey_gargoyle.sql`).
// Per the v3 plan we want page numbers in the search result for UI
// hover-cards ("Page 3"), but we won't write a migration for it here —
// flagged as a follow-up. search.ts returns `pageNumbers: []` until then;
// Pages tab UI continues to render its own data from kb_document.pages.

export type HybridSearchResult = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  pageNumbers: number[];
  content: string;
  rrfScore: number;
  legsHit: Array<"kw" | "vec" | "tag">;
};

export type HybridSearchArgs = {
  userId: string;
  query: string;
  qvec?: number[] | null;
  qents?: string[];
  topK?: number;
  folderId?: string;
  documentId?: string;
};

// ponytail: cheap query-time entity candidate extraction. Index-time
// extraction (kbAgent.generateChunkEmbedNode) is the canonical source of
// entities — query-time does lightweight keyphrase-style linking only.
// Per HippoRAG 2 / LightRAG / GraphRAG consensus: NEVER call the LLM
// for entity extraction at query time. If recall is measured poor later,
// the upgrade path is embedding-based entity linking (not LLM re-call).
export function deriveQueryEntities(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3),
    ),
  );
}

export async function hybridSearch(args: HybridSearchArgs): Promise<HybridSearchResult[]> {
  const env = getKbEnv();
  const topK = Math.min(Math.max(args.topK ?? env.hybridTopKDefault, 1), env.hybridTopKMax);

  // ponytail: empty query fallback — returns chunks sorted by documentId and ordinal
  if (!args.query || args.query.trim() === "") {
    const docFilterSql = args.documentId
      ? sql`AND c.document_id = ${args.documentId}`
      : args.folderId
        ? sql`AND d.folder_id = ${args.folderId}`
        : sql``;

    const result = await db.execute<{
      id: string;
      document_id: string;
      title: string;
      content: string;
    }>(sql`
      SELECT c.id,
             c.document_id,
             d.title,
             LEFT(c.content, ${env.chunkMaxChars}) AS content
      FROM kb_chunk c
      JOIN kb_document d ON d.id = c.document_id
      WHERE d.user_id = ${args.userId}
        AND c.status = 'success'
        AND d.status = 'success'
        ${docFilterSql}
      ORDER BY c.document_id, c.ordinal
      LIMIT ${topK}
    `);

    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return (
      rows as Array<{
        id: string;
        document_id: string;
        title: string;
        content: string;
      }>
    ).map((r) => ({
      chunkId: r.id,
      documentId: r.document_id,
      docTitle: r.title,
      pageNumbers: [],
      content: r.content,
      rrfScore: 1.0,
      legsHit: ["kw"],
    }));
  }

  const qents = (args.qents ?? deriveQueryEntities(args.query)).map((q) => q.toLowerCase());

  // ponytail: pgvector's `vector(1024)` rejects a wrong-dim input with
  // 22P02 — fail fast at the boundary instead of letting the SQL fail.
  if (args.qvec != null && args.qvec.length !== EMBEDDING_DIM) {
    throw new Error(`qvec dimension mismatch: expected ${EMBEDDING_DIM}, got ${args.qvec.length}`);
  }

  // ponytail: pgvector wire form is `[1.0,2.0,3.0]` — postgres.js lacks
  // automatic pgvector serialization, so bind as text and cast ::vector.
  // Same trick used in queries.ts insertKbChunks.
  const qvecLiteral = args.qvec != null ? vectorLiteral(args.qvec) : null;

  const hasVec = qvecLiteral != null;
  const hasTag = qents.length > 0;

  const reranker = await getRerankModelFromDB().catch(() => null);
  const finalLimit = reranker ? Math.max(50, topK * 5) : topK;

  const docFilterClause = args.documentId
    ? sql`AND kd.id = ${args.documentId}`
    : args.folderId
      ? sql`AND kd.folder_id = ${args.folderId}`
      : sql``;

  // ponytail: dynamically assemble the SQL with only the legs that
  // actually fire — pure keyword query skips `vec`, empty qents skips
  // `tag`. Static template + conditional sql`` fragments.
  //
  // Note: we interpolate ${args.query}, ${args.userId}, etc. directly
  // into the SQL via drizzle's parameter binding — postgres.js escapes
  // them safely. The qvec literal is bound as text and cast ::vector
  // server-side; the qents array is bound as a JSON array literal via
  // textArrayLiteral() and cast ::text[].
  const vecClause = hasVec
    ? sql`
    ,
    vec AS (
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${qvecLiteral}::vector) AS rk
      FROM kb_chunk c
      WHERE c.document_id IN (SELECT id FROM valid_docs)
        AND c.embedding IS NOT NULL
        AND c.status = 'success'
      LIMIT 50
    )
  `
    : sql``;

  const tagClause = hasTag
    ? sql`
    ,
    tag AS (
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY jsonb_array_length(c.entities)) AS rk
      FROM kb_chunk c
      WHERE c.document_id IN (SELECT id FROM valid_docs)
        AND c.status = 'success'
        AND EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(c.entities) AS x(name text)
          WHERE lower(x.name) = ANY(${textArrayLiteral(qents)}::text[])
        )
      LIMIT 30
    )
  `
    : sql``;

  const fusedParts: ReturnType<typeof sql>[] = [
    sql`SELECT id, 1.0 / (60 + rk) AS s, 'kw'::text AS leg FROM kw`,
  ];
  if (hasVec) fusedParts.push(sql`UNION ALL SELECT id, 1.0 / (60 + rk), 'vec'::text FROM vec`);
  if (hasTag) fusedParts.push(sql`UNION ALL SELECT id, 1.0 / (60 + rk), 'tag'::text FROM tag`);
  const fusedUnion = sql.join(fusedParts, sql.raw(" "));

  // ponytail: websearch_to_tsquery is friendlier than plainto_tsquery
  // (supports quoted phrases, OR, -negation), but still throws on raw
  // ampersand / pipe without quoting. Caller already passes plain user
  // text — wrap in a save try/catch at the tool layer if it bites.
  const result = await db.execute<{
    id: string;
    document_id: string;
    title: string;
    legs_hit: string[];
    rrf_score: number;
    content: string;
  }>(sql`
      WITH q AS (
        SELECT websearch_to_tsquery('english', ${args.query}) AS tsq,
               ${args.userId} AS uid
      ),
      valid_docs AS (
        SELECT kd.id FROM kb_document kd, q
        WHERE kd.user_id = q.uid AND kd.status = 'success' ${docFilterClause}
      ),
      kw AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC) AS rk
        FROM kb_chunk c, q
        WHERE c.document_id IN (SELECT id FROM valid_docs)
          AND c.tsv @@ q.tsq
          AND c.status = 'success'
        LIMIT 50
      )
      ${vecClause}
      ${tagClause}
      ,
      fused AS (${fusedUnion})
      SELECT c.id,
             c.document_id,
             d.title,
             array_agg(DISTINCT f.leg) AS legs_hit,
             SUM(f.s)::float8 AS rrf_score,
             LEFT(c.content, ${env.chunkMaxChars}) AS content
      FROM fused f
      JOIN kb_chunk c ON c.id = f.id
      JOIN kb_document d ON d.id = c.document_id
      GROUP BY c.id, c.document_id, d.title, c.content
      ORDER BY rrf_score DESC
      LIMIT ${finalLimit}
    `);

  // ponytail: postgres.js returns rows directly; Drizzle wraps in
  // { rows }. Normalize so callers get a plain array.
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const normalizedRows = rows as Array<{
    id: string;
    document_id: string;
    title: string;
    legs_hit: string[];
    rrf_score: number;
    content: string;
  }>;

  let finalRows = normalizedRows;

  // ponytail: two-stage ranking using Reranker model
  if (reranker && normalizedRows.length > 0) {
    try {
      const docsToRerank = normalizedRows.map((r) => r.content);
      const rerankResult = await reranker.rerank(args.query, docsToRerank);

      const scoredRows = rerankResult.map((item) => {
        const original = normalizedRows[item.index];
        return {
          ...original,
          rrf_score: item.score,
        };
      });
      scoredRows.sort((a, b) => b.rrf_score - a.rrf_score);
      finalRows = scoredRows;
    } catch (err) {
      console.warn("[hybridSearch] Reranking failed, falling back to RRF rankings:", err);
    }
  }

  const truncatedRows = finalRows.slice(0, topK);

  return truncatedRows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    docTitle: r.title,
    // See MISSING FIELD NOTE — kb_chunk has no page_numbers column yet.
    pageNumbers: [],
    content: r.content,
    rrfScore: Number(r.rrf_score),
    legsHit: (r.legs_hit ?? []) as Array<"kw" | "vec" | "tag">,
  }));
}

// ponytail: pgvector's wire format is `[1.0,2.0,3.0]`. We bypass the
// Drizzle customType to keep the SQL fragment here. Same trick used in
// queries.ts insertKbChunks — see that comment for why.
function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ponytail: Postgres array literal `{a,b,c}` with each element quoted
// and escaped. Bound as text, cast ::text[] server-side. Used for the
// entities && qents overlap query in the `tag` leg.
function textArrayLiteral(arr: string[]): string {
  const escaped = arr.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}
