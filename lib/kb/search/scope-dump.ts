import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getKbEnv } from "@/lib/kb/env";
import type { HybridSearchChunk, ScoreKind } from "./types";

export interface ScopeDumpArgs {
  userId: string;
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK?: number;
}

export async function scopeDump(args: ScopeDumpArgs): Promise<HybridSearchChunk[]> {
  const env = getKbEnv();
  const limit = args.topK ?? env.hybridTopKDefault;

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
  }>(sql`
    WITH valid_docs AS (
      SELECT kd.id FROM kb_document kd
      WHERE kd.user_id = ${args.userId} AND kd.status = 'success' ${docFilterClause}
    )
    SELECT c.id,
           c.document_id,
           d.title,
           c.content
    FROM kb_chunk c
    JOIN kb_document d ON d.id = c.document_id
    WHERE c.document_id IN (SELECT id FROM valid_docs)
      AND c.status = 'success'
    ORDER BY c.created_at DESC, c.ordinal ASC
    LIMIT ${limit}
  `);

  const scoreKind: ScoreKind = "rrf";

  return rows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    docTitle: r.title,
    pageNumbers: [],
    content: r.content.slice(0, env.chunkMaxChars),
    score: 1.0,
    scoreKind,
    legsHit: ["full"],
  }));
}
