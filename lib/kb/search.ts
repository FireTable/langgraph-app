import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { getKbEnv } from "@/lib/kb/env";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import { getEmbeddingModel } from "@/backend/model";
import { getRerankModelFromDB } from "@/lib/provider/model-registry";

// ponytail: hybrid search (issue #13 v3) — RRF (k=60) over three legs:
//   1. kw   — tsvector + GIN, ranked by ts_rank_cd
//   2. vec  — pgvector cosine, ranked by embedding <=> qvec
//   3. tag  — entities name + themes (word-split) + relationships
//              source|target, all lower() = ANY(qents)
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
// 0-chunk fallback (documentId filter only): when a @doc mention's
// chunk index is empty (OCR finished but the chunking pass didn't
// land any rows), search_kb can't return chunks. Instead of an empty
// result, return a single "full" row with the joined page markdown
// — same content the LLM would have gotten via the old
// resolveKbMentions ToolMessage, but as a real search result.
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
  // ponytail: legsHit values mirror parser.ts legBadges(). "full" is set by
  // the empty-query scope-dump path; "kw"/"vec"/"tag" come from the fused
  // BM25 / vector / tag legs in the main path.
  legsHit: Array<"kw" | "vec" | "tag" | "full">;
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

// ponytail: safety cap for the "no query" path. The LLM-facing tool
// no longer exposes topK; an empty query is a "give me everything in
// this scope" intent (e.g. summarise @doc.pdf). We cap at 1000 to
// prevent OOM on a giant folder — the LLM can iterate with a
// narrower scope or a real query if it needs more.
const EMPTY_QUERY_LIMIT = 1000;

// ponytail: cheap query-time entity candidate extraction. Index-time
// extraction (kbAgent.generateChunkEmbedNode) is the canonical source of
// entities — query-time does lightweight keyphrase-style linking only.
// Per HippoRAG 2 / LightRAG / GraphRAG consensus: NEVER call the LLM
// for entity extraction at query time. If recall is measured poor later,
// the upgrade path is embedding-based entity linking (not LLM re-call).
//
// ponytail: removed the original `.filter((w) => w.length >= 3)` —
// dropping 1-2 char tokens was clipping valid short entities (AI, ML,
// JS, HKU abbreviations like 港大, 马总) that the tag leg needs to
// match against. The trade-off is small: qents are exact-matched
// (`lower() = ANY(...)`) against entities / themes / relationship
// source+target+description, so most short tokens don't find anything
// and stay inert. Most named entities are 3+ chars anyway — short
// tokens just get *more* chances to hit the few 1-2 char entities
// that do exist.
export function deriveQueryEntities(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0),
    ),
  );
}

// ponytail: full-scope retrieval — used as both the main path
// (when args.query is empty) and the fallback (when ranked search
// returns [] but a scope filter is set; called from
// backend/tool/kb/search-kb.ts). Capped at EMPTY_QUERY_LIMIT (1000)
// so a giant folder can't OOM the LLM context. The LLM iterates
// with a narrower scope or a real query if it needs more.
// rrfScore = 0 hides the Score badge (chunk-list.tsx `> 0` gate);
// legsHit = ["full"] swaps the misleading "BM25" badge for
// "full doc" (parser.ts). Same hard-coded values document the
// intent: this isn't ranked retrieval, it's the filtered scope.
export async function scopeDump(args: HybridSearchArgs): Promise<HybridSearchResult[]> {
  const env = getKbEnv();
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
    LIMIT ${EMPTY_QUERY_LIMIT}
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
    rrfScore: 0,
    legsHit: ["full"],
  }));
}

export async function hybridSearch(args: HybridSearchArgs): Promise<HybridSearchResult[]> {
  const env = getKbEnv();
  const topK = Math.min(Math.max(args.topK ?? env.hybridTopKDefault, 1), env.hybridTopKMax);

  // ponytail: empty-query "give me everything in this scope" — see
  // scopeDump for the full docstring. Pulled out of hybridSearch so
  // the search_kb tool handler can reuse it as a fallback path
  // (ranked search returns 0 but a scope filter is set — see path A
  // in `docs/KNOWLEDGE_BASE.md`).
  if (!args.query || args.query.trim() === "") {
    return scopeDump(args);
  }

  const qents = (args.qents ?? deriveQueryEntities(args.query)).map((q) => q.toLowerCase());

  // ponytail: auto-embed the query if the caller didn't pass qvec
  // (the search_kb tool doesn't bother pre-embedding — the embed +
  // catch-fall-back-to-non-vector-legs is colocated with the search).
  let qvec = args.qvec;
  if (qvec == null && args.query.trim() !== "") {
    try {
      const embedder = await getEmbeddingModel();
      qvec = await embedder.embedQuery(args.query);
    } catch (err) {
      console.warn("[hybridSearch] Failed to embed query, falling back to non-vector legs:", err);
    }
  }

  // ponytail: pgvector's `vector(1024)` rejects a wrong-dim input with
  // 22P02 — fail fast at the boundary instead of letting the SQL fail.
  if (qvec != null && qvec.length !== EMBEDDING_DIM) {
    throw new Error(`qvec dimension mismatch: expected ${EMBEDDING_DIM}, got ${qvec.length}`);
  }

  // ponytail: pgvector wire form is `[1.0,2.0,3.0]` — postgres.js lacks
  // automatic pgvector serialization, so bind as text and cast ::vector.
  // Same trick used in queries.ts insertKbChunks. Read the local `qvec`
  // (which falls back to auto-embedded `args.qvec` above) — not
  // `args.qvec` directly, otherwise every tool-driven search_kb call
  // skips the vector leg because the tool handler never pre-embeds.
  const qvecLiteral = qvec != null ? vectorLiteral(qvec) : null;

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
        AND (
          EXISTS (
            -- entity name match (canonical: exact lower(name) = ANY(qents))
            SELECT 1
            FROM jsonb_to_recordset(c.entities) AS x(name text)
            WHERE lower(x.name) = ANY(${textArrayLiteral(qents)}::text[])
          )
          OR EXISTS (
            -- ponytail: theme word-split. themes are short tags or 3-7-word
            -- phrases; the qent side is single words. Word-split bridges
            -- the gap (English only — Chinese phrases without whitespace
            -- don't split; trade-off accepted until a CJK segmenter is
            -- worth a new dependency).
            SELECT 1
            FROM unnest(c.themes) AS t(theme),
                 LATERAL regexp_split_to_table(lower(theme), '\s+') AS w(token)
            WHERE w.token = ANY(${textArrayLiteral(qents)}::text[])
          )
          OR EXISTS (
            -- ponytail: relationship edges. Match if any edge's source,
            -- target, or a whitespace-delimited token in the description
            -- matches a qent. source/target are flat exact match
            -- (entity-level); description word-split mirrors the themes
            -- branch — English-only, CJK phrases without whitespace still
            -- miss (same trade-off; jieba-style segmentation deferred).
            SELECT 1
            FROM jsonb_array_elements(c.relationships) AS r
            WHERE lower(r->>'source') = ANY(${textArrayLiteral(qents)}::text[])
               OR lower(r->>'target') = ANY(${textArrayLiteral(qents)}::text[])
               OR EXISTS (
                 SELECT 1
                 FROM regexp_split_to_table(lower(r->>'description'), '\s+') AS w(token)
                 WHERE w.token = ANY(${textArrayLiteral(qents)}::text[])
               )
          )
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

      const env = getKbEnv();
      finalRows = scoredRows.filter((r) => r.rrf_score >= env.rerankMinScore);
    } catch (err) {
      console.warn("[hybridSearch] Reranking failed, falling back to RRF rankings:", err);
    }
  }

  const truncatedRows = finalRows.slice(0, topK);

  const mapped = truncatedRows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    docTitle: r.title,
    // See MISSING FIELD NOTE — kb_chunk has no page_numbers column yet.
    pageNumbers: [],
    content: r.content,
    rrfScore: Number(r.rrf_score),
    legsHit: (r.legs_hit ?? []) as Array<"kw" | "vec" | "tag">,
  }));

  // ponytail: path A fallback. When ranked retrieval came back empty
  // (BM25 + vector + tag fused, optionally reranked and filtered,
  // produced 0 rows) but the caller set a scope filter
  // (documentId / folderId), the @-mention pattern means the user
  // wants to read THIS scope — so transparently retry with an empty
  // query to dump the full scope (re-uses scopeDump). Without this,
  // the LLM sees "No KB matches" and has to retry itself — see the
  // `@梁永焯 - 个人简历.pdf` screenshot where the LLM's abstract-
  // category keywords ("简历 内容 主要经历 ...") miss concrete
  // resume entities. scopeDump sets legsHit=["full"] so the UI
  // shows the "full doc" badge for the dump rows.
  if (mapped.length === 0 && (args.documentId || args.folderId)) {
    console.warn(
      `[hybridSearch] ranked search returned 0 with scope (documentId=${args.documentId ?? "—"}, folderId=${args.folderId ?? "—"}); falling back to scope dump`,
    );
    return scopeDump(args);
  }

  return mapped;
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
