import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { HybridSearchLeg } from "./types";

export interface TagLegArgs {
  userId: string;
  entities?: string[];
  themes?: string[];
  scope: {
    folderId?: string;
    documentId?: string;
  };
  topK: number;
}

export interface TagLegRawHit {
  chunkId: string;
  documentId: string;
  docTitle: string;
  content: string;
  rank: number;
}

function textArrayLiteral(items: string[]): string {
  const escaped = items.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

export async function tagLeg(
  args: TagLegArgs,
): Promise<{ legs: HybridSearchLeg[]; hits: TagLegRawHit[] }> {
  const entityTerms = (args.entities ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const themeTerms = (args.themes ?? [])
    .flatMap((t) => t.trim().toLowerCase().split(/\s+/))
    .filter(Boolean);

  const qents = Array.from(new Set([...entityTerms, ...themeTerms]));
  if (qents.length === 0) {
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
    WITH valid_docs AS (
      SELECT kd.id FROM kb_document kd
      WHERE kd.user_id = ${args.userId} AND kd.status = 'success' ${docFilterClause}
    ),
    matched_chunks AS (
      SELECT c.id, c.document_id, c.content, c.ordinal
      FROM kb_chunk c
      WHERE c.document_id IN (SELECT id FROM valid_docs)
        AND c.status = 'success'
        AND (
          EXISTS (
            SELECT 1 FROM kb_entity e
            WHERE e.document_id = c.document_id
              AND lower(e.name) = ANY(${textArrayLiteral(qents)}::text[])
          )
          OR EXISTS (
            SELECT 1 FROM kb_relationship r
            WHERE r.document_id = c.document_id
              AND (
                lower(r.source) = ANY(${textArrayLiteral(qents)}::text[])
                OR lower(r.target) = ANY(${textArrayLiteral(qents)}::text[])
              )
          )
        )
    )
    SELECT mc.id,
           mc.document_id,
           d.title,
           mc.content,
           ROW_NUMBER() OVER (ORDER BY mc.ordinal ASC) AS rk
    FROM matched_chunks mc
    JOIN kb_document d ON d.id = mc.document_id
    LIMIT ${args.topK}
  `);

  const legs: HybridSearchLeg[] = [];
  const hits: TagLegRawHit[] = [];

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
