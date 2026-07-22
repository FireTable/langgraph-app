import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getEmbeddingModel } from "@/backend/model";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import type { HybridSearchLeg } from "./types";

export interface DenseLegArgs {
  userId: string;
  rewriteQuery: string;
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK: number;
  qvec?: number[];
}

export interface DenseLegRawHit {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  rank: number;
}

export async function denseLeg(
  args: DenseLegArgs,
): Promise<{ legs: HybridSearchLeg[]; hits: DenseLegRawHit[] }> {
  if (!args.rewriteQuery || args.rewriteQuery.trim() === "") {
    return { legs: [], hits: [] };
  }

  let vector = args.qvec;
  if (!vector || vector.length === 0) {
    try {
      const embedder = await getEmbeddingModel();
      vector = await embedder.embedQuery(args.rewriteQuery);
    } catch (_err) {
      return { legs: [], hits: [] };
    }
  }

  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `denseLeg embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}`,
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
    )
    SELECT c.id,
           c.document_id,
           d.title,
           c.content,
           ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${vecLiteral}::vector) AS rk
    FROM kb_chunk c
    JOIN kb_document d ON d.id = c.document_id
    WHERE c.document_id IN (SELECT id FROM valid_docs)
      AND c.embedding IS NOT NULL
      AND c.status = 'success'
    LIMIT ${args.topK}
  `);

  const legs: HybridSearchLeg[] = [];
  const hits: DenseLegRawHit[] = [];

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
