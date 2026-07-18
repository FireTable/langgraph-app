import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { attachments } from "@/lib/attachments/schema";
import {
  kbChunk,
  kbDocument,
  kbFolder,
  type KbChunk,
  type KbDocument,
  type KbFolder,
  type NewKbChunk,
  type NewKbDocument,
  type NewKbFolder,
} from "./schema";

// Re-export types so consumers don't need a second import line.
export type { KbChunk, KbDocument, KbFolder, NewKbChunk, NewKbDocument, NewKbFolder };

// ponytail: tx type alias keeps insertKbChunks + withKbTx in sync with
// Drizzle's transaction shape.
export type PgTx = PgTransaction<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  typeof import("@/db/schema"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

// ponytail: every read scopes by user_id; every write goes through a
// Drizzle tx so a chunk insert never lands orphaned (FK to kb_document).
// matches the `attachments` module pattern (lib/attachments/queries.ts).

export async function insertKbFolder(row: NewKbFolder): Promise<KbFolder> {
  const [out] = await db.insert(kbFolder).values(row).returning();
  return out;
}

export async function findKbFolderByName(userId: string, name: string): Promise<KbFolder | null> {
  const row = await db.query.kbFolder.findFirst({
    where: and(eq(kbFolder.userId, userId), eq(kbFolder.name, name)),
  });
  return row ?? null;
}

export async function findKbFolderById(userId: string, id: string): Promise<KbFolder | null> {
  const row = await db.query.kbFolder.findFirst({
    where: and(eq(kbFolder.userId, userId), eq(kbFolder.id, id)),
  });
  return row ?? null;
}

// Default folder is auto-created on first KB upload so kbAgent never
// has to ask "where do I put this?". UNIQUE(user_id, name) guarantees
// concurrent ingests of the same first docId collapse into one folder
// (the losing tx hits the unique violation and re-reads).
export async function ensureDefaultKbFolder(
  userId: string,
  name = "Attachments",
): Promise<KbFolder> {
  const existing = await findKbFolderByName(userId, name);
  if (existing) return existing;
  const row: NewKbFolder = {
    id: `f-${randomUUID()}`,
    userId,
    name,
  };
  try {
    return await insertKbFolder(row);
  } catch (err) {
    // ponytail: race with another ingest — re-read instead of erroring.
    // Postgres unique-violation SQLSTATE is 23505. drizzle wraps the
    // driver error in DrizzleQueryError (.cause carries the original),
    // so check both.
    const code =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      const again = await findKbFolderByName(userId, name);
      if (again) return again;
    }
    throw err;
  }
}

export async function insertKbDocument(row: NewKbDocument): Promise<KbDocument> {
  const [out] = await db.insert(kbDocument).values(row).returning();
  return out;
}

// ponytail: reprocess flips the doc row back to "pending" + clears the
// previous error message AND the cached pages array. The detail
// dialog reads `pages` straight off the row to render per-page
// OCR'd markdown + R2 image URLs; without clearing it on reprocess,
// the dialog shows stale text/images between the start of the new
// pipeline and the moment splitFileToPageNode writes fresh `pages`
// (often a few seconds — visible flash of prior OCR result).
// Chunks are cleared separately via deleteKbChunksByDocumentId in the
// same withKbTx so a partial reprocess doesn't split the two clears.
export async function resetKbDocumentForReprocess(
  userId: string,
  docId: string,
): Promise<KbDocument | null> {
  const [out] = await db
    .update(kbDocument)
    .set({
      status: "pending",
      errorMessage: null,
      pages: null,
      updatedAt: new Date(),
    })
    .where(and(eq(kbDocument.id, docId), eq(kbDocument.userId, userId)))
    .returning();
  return out ?? null;
}

// ponytail: kbAgent uses this to keep the doc row in sync with the
// in-memory pipeline. screenshotNode inserts parsing rows; ocrNode +
// chunkEmbedStoreNode flip them to success / failed + errorMessage as
// work progresses. A failed row stays in the table so resolveKbRefs
// can render "[Failed: ...]" instead of silently dropping the doc
// context (the kb_ref sibling on the file part in the user's
// message is preserved across agent runs and stays meaningful even
// when chunking never happened).
export async function updateKbDocumentStatus(
  userId: string,
  docId: string,
  patch: {
    status: KbDocument["status"];
    errorMessage?: string | null;
    pages?: unknown[] | null;
  },
): Promise<KbDocument | null> {
  const set: Partial<KbDocument> & { updatedAt: Date } = {
    status: patch.status,
    updatedAt: new Date(),
  };
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
  if (patch.pages !== undefined) set.pages = patch.pages;
  const [out] = await db
    .update(kbDocument)
    .set(set)
    .where(and(eq(kbDocument.id, docId), eq(kbDocument.userId, userId)))
    .returning();
  return out ?? null;
}

// ponytail: reprocess wipes stale chunks before the new kbAgent run
// inserts fresh ones. The chunks FK CASCADEs if the doc row ever goes
// away, but a reprocess keeps the doc — we just want a clean slate for
// the new chunkEmbedStore pass. Caller wraps this in a tx so a failure
// here leaves the old chunks in place.
export async function deleteKbChunksByDocumentId(tx: PgTx, docId: string): Promise<void> {
  await tx.delete(kbChunk).where(eq(kbChunk.documentId, docId));
}

export async function findKbDocumentById(
  userId: string,
  docId: string,
): Promise<KbDocument | null> {
  const row = await db.query.kbDocument.findFirst({
    where: and(eq(kbDocument.id, docId), eq(kbDocument.userId, userId)),
  });
  return row ?? null;
}

// PRIMARY dedup lookup: kbAgent.screenshotNode probes this on every
// upload. contentHash comes from `attachment.sha256` (or `r2key:<key>`
// fallback when sha256 is null).
export async function findKbDocumentByContentHash(
  userId: string,
  contentHash: string,
): Promise<KbDocument | null> {
  const row = await db.query.kbDocument.findFirst({
    where: and(eq(kbDocument.userId, userId), eq(kbDocument.contentHash, contentHash)),
  });
  return row ?? null;
}

// Secondary dedup — defense-in-depth. If the contentHash probe misses
// (sha256 null fallback collision, hash collision), the attachment id
// still pins the dedup.
export async function findKbDocumentByAttachmentId(
  userId: string,
  attachmentId: string,
): Promise<KbDocument | null> {
  const row = await db.query.kbDocument.findFirst({
    where: and(eq(kbDocument.userId, userId), eq(kbDocument.attachmentId, attachmentId)),
  });
  return row ?? null;
}

// Settings → KB tab list — newest first. Single round-trip; join folder
// name client-side via the second pass below.
export async function listKbDocumentsByFolder(
  userId: string,
  folderId: string,
  limit = 100,
): Promise<KbDocument[]> {
  return db.query.kbDocument.findMany({
    where: and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)),
    orderBy: [desc(kbDocument.createdAt)],
    limit,
  });
}

// ponytail: doc + its attachment's publicUrl in one round-trip. The
// Settings UI uses this to render a "View source" link per doc without
// an N+1 attachments query.
export type KbDocumentWithAttachment = KbDocument & { attachmentUrl: string | null };

export async function listKbDocumentsByFolderWithAttachment(
  userId: string,
  folderId: string,
  limit = 100,
): Promise<KbDocumentWithAttachment[]> {
  // ponytail: raw R2 public URL. We tried `?response-content-disposition=inline`
  // to force inline rendering, but R2 custom domains (e.g. file.ai.firetable.tech)
  // do NOT honor that query param — only the default cloudflarestorage.com
  // endpoint does. So the link is a plain public URL; the browser will
  // download the file unless the R2 object itself has `Content-Disposition:
  // inline` stored at upload time. Only server-side uploads (Settings →
  // Add Doc → uploadKbImage) set that metadata. Chat uploads via the
  // presigned-PUT flow never store it (browsers don't send the header).
  // TODO v3: add a server-side CopyObject step in /api/attachments/confirm
  // to backfill `Content-Disposition: inline` for chat uploads + a
  // one-shot script to update historical objects.
  const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  const rows = await db
    .select({
      doc: kbDocument,
      r2Key: attachments.r2Key,
    })
    .from(kbDocument)
    .leftJoin(attachments, eq(kbDocument.attachmentId, attachments.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)))
    .orderBy(desc(kbDocument.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r.doc,
    attachmentUrl: r.r2Key && base ? `${base}/${r.r2Key}` : null,
  }));
}

// ponytail: Settings → KB → grouped list with attachmentUrl. The
// per-folder loop keeps a tight SQL footprint (one query per folder
// for the JOIN); O(folders) is fine for v2.
export async function listKbDocumentsGroupedWithAttachment(
  userId: string,
): Promise<Array<{ folder: KbFolder; documents: KbDocumentWithAttachment[] }>> {
  const folders = await db.query.kbFolder.findMany({
    where: eq(kbFolder.userId, userId),
    orderBy: [asc(kbFolder.name)],
  });
  if (folders.length === 0) return [];
  const out: Array<{ folder: KbFolder; documents: KbDocumentWithAttachment[] }> = [];
  for (const folder of folders) {
    const documents = await listKbDocumentsByFolderWithAttachment(userId, folder.id);
    out.push({ folder, documents });
  }
  return out;
}

// Settings → KB tab — group docs by folder in one shot.
export async function listKbDocumentsGroupedByFolder(
  userId: string,
): Promise<Array<{ folder: KbFolder; documents: KbDocument[] }>> {
  const folders = await db.query.kbFolder.findMany({
    where: eq(kbFolder.userId, userId),
    orderBy: [asc(kbFolder.name)],
  });
  if (folders.length === 0) return [];
  // ponytail: one query per folder is fine — KB volume per user is O(tens
  // of docs), not O(thousands). When it grows, swap to a single grouped
  // SELECT with array_agg.
  const out: Array<{ folder: KbFolder; documents: KbDocument[] }> = [];
  for (const folder of folders) {
    const docs = await listKbDocumentsByFolder(userId, folder.id);
    out.push({ folder, documents: docs });
  }
  return out;
}

// Used by chunkEmbedStoreNode inside a transaction; takes the tx so a
// doc + its chunks land atomically.
export async function insertKbChunks(tx: PgTx, rows: NewKbChunk[]): Promise<void> {
  if (rows.length === 0) return;
  // ponytail: bypass Drizzle's `vector` customType for the embedding
  // column. The customType's toDriver returns `[1,2,3]`, but postgres.js
  // sees a JS number[] and encodes it as the PG array literal `1,2,3`
  // (no brackets), so the server-side `vector_in` parser rejects it with
  // "Vector contents must start with '['" (SQLSTATE 22P02). We instead
  // construct the SQL fragment ourselves with the literal already in
  // pgvector's `[1,2,3]` form, and use postgres.js's `sql` template
  // (via Drizzle's `tx.execute`) so the cast happens with the right
  // shape on the wire.
  //
  // Single-row INSERT loop also dodges a separate multi-row + pgvector
  // failure mode that surfaced as a no-SQLSTATE FailedQueryError on
  // some runs.
  for (const row of rows) {
    const embeddingLiteral = `[${row.embedding.join(",")}]`;
    const entitiesJson = JSON.stringify(row.entities ?? []);
    await tx.execute(sql`
      INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding, entities)
      VALUES (
        ${row.id},
        ${row.documentId},
        ${row.ordinal},
        ${row.content},
        ${embeddingLiteral}::vector,
        ${entitiesJson}::jsonb
      )
    `);
  }
}

// Resolve a kb_ref to its chunks (in document order) for LLM context.
export async function findKbChunksByDocumentId(userId: string, docId: string): Promise<KbChunk[]> {
  // ponytail: per-user filter via JOIN to keep the helper self-contained
  // — callers don't have to remember to scope by userId. Returns [] for
  // cross-user ids, which the resolver turns into "not found".
  return db
    .select({ chunk: kbChunk })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbChunk.documentId, docId)))
    .orderBy(asc(kbChunk.ordinal))
    .then((rows) => rows.map((r) => r.chunk));
}

// Slim variant for the Settings → KB doc-detail payload: skip the 1536-dim
// embedding array (6 KB per chunk) and the generated `tsv` column. The
// preview UI just needs the text + extracted entities + per-chunk status
// (so a failed entity extract is visibly distinct from a successful one).
export type KbChunkPreview = {
  ordinal: number;
  content: string;
  entities: Array<{ name: string; type: string; description: string }>;
  relationships: Array<{ source: string; target: string; relation: string; description: string }>;
  themes: string[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
};

export async function findKbChunksContentByDocumentId(
  userId: string,
  docId: string,
): Promise<KbChunkPreview[]> {
  return db
    .select({
      ordinal: kbChunk.ordinal,
      content: kbChunk.content,
      entities: kbChunk.entities,
      relationships: kbChunk.relationships,
      themes: kbChunk.themes,
      status: kbChunk.status,
      errorMessage: kbChunk.errorMessage,
    })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbChunk.documentId, docId)))
    .orderBy(asc(kbChunk.ordinal))
    .then((rows) => rows);
}

// ponytail: per-chunk state writes — companion to kb_document.status.
// chunkEmbedStoreNode writes these in the same pipeline that
// finalizes kb_document.status="success", so a transient chunk
// failure never blocks the parent doc from landing at success
// (matches the goal: chunks are derived data, the doc's status
// reflects only the OCR + pages phase).
export async function markKbChunkSuccess(chunkId: string): Promise<void> {
  await db
    .update(kbChunk)
    .set({ status: "success", errorMessage: null })
    .where(eq(kbChunk.id, chunkId));
}

export async function markKbChunkFailed(chunkId: string, errorMessage: string): Promise<void> {
  await db.update(kbChunk).set({ status: "failed", errorMessage }).where(eq(kbChunk.id, chunkId));
}

// ponytail: bulk status flip for a doc's chunks. Drives the visible
// 3-stage chunk lifecycle (pending → parsing → success/failed) —
// called right BEFORE the entity-LLM dispatch so the UI snapshot
// captures the "parsing" frame even though the work is short.
// Caller supplies the tx so this UPDATE participates in the
// same atomicity envelope as the INSERT (just before this helper),
// giving polling observers a clean INSERT-then-parsing transition
// (no intermediate "pending" frame visible from the network).
export async function markAllKbChunksParsingForDocInTx(tx: PgTx, docId: string): Promise<void> {
  await tx
    .update(kbChunk)
    .set({ status: "parsing" })
    .where(and(eq(kbChunk.documentId, docId), eq(kbChunk.status, "pending")));
}

// ponytail: end-of-pipeline per-row updates. The chunks table already
// has content + embedding (written by insertKbChunks at the start);
// these UPDATEs back-fill the entity list + finalise status. Two
// separate columns + status so we don't have to choose between
// "optimistic row ready before llm" and "at-least-once status flip".
export async function updateKbChunkForSuccess(
  chunkId: string,
  out: {
    entities: Array<{ name: string; type: string; description: string }>;
    relationships: Array<{ source: string; target: string; relation: string; description: string }>;
    themes: string[];
  },
): Promise<void> {
  await db
    .update(kbChunk)
    .set({
      entities: out.entities,
      relationships: out.relationships,
      themes: out.themes,
      errorMessage: null,
    })
    .where(eq(kbChunk.id, chunkId));
}

export async function updateKbChunkForFailure(
  chunkId: string,
  errorMessage: string,
): Promise<void> {
  // Don't clobber entities — if a previous successful entity
  // extract landed somewhere (e.g. a partial run), keep it visible.
  await db.update(kbChunk).set({ errorMessage }).where(eq(kbChunk.id, chunkId));
}

// Counts of failed chunks for a doc — surfaces in the doc-detail
// dialog so the user sees "23/47 indexed, 2 failed" without
// having to scroll every chunk row.
export async function getKbChunkFailureCount(docId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kbChunk)
    .where(and(eq(kbChunk.documentId, docId), eq(kbChunk.status, "failed")));
  return count;
}

// ponytail: rebuildChunksOnly — flips every chunk for the doc back
// to 'pending' without touching kb_document. Used by the
// Settings→Reprocess "Only rebuild chunks (keep OCR result)" toggle
// so chunk-level failures (entity extract / dim mismatch) can be
// retried without spending another OCR pass.
export async function resetKbChunksForReprocess(tx: PgTx, docId: string): Promise<void> {
  await tx
    .update(kbChunk)
    .set({ status: "pending", errorMessage: null })
    .where(eq(kbChunk.documentId, docId));
}

export async function findKbChunksByFolderId(
  userId: string,
  folderId: string,
): Promise<KbChunkPreview[]> {
  return db
    .select({
      ordinal: kbChunk.ordinal,
      content: kbChunk.content,
      entities: kbChunk.entities,
      relationships: kbChunk.relationships,
      themes: kbChunk.themes,
      status: kbChunk.status,
      errorMessage: kbChunk.errorMessage,
    })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)))
    .orderBy(asc(kbChunk.ordinal))
    .then((rows) => rows);
}

export async function deleteKbDocumentForUser(
  userId: string,
  docId: string,
): Promise<KbDocument | null> {
  const [row] = await db
    .delete(kbDocument)
    .where(and(eq(kbDocument.id, docId), eq(kbDocument.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteKbFolderForUser(
  userId: string,
  folderId: string,
): Promise<KbFolder | null> {
  const [row] = await db
    .delete(kbFolder)
    .where(and(eq(kbFolder.id, folderId), eq(kbFolder.userId, userId)))
    .returning();
  return row ?? null;
}

export async function updateKbFolderNameForUser(
  userId: string,
  folderId: string,
  name: string,
): Promise<KbFolder | null> {
  const [row] = await db
    .update(kbFolder)
    .set({ name })
    .where(and(eq(kbFolder.id, folderId), eq(kbFolder.userId, userId)))
    .returning();
  return row ?? null;
}

// ponytail: KB transaction helper. Wraps Drizzle's transaction so the
// caller (chunkEmbedStoreNode) inserts doc + chunks atomically. Returning
// the tx-bound objects lets the caller reuse the freshly-inserted doc.
export async function withKbTx<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
  return db.transaction(fn) as Promise<T>;
}
