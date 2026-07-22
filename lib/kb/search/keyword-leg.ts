import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { HybridSearchLeg } from "./types";

export interface KeywordLegArgs {
  userId: string;
  rewriteQuery: string;
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK: number;
}

export interface KeywordLegRawHit {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  rank: number;
}

export async function keywordLeg(
  args: KeywordLegArgs,
): Promise<{ legs: HybridSearchLeg[]; hits: KeywordLegRawHit[] }> {
  if (!args.rewriteQuery || args.rewriteQuery.trim() === "") {
    return { legs: [], hits: [] };
  }

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
    WITH q AS (
      SELECT websearch_to_tsquery('simple', ${args.rewriteQuery}) AS tsq,
             ${args.userId} AS uid
    ),
    valid_docs AS (
      SELECT kd.id FROM kb_document kd, q
      WHERE kd.user_id = q.uid AND kd.status = 'success' ${docFilterClause}
    )
    SELECT c.id,
           c.document_id,
           d.title,
           c.content,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, q.tsq) DESC) AS rk
    FROM kb_chunk c
    JOIN kb_document d ON d.id = c.document_id, q
    WHERE c.document_id IN (SELECT id FROM valid_docs)
      AND c.tsv @@ q.tsq
      AND c.status = 'success'
    LIMIT ${args.topK}
  `);

  const legs: HybridSearchLeg[] = [];
  const hits: KeywordLegRawHit[] = [];

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
