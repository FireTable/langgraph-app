import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getEmbeddingModel } from "@/backend/model";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import type { HybridSearchLeg } from "./types";
import { expandFromEntities } from "./graph-context";

export interface EntityLegArgs {
  userId: string;
  query: string;
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK: number;
  qvec?: number[];
}

export interface EntityLegRawHit {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  rank: number;
}

export async function entityLeg(
  args: EntityLegArgs,
): Promise<{ legs: HybridSearchLeg[]; hits: EntityLegRawHit[] }> {
  if ((!args.query || args.query.trim() === "") && (!args.qvec || args.qvec.length === 0)) {
    return { legs: [], hits: [] };
  }

  let vector = args.qvec;
  if (!vector || vector.length === 0) {
    try {
      const embedder = await getEmbeddingModel();
      vector = await embedder.embedQuery(args.query);
    } catch (_err) {
      return { legs: [], hits: [] };
    }
  }

  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `entityLeg embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}`,
    );
  }

  const vecLiteral = `[${vector.join(",")}]`;
  const docFilterClause = args.scope.documentId
    ? sql` AND kd.id = ${args.scope.documentId}`
    : args.scope.folderId
      ? sql` AND kd.folder_id = ${args.scope.folderId}`
      : sql``;

  const rows = await db.execute<{
    id: string;
    document_id: string;
    title: string;
    content: string;
    rk: number | string;
  }>(sql`
    WITH valid_docs AS (
      SELECT kd.id FROM kb_document kd
      WHERE kd.user_id = ${args.userId} AND kd.status = 'success' ${docFilterClause}
    ),
    matched_entities AS (
      SELECT e.id AS entity_id, e.name AS entity_name, e.document_id,
             e.embedding <=> ${vecLiteral}::vector AS dist
      FROM kb_entity e
      WHERE e.user_id = ${args.userId}
        AND e.embedding IS NOT NULL
        AND e.document_id IN (SELECT id FROM valid_docs)
      ORDER BY dist ASC
      LIMIT ${args.topK}
    ),
    matched_entity_docs AS (
      SELECT document_id, MIN(dist) AS dist
      FROM matched_entities
      GROUP BY document_id
    )
    SELECT c.id,
           c.document_id,
           d.title,
           c.content,
           ROW_NUMBER() OVER (ORDER BY med.dist ASC, c.ordinal ASC) AS rk
    FROM matched_entity_docs med
    JOIN kb_chunk c ON c.document_id = med.document_id AND c.status = 'success'
    JOIN kb_document d ON d.id = c.document_id
    LIMIT ${args.topK}
  `);

  const legs: HybridSearchLeg[] = [];
  const hits: EntityLegRawHit[] = [];
  const seenChunkIds = new Set<string>();

  for (const r of rows) {
    const rank = typeof r.rk === "number" ? r.rk : Number.parseInt(String(r.rk), 10);
    legs.push({ chunkId: r.id, rank });
    hits.push({
      chunkId: r.id,
      documentId: r.document_id,
      docTitle: r.title,
      content: r.content,
      rank,
    });
    seenChunkIds.add(r.id);
  }

  // ponytail: graph traversal — LightRAG local-mode expansion. From
  // the matched entity names, walk 1-2 hops through kb_relationship
  // and surface neighbor chunk_ids. Audit §7.
  //
  // Implementation detail: the matched_entities CTE was added to the
  // outer query so we can pluck entity names from the result rows;
  // their vector distance rank already aligns with the doc-level
  // distance ordering, so we read top-K names from a parallel query.
  const entryRows = await db.execute<{ name: string }>(sql`
    SELECT name FROM kb_entity
    WHERE user_id = ${args.userId}
      AND embedding IS NOT NULL
      AND document_id IN (
        SELECT kd.id FROM kb_document kd
        WHERE kd.user_id = ${args.userId} AND kd.status = 'success' ${docFilterClause}
      )
    ORDER BY embedding <=> ${vecLiteral}::vector ASC
    LIMIT ${args.topK}
  `);

  const entryNames = entryRows.map((r) => r.name);
  if (entryNames.length > 0) {
    const expansion = await expandFromEntities({
      userId: args.userId,
      scope: args.scope,
      entryEntities: entryNames,
      hops: 2,
    });
    if (expansion.chunkIds.length > 0) {
      const newChunkIds = expansion.chunkIds.filter((cid) => !seenChunkIds.has(cid));
      if (newChunkIds.length > 0) {
        const textArrayLiteral = (arr: string[]) =>
          `{${arr.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
        const expanded = await db.execute<{
          id: string;
          document_id: string;
          title: string;
          content: string;
        }>(sql`
          SELECT c.id, c.document_id, d.title, c.content
          FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id
          WHERE c.id = ANY(${textArrayLiteral(newChunkIds)}::text[])
            AND d.user_id = ${args.userId}
            AND c.status = 'success'
          LIMIT ${args.topK}
        `);
        let nextRank = legs.length + 1;
        for (const r of expanded) {
          legs.push({ chunkId: r.id, rank: nextRank });
          hits.push({
            chunkId: r.id,
            documentId: r.document_id,
            docTitle: r.title,
            content: r.content,
            rank: nextRank,
          });
          seenChunkIds.add(r.id);
          nextRank++;
        }
      }
    }
  }

  return { legs, hits };
}
