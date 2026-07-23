import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { db } from "@/db/client";
import {
  deleteKbDocumentForUser,
  findKbChunksContentByDocumentId,
  findKbDocumentById,
  type KbChunkPreview,
} from "@/lib/kb/queries";
import { kbEntity, kbRelationship } from "@/lib/kb/schema";
import { and, eq, sql } from "drizzle-orm";

// ponytail: Settings → KB → doc detail (right pane). Returns the
// kb_document row + slim chunk preview (no 1536-dim embedding, no
// generated tsv column) so the UI can show parsed content without
// paying ~6 KB per chunk in the payload.

export const GET = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const doc = await findKbDocumentById(user.id, params.id);
  if (!doc) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const [chunks, graphCounts] = await Promise.all([
    doc.status === "success"
      ? findKbChunksContentByDocumentId(user.id, doc.id)
      : Promise.resolve([] as KbChunkPreview[]),
    // ponytail: parallel counts for the doc-detail badge so the
    // "Indexed" check can require entity/relationship rows in addition
    // to embeddings (hybrid-search third leg).
    db
      .select({
        entityCount: sql<number>`count(${kbEntity.id})::int`.as("entity_count"),
        relationshipCount: sql<number>`count(${kbRelationship.id})::int`.as("relationship_count"),
      })
      .from(kbEntity)
      .leftJoin(kbRelationship, eq(kbEntity.documentId, kbRelationship.documentId))
      .where(and(eq(kbEntity.documentId, doc.id), eq(kbEntity.userId, user.id)))
      .groupBy(kbEntity.documentId),
  ]);

  const entityCount = graphCounts[0]?.entityCount ?? 0;
  const relationshipCount = graphCounts[0]?.relationshipCount ?? 0;

  return NextResponse.json({
    doc: {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      errorMessage: doc.errorMessage,
      contentType: doc.contentType,
      attachmentId: doc.attachmentId,
      folderId: doc.folderId,
      contentHash: doc.contentHash,
      pages: doc.pages,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      entityCount,
      relationshipCount,
    },
    chunks,
  });
});

// ponytail: Settings → KB → doc delete. Cascades to kb_chunk via
// `document_id ... ON DELETE cascade`. R2 objects (`u/<userId>/kb/<sha>.<ext>`
// derived images + `u/<userId>/upload/<sha>.<ext>` source uploads) are
// NOT deleted — they live in R2 forever; same-content future ingests
// dedup at the storage layer (sha-keyed), so orphans are reference-
// counted rather than wasted bytes. A future retention sweep can
// prune by sha-refcount == 0.
export const DELETE = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const deleted = await deleteKbDocumentForUser(user.id, params.id);
  if (!deleted) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
});
