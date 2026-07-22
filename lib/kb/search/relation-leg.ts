import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getEmbeddingModel } from "@/backend/model";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import type { HybridSearchLeg } from "./types";

export interface RelationLegArgs {
  userId: string;
  query: string;
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK: number;
  qvec?: number[];
}

export interface RelationLegRawHit {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  rank: number;
}

export async function relationLeg(
  args: RelationLegArgs,
): Promise<{ legs: HybridSearchLeg[]; hits: RelationLegRawHit[] }> {
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
      `relationLeg embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}`,
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
    matched_rel_docs AS (
      SELECT r.document_id,
             MIN(r.embedding <=> ${vecLiteral}::vector) AS dist
      FROM kb_relationship r
      WHERE r.user_id = ${args.userId}
        AND r.embedding IS NOT NULL
        AND r.document_id IN (SELECT id FROM valid_docs)
      GROUP BY r.document_id
      ORDER BY dist ASC
      LIMIT ${args.topK}
    )
    SELECT c.id,
           c.document_id,
           d.title,
           c.content,
           ROW_NUMBER() OVER (ORDER BY mrd.dist ASC, c.ordinal ASC) AS rk
    FROM matched_rel_docs mrd
    JOIN kb_chunk c ON c.document_id = mrd.document_id AND c.status = 'success'
    JOIN kb_document d ON d.id = c.document_id
    LIMIT ${args.topK}
  `);

  const legs: HybridSearchLeg[] = [];
  const hits: RelationLegRawHit[] = [];

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
  }

  return { legs, hits };
}
