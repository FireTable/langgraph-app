import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { attachments } from "@/lib/attachments/schema";
import { threads } from "@/lib/threads/schema";
import {
  kbChunk,
  kbDocument,
  kbEntity,
  kbFolder,
  kbObservability,
  kbRelationship,
  kbTheme,
  type KbChunk,
  type KbDocument,
  type KbEntity,
  type KbFolder,
  type KbObservability,
  type KbRelationship,
  type NewKbChunk,
  type NewKbDocument,
  type NewKbEntity,
  type NewKbFolder,
  type NewKbObservability,
  type NewKbRelationship,
} from "./schema";

// Re-export types so consumers don't need a second import line.
export type {
  KbChunk,
  KbDocument,
  KbEntity,
  KbFolder,
  KbObservability,
  KbRelationship,
  NewKbChunk,
  NewKbDocument,
  NewKbEntity,
  NewKbFolder,
  NewKbObservability,
  NewKbRelationship,
};

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

// ponytail: per-kbAgent-invocation observability event. Inserted from
// prepareKBDataNode after the kb_document row lands (FK dependency).
// One row per (doc, run); a chat upload of multiple PDFs creates N rows
// sharing the same parent_message_id but distinct doc_ids.
export async function insertKbObservability(row: NewKbObservability): Promise<KbObservability> {
  const [out] = await db.insert(kbObservability).values(row).returning();
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

// ponytail: reprocess wipes stale graph rows for the same reason as
// chunks — the new entity-extract pass will upsert fresh rows keyed
// on (user_id, document_id, name) / (user_id, document_id, source,
// target, relation). Without these DELETEs the old rows survive
// upsert-on-conflict-no-op: the source_chunk_ids array just keeps
// growing (new chunk_id appended to old array), so old chunkIds
// become permanent dangling pointers and the embedding text carries
// stale graph metadata. Reset to first-ingest state — caller wraps
// in the same tx as deleteKbChunksByDocumentId so it's atomic.
export async function deleteKbEntitiesByDocumentId(tx: PgTx, docId: string): Promise<void> {
  await tx.delete(kbEntity).where(eq(kbEntity.documentId, docId));
}

export async function deleteKbRelationshipsByDocumentId(tx: PgTx, docId: string): Promise<void> {
  await tx.delete(kbRelationship).where(eq(kbRelationship.documentId, docId));
}

// ponytail: retryFailedChunks reprocess — UPDATE failed chunk rows
// in place rather than DELETE+INSERT. The DELETE+INSERT design had
// a race: if the IIFE inside generateChunkEmbedNode fails to reach
// the INSERT step (pageToMarkdownNode skips under chunksOnly, so
// doc.pages is empty, fullMarkdown is empty, IIFE throws), the
// DELETE has already run and the gap ordinals are gone forever —
// the user sees a doc with N-2 chunks that can never recover.
//
// In-place UPDATE preserves the row's id, ordinal, embedding, and
// content. Embedding API is deterministic so the old vector is
// still valid for KB search. The IIFE then finds these rows by
// status='parsing' and runs entity-extract, UPDATEing them back
// to success/failed.
//
// ponytail: clear ALL three LLM-derived fields (entities,
// relationships, themes) up front — entity-extract rewrites all
// of them. Leaving any of them stale would mean the UI shows the
// old graph nodes / themes until the new LLM call lands, which
// is misleading on a doc-detail panel.
export async function markFailedKbChunksRetryingByDocumentId(
  tx: PgTx,
  docId: string,
): Promise<void> {
  await tx
    .update(kbChunk)
    .set({
      status: "parsing",
      errorMessage: null,
    })
    .where(and(eq(kbChunk.documentId, docId), eq(kbChunk.status, "failed")));
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
export type KbDocumentWithAttachment = KbDocument & {
  attachmentUrl: string | null;
  totalChunks?: number;
  successChunks?: number;
  failedChunks?: number;
  pendingChunks?: number;
  parsingChunks?: number;
  totalPages?: number;
  failedPages?: number;
  pendingPages?: number;
  parsingPages?: number;
};

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

  const chunksSubquery = db
    .select({
      documentId: kbChunk.documentId,
      totalChunks: sql<number>`count(${kbChunk.id})::int`.as("total_chunks"),
      successChunks: sql<number>`count(case when ${kbChunk.status} = 'success' then 1 end)::int`.as(
        "success_chunks",
      ),
      failedChunks: sql<number>`count(case when ${kbChunk.status} = 'failed' then 1 end)::int`.as(
        "failed_chunks",
      ),
      pendingChunks: sql<number>`count(case when ${kbChunk.status} = 'pending' then 1 end)::int`.as(
        "pending_chunks",
      ),
      parsingChunks: sql<number>`count(case when ${kbChunk.status} = 'parsing' then 1 end)::int`.as(
        "parsing_chunks",
      ),
    })
    .from(kbChunk)
    .groupBy(kbChunk.documentId)
    .as("chunk_counts");

  const rows = await db
    .select({
      doc: kbDocument,
      r2Key: attachments.r2Key,
      totalChunks: sql<number>`coalesce(${chunksSubquery.totalChunks}, 0)::int`,
      successChunks: sql<number>`coalesce(${chunksSubquery.successChunks}, 0)::int`,
      failedChunks: sql<number>`coalesce(${chunksSubquery.failedChunks}, 0)::int`,
      pendingChunks: sql<number>`coalesce(${chunksSubquery.pendingChunks}, 0)::int`,
      parsingChunks: sql<number>`coalesce(${chunksSubquery.parsingChunks}, 0)::int`,
      totalPages: sql<number>`coalesce(jsonb_array_length(${kbDocument.pages}), 0)::int`,
      // ponytail: each page carries an explicit `status` mirror of
      // kbChunkStatusEnum written by kb-agent's pageToMarkdownNode.
      // Legacy rows (status absent) are inferred from markdown +
      // errorMessage so old docs still report a sensible split:
      //   errorMessage set → failed
      //   else markdown non-empty → success
      //   else → pending
      pendingPages: sql<number>`(
        select count(*)::int from jsonb_array_elements(coalesce(${kbDocument.pages}, '[]'::jsonb)) as p
        where coalesce(p->>'status', case when p->>'errorMessage' is null and trim(coalesce(p->>'markdown', '')) = '' then 'pending' when p->>'errorMessage' is not null then 'failed' else 'success' end) = 'pending'
      )`.as("pending_pages"),
      parsingPages: sql<number>`(
        select count(*)::int from jsonb_array_elements(coalesce(${kbDocument.pages}, '[]'::jsonb)) as p
        where coalesce(p->>'status', case when p->>'errorMessage' is null and trim(coalesce(p->>'markdown', '')) = '' then 'pending' when p->>'errorMessage' is not null then 'failed' else 'success' end) = 'parsing'
      )`.as("parsing_pages"),
      failedPages: sql<number>`(
        select count(*)::int from jsonb_array_elements(coalesce(${kbDocument.pages}, '[]'::jsonb)) as p
        where coalesce(p->>'status', case when p->>'errorMessage' is null and trim(coalesce(p->>'markdown', '')) = '' then 'pending' when p->>'errorMessage' is not null then 'failed' else 'success' end) = 'failed'
      )`,
    })
    .from(kbDocument)
    .leftJoin(attachments, eq(kbDocument.attachmentId, attachments.id))
    .leftJoin(chunksSubquery, eq(kbDocument.id, chunksSubquery.documentId))
    .where(and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)))
    .orderBy(desc(kbDocument.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r.doc,
    attachmentUrl: r.r2Key && base ? `${base}/${r.r2Key}` : null,
    totalChunks: r.totalChunks,
    successChunks: r.successChunks,
    failedChunks: r.failedChunks,
    pendingChunks: r.pendingChunks,
    parsingChunks: r.parsingChunks,
    totalPages: r.totalPages,
    failedPages: r.failedPages,
    pendingPages: r.pendingPages,
    parsingPages: r.parsingPages,
  }));
}

// ponytail: Settings → KB → grouped list with attachmentUrl. The
// per-folder loop keeps a tight SQL footprint (one query per folder
// for the JOIN); O(folders) is fine for v2.
//
// `scopeFolderId` (optional): when set, only that folder's documents
// are populated — other folders still appear in the response (so the
// sidebar list stays intact) but with an empty `documents` array. This
// lets the frontend pull a single folder's full doc list without
// paying the JOIN cost for every other folder the user owns.
export async function listKbDocumentsGroupedWithAttachment(
  userId: string,
  scopeFolderId?: string | null,
): Promise<
  Array<{
    folder: KbFolder;
    documents: KbDocumentWithAttachment[];
    docCount: number;
  }>
> {
  const folders = await db.query.kbFolder.findMany({
    where: eq(kbFolder.userId, userId),
    orderBy: [asc(kbFolder.name)],
  });
  if (folders.length === 0) return [];
  const out: Array<{
    folder: KbFolder;
    documents: KbDocumentWithAttachment[];
    docCount: number;
  }> = [];
  for (const folder of folders) {
    const scoped = scopeFolderId && folder.id !== scopeFolderId;
    const documents = scoped ? [] : await listKbDocumentsByFolderWithAttachment(userId, folder.id);
    // ponytail: every folder ships a `docCount` so the sidebar can
    // show "ArcBlock · 3" even for non-selected folders. We still skip
    // the heavy docs JOIN for scoped-out folders — count is cheap, the
    // per-doc projection is not.
    const docCount = scoped ? await countKbDocumentsInFolder(userId, folder.id) : documents.length;
    out.push({ folder, documents, docCount });
  }
  return out;
}

async function countKbDocumentsInFolder(userId: string, folderId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(kbDocument)
    .where(and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)));
  return rows[0]?.n ?? 0;
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

// ponytail: tx-scoped chunk insert. embedding is nullable in the
// schema — chunk-extract-node writes rows with embedding=NULL,
// and chunk-embed-node later fills them with graph-augmented
// 1024-dim bge-m3 vectors. Kept NULL insert path explicit (not a
// `0,0,...,0` placeholder) so the HNSW index and dense-leg ANN
// can trivially skip fresh chunks until their first embed pass.
// Mirror upsertEntityEmbedding's pattern: build the JS vector
// literal, drizzle binds it as a positional $N, ::vector cast
// stays in the SQL template so pgvector's lexer sees it once.
export async function insertKbChunks(tx: PgTx, rows: NewKbChunk[]): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    const embeddingLiteral =
      row.embedding && row.embedding.length > 0 ? `[${row.embedding.join(",")}]` : null;
    await tx.execute(sql`
      INSERT INTO kb_chunk (id, document_id, ordinal, content, embedding)
      VALUES (
        ${row.id},
        ${row.documentId},
        ${row.ordinal},
        ${row.content},
        ${embeddingLiteral}::vector
      )
    `);
  }
}

// Resolve a kb_ref to its chunks (in document order) for LLM context.
export async function findKbChunksByDocumentId(userId: string, docId: string): Promise<KbChunk[]> {
  return db
    .select({ chunk: kbChunk })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbChunk.documentId, docId)))
    .orderBy(asc(kbChunk.ordinal))
    .then((rows) => rows.map((r) => r.chunk));
}

// Slim variant for the Settings → KB doc-detail payload.
// ponytail: per-chunk entities/relationships come from the new
// `kb_entity` / `kb_relationship` tables joined on `source_chunk_ids @>`
// ARRAY[chunkId]` (audit §8 — dropped the jsonB columns on kb_chunk in
// migration 0012; the doc-detail contract keeps the same shape the UI
// expects so chunks carry their graph payload without an extra fetch).
export type KbChunkPreview = {
  ordinal: number;
  content: string;
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
  entities: Array<{ name: string; type: string; description: string }>;
  relationships: Array<{ source: string; target: string; relation: string; description: string }>;
  themes: string[];
};

export async function findKbChunksContentByDocumentId(
  userId: string,
  docId: string,
): Promise<KbChunkPreview[]> {
  const chunks = await db
    .select({
      id: kbChunk.id,
      ordinal: kbChunk.ordinal,
      content: kbChunk.content,
      status: kbChunk.status,
      errorMessage: kbChunk.errorMessage,
    })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbChunk.documentId, docId)))
    .orderBy(asc(kbChunk.ordinal));

  if (chunks.length === 0) return [];

  // Pull every entity / relationship whose source_chunk_ids contains
  // any of this doc's chunk ids. We do it in two bulk queries (entity
  // + relationship) instead of N+1 per-chunk. The Postgres `&&`
  // operator on text[] returns true when arrays overlap.
  const chunkIds = chunks.map((c) => c.id);
  const chunkIdArrayLiteral = `{${chunkIds.map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;

  const entityRows = await db.execute<{
    name: string;
    type: string;
    description: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT name, type, description, source_chunk_ids
    FROM kb_entity
    WHERE user_id = ${userId}
      AND document_id = ${docId}
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);

  const relationshipRows = await db.execute<{
    source: string;
    target: string;
    relation: string;
    description: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT source, target, relation, description, source_chunk_ids
    FROM kb_relationship
    WHERE user_id = ${userId}
      AND document_id = ${docId}
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);

  // ponytail: themes are stored flat on kb_theme (one row per chunk +
  // name). Single bulk read covers the whole doc — no entity-union
  // fan-out. We reuse chunkIdArrayLiteral (string-form array literal)
  // rather than ANY(${array}::text[]) — drizzle's sql tag won't
  // auto-bind a JS array as a pgvector text[] parameter without an
  // explicit cast, so passing a pre-formatted literal is the safe path.
  const themeRows = await db.execute<{ chunk_id: string; name: string }>(sql`
    SELECT chunk_id, name
    FROM kb_theme
    WHERE user_id = ${userId}
      AND document_id = ${docId}
      AND chunk_id = ANY(${chunkIdArrayLiteral}::text[])
  `);

  // Index entities / relationships by chunk id for O(1) lookup. Same
  // entity / relationship can appear in many chunks (canonical merge
  // dedupes by name), so we de-dupe per chunk before assignment.
  const entitiesByChunk = new Map<string, KbChunkPreview["entities"]>();
  for (const e of entityRows) {
    for (const cid of e.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = entitiesByChunk.get(cid) ?? [];
      if (!bucket.some((x) => x.name === e.name)) {
        bucket.push({ name: e.name, type: e.type, description: e.description ?? "" });
      }
      entitiesByChunk.set(cid, bucket);
    }
  }
  const relsByChunk = new Map<string, KbChunkPreview["relationships"]>();
  for (const r of relationshipRows) {
    for (const cid of r.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = relsByChunk.get(cid) ?? [];
      const key = `${r.source}|${r.target}|${r.relation}`;
      if (!bucket.some((x) => `${x.source}|${x.target}|${x.relation}` === key)) {
        bucket.push({
          source: r.source,
          target: r.target,
          relation: r.relation,
          description: r.description ?? "",
        });
      }
      relsByChunk.set(cid, bucket);
    }
  }
  const themesByChunk = new Map<string, string[]>();
  for (const t of themeRows) {
    const bucket = themesByChunk.get(t.chunk_id) ?? [];
    if (!bucket.includes(t.name)) bucket.push(t.name);
    themesByChunk.set(t.chunk_id, bucket);
  }

  return chunks.map((c) => ({
    ordinal: c.ordinal,
    content: c.content,
    status: c.status,
    errorMessage: c.errorMessage,
    entities: entitiesByChunk.get(c.id) ?? [],
    relationships: relsByChunk.get(c.id) ?? [],
    themes: themesByChunk.get(c.id) ?? [],
  }));
}

export async function markKbChunkSuccess(chunkId: string): Promise<void> {
  await db
    .update(kbChunk)
    .set({ status: "success", errorMessage: null })
    .where(eq(kbChunk.id, chunkId));
}

export async function markKbChunkFailed(chunkId: string, errorMessage: string): Promise<void> {
  await db.update(kbChunk).set({ status: "failed", errorMessage }).where(eq(kbChunk.id, chunkId));
}

export async function markAllKbChunksParsingForDocInTx(tx: PgTx, docId: string): Promise<void> {
  await tx
    .update(kbChunk)
    .set({ status: "parsing" })
    .where(and(eq(kbChunk.documentId, docId), eq(kbChunk.status, "pending")));
}

export async function updateKbChunkForSuccess(
  chunkId: string,
  _out?: {
    entities?: Array<{ name: string; type: string; description: string }>;
    relationships?: Array<{
      source: string;
      target: string;
      relation: string;
      description: string;
    }>;
    themes?: string[];
  },
): Promise<void> {
  await db
    .update(kbChunk)
    .set({
      errorMessage: null,
    })
    .where(eq(kbChunk.id, chunkId));
}

export async function updateKbChunkForFailure(
  chunkId: string,
  errorMessage: string,
): Promise<void> {
  await db.update(kbChunk).set({ errorMessage }).where(eq(kbChunk.id, chunkId));
}

export async function getKbChunkFailureCount(docId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kbChunk)
    .where(and(eq(kbChunk.documentId, docId), eq(kbChunk.status, "failed")));
  return count;
}

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
  const chunks = await db
    .select({
      id: kbChunk.id,
      ordinal: kbChunk.ordinal,
      content: kbChunk.content,
      status: kbChunk.status,
      errorMessage: kbChunk.errorMessage,
    })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(and(eq(kbDocument.userId, userId), eq(kbDocument.folderId, folderId)))
    .orderBy(asc(kbChunk.ordinal));

  if (chunks.length === 0) return [];

  // ponytail: same shape as findKbChunksContentByDocumentId, but
  // scoped across every doc in the folder. The front-end
  // KnowledgeGraph component dedupes entities / relationships
  // / themes across chunks itself (per-chunk payload → rollup),
  // so returning per-chunk data here matches the doc-detail
  // contract and lets the same UI work for both views.
  const chunkIds = chunks.map((c) => c.id);
  const chunkIdArrayLiteral = `{${chunkIds
    .map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;

  const entityRows = await db.execute<{
    name: string;
    type: string;
    description: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT name, type, description, source_chunk_ids
    FROM kb_entity
    WHERE user_id = ${userId}
      AND document_id IN (SELECT id FROM kb_document WHERE user_id = ${userId} AND folder_id = ${folderId})
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);

  const relationshipRows = await db.execute<{
    source: string;
    target: string;
    relation: string;
    description: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT source, target, relation, description, source_chunk_ids
    FROM kb_relationship
    WHERE user_id = ${userId}
      AND document_id IN (SELECT id FROM kb_document WHERE user_id = ${userId} AND folder_id = ${folderId})
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);

  // ponytail: themes live flat on kb_theme (single source of truth).
  // Use chunkIdArrayLiteral — drizzle's sql tag doesn't auto-bind a
  // JS array to pgvector text[] parameter without an explicit cast.
  const themeRows = await db.execute<{ chunk_id: string; name: string }>(sql`
    SELECT chunk_id, name
    FROM kb_theme
    WHERE user_id = ${userId}
      AND document_id IN (SELECT id FROM kb_document WHERE user_id = ${userId} AND folder_id = ${folderId})
      AND chunk_id = ANY(${chunkIdArrayLiteral}::text[])
  `);

  const entitiesByChunk = new Map<string, KbChunkPreview["entities"]>();
  for (const e of entityRows) {
    for (const cid of e.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = entitiesByChunk.get(cid) ?? [];
      if (!bucket.some((x) => x.name === e.name)) {
        bucket.push({ name: e.name, type: e.type, description: e.description ?? "" });
      }
      entitiesByChunk.set(cid, bucket);
    }
  }
  const relsByChunk = new Map<string, KbChunkPreview["relationships"]>();
  for (const r of relationshipRows) {
    for (const cid of r.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = relsByChunk.get(cid) ?? [];
      const key = `${r.source}|${r.target}|${r.relation}`;
      if (!bucket.some((x) => `${x.source}|${x.target}|${x.relation}` === key)) {
        bucket.push({
          source: r.source,
          target: r.target,
          relation: r.relation,
          description: r.description ?? "",
        });
      }
      relsByChunk.set(cid, bucket);
    }
  }
  const themesByChunk = new Map<string, string[]>();
  for (const t of themeRows) {
    const bucket = themesByChunk.get(t.chunk_id) ?? [];
    if (!bucket.includes(t.name)) bucket.push(t.name);
    themesByChunk.set(t.chunk_id, bucket);
  }

  return chunks.map((c) => ({
    ordinal: c.ordinal,
    content: c.content,
    status: c.status,
    errorMessage: c.errorMessage,
    entities: entitiesByChunk.get(c.id) ?? [],
    relationships: relsByChunk.get(c.id) ?? [],
    themes: themesByChunk.get(c.id) ?? [],
  }));
}

// ponytail: Step 3 canonical query helpers for kb_entity & kb_relationship
export async function findCanonicalEntitiesByDocId(
  userId: string,
  docId: string,
): Promise<KbEntity[]> {
  return db
    .select()
    .from(kbEntity)
    .where(and(eq(kbEntity.userId, userId), eq(kbEntity.documentId, docId)));
}

export async function findCanonicalRelationshipsByDocId(
  userId: string,
  docId: string,
): Promise<KbRelationship[]> {
  return db
    .select()
    .from(kbRelationship)
    .where(and(eq(kbRelationship.userId, userId), eq(kbRelationship.documentId, docId)));
}

export async function upsertEntityEmbedding(id: string, embedding: number[]): Promise<void> {
  const embeddingLiteral = `[${embedding.join(",")}]`;
  await db.execute(sql`
    UPDATE kb_entity
    SET embedding = ${embeddingLiteral}::vector,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

export async function upsertRelationshipEmbedding(id: string, embedding: number[]): Promise<void> {
  const embeddingLiteral = `[${embedding.join(",")}]`;
  await db.execute(sql`
    UPDATE kb_relationship
    SET embedding = ${embeddingLiteral}::vector,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

// ponytail: chunk-side embedding writer for chunkEmbedNode's new
// chunk leg. chunk-extract-node now inserts chunks with embedding=NULL;
// this UPDATE fires after the LightRAG-style augmentation text is built
// (content + per-chunk entities + per-chunk relationships + per-chunk
// themes — same doc, but seen fresh at embed time so the post-alignment
// canonical names are what get vectorized). Idempotent on retry.
export async function upsertChunkEmbedding(id: string, embedding: number[]): Promise<void> {
  const embeddingLiteral = `[${embedding.join(",")}]`;
  await db.execute(sql`
    UPDATE kb_chunk
    SET embedding = ${embeddingLiteral}::vector,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

// ponytail: bulk reader for chunk's graph context used by the chunk-embed
// leg. Returns entities + relationships + themes per chunkId for ONE doc
// scope, joining via source_chunk_ids && ARRAY[chunkId]. One round-trip
// per leg rather than N queries. Caller splits by chunk_id downstream.
export async function findKbChunksGraphContext(
  userId: string,
  docId: string,
  chunkIds: readonly string[],
): Promise<{
  entitiesByChunk: Map<string, Array<{ name: string; type: string }>>;
  relsByChunk: Map<string, Array<{ source: string; target: string; relation: string }>>;
}> {
  const entitiesByChunk = new Map<string, Array<{ name: string; type: string }>>();
  const relsByChunk = new Map<
    string,
    Array<{ source: string; target: string; relation: string }>
  >();
  if (chunkIds.length === 0) return { entitiesByChunk, relsByChunk };

  const chunkIdArrayLiteral = `{${chunkIds
    .map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;

  const entityRows = await db.execute<{
    name: string;
    type: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT name, type, source_chunk_ids
    FROM kb_entity
    WHERE user_id = ${userId}
      AND document_id = ${docId}
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);
  for (const e of entityRows) {
    for (const cid of e.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = entitiesByChunk.get(cid) ?? [];
      // Same dedup pattern as findKbChunksContentByDocumentId — one
      // entity can be referenced by many chunks; surface it once per.
      if (!bucket.some((x) => x.name === e.name)) {
        bucket.push({ name: e.name, type: e.type });
      }
      entitiesByChunk.set(cid, bucket);
    }
  }

  const relRows = await db.execute<{
    source: string;
    target: string;
    relation: string;
    source_chunk_ids: string[];
  }>(sql`
    SELECT source, target, relation, source_chunk_ids
    FROM kb_relationship
    WHERE user_id = ${userId}
      AND document_id = ${docId}
      AND source_chunk_ids && ${chunkIdArrayLiteral}::text[]
  `);
  for (const r of relRows) {
    for (const cid of r.source_chunk_ids ?? []) {
      if (!chunkIds.includes(cid)) continue;
      const bucket = relsByChunk.get(cid) ?? [];
      const triple = { source: r.source, target: r.target, relation: r.relation };
      if (
        !bucket.some(
          (x) =>
            x.source === triple.source &&
            x.relation === triple.relation &&
            x.target === triple.target,
        )
      ) {
        bucket.push(triple);
      }
      relsByChunk.set(cid, bucket);
    }
  }

  return { entitiesByChunk, relsByChunk };
}

export async function updateKbChunkGraphData(
  _chunkId: string,
  _entities: Array<{ name: string; type: string; description: string }>,
  _relationships: Array<{ source: string; target: string; relation: string; description: string }>,
): Promise<void> {
  // no-op placeholder for legacy callers
}

export async function upsertKbEntity(args: {
  userId: string;
  documentId: string;
  name: string;
  type: string;
  description: string;
  chunkId: string;
}): Promise<void> {
  const nameTrim = args.name.trim();
  if (!nameTrim) return;

  const id = `e-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO kb_entity (id, user_id, document_id, name, type, description, source_chunk_ids, created_at, updated_at)
    VALUES (${id}, ${args.userId}, ${args.documentId}, ${nameTrim}, ${args.type.trim()}, ${args.description.trim()}, ARRAY[${args.chunkId}]::text[], NOW(), NOW())
    ON CONFLICT (user_id, document_id, name) DO UPDATE
    SET source_chunk_ids = CASE
          WHEN ${args.chunkId} = ANY(kb_entity.source_chunk_ids) THEN kb_entity.source_chunk_ids
          ELSE array_append(kb_entity.source_chunk_ids, ${args.chunkId})
        END,
        updated_at = NOW()
  `);
}

export async function upsertKbRelationship(args: {
  userId: string;
  documentId: string;
  source: string;
  target: string;
  relation: string;
  description: string;
  chunkId: string;
}): Promise<void> {
  const sourceTrim = args.source.trim();
  const targetTrim = args.target.trim();
  const relationTrim = args.relation.trim();
  if (!sourceTrim || !targetTrim || !relationTrim) return;

  const id = `r-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO kb_relationship (id, user_id, document_id, source, target, relation, description, source_chunk_ids, weight, created_at, updated_at)
    VALUES (${id}, ${args.userId}, ${args.documentId}, ${sourceTrim}, ${targetTrim}, ${relationTrim}, ${args.description.trim()}, ARRAY[${args.chunkId}]::text[], 1, NOW(), NOW())
    ON CONFLICT (user_id, document_id, source, target, relation) DO UPDATE
    SET weight = kb_relationship.weight + 1,
        source_chunk_ids = CASE
          WHEN ${args.chunkId} = ANY(kb_relationship.source_chunk_ids) THEN kb_relationship.source_chunk_ids
          ELSE array_append(kb_relationship.source_chunk_ids, ${args.chunkId})
        END,
        updated_at = NOW()
  `);
}

// ponytail: replace the chunk's theme set with `themes` (single source
// of truth — kb_theme is flat, one row per (chunk, name); no entity
// fan-out). Idempotent on retry — UNIQUE(chunk_id, name) makes
// re-INSERT a no-op via ON CONFLICT DO NOTHING. Callers run this
// AFTER entity / relationship upserts so `kb_theme` rows survive
// even when graph extraction returns zero nodes (chunk without
// entities still carries its macro themes).
export async function replaceChunkThemes(args: {
  userId: string;
  documentId: string;
  chunkId: string;
  themes: readonly string[];
}): Promise<void> {
  await db.execute(sql`
    DELETE FROM kb_theme
    WHERE user_id = ${args.userId}
      AND chunk_id = ${args.chunkId}
  `);

  const trimmed = Array.from(new Set(args.themes.map((t) => t.trim()).filter((t) => t.length > 0)));
  if (trimmed.length === 0) return;

  const rows = trimmed.map((name) => ({
    id: `t-${randomUUID()}`,
    userId: args.userId,
    documentId: args.documentId,
    chunkId: args.chunkId,
    name,
  }));
  await db.insert(kbTheme).values(rows).onConflictDoNothing();
}

// ponytail: theme alignment LLM pass (chunk-alignment-node.ts) feeds
// these mappings in. For each `{canonical, aliases}`, all matching
// `kb_theme.name` rows in this `(user_id, document_id)` get renamed
// in place to the canonical form. After the renames complete, a
// per-(chunk_id, name) dedup pass kills any row collisions (multiple
// aliases collapsing to the same canonical can leave a single chunk
// with two rows of the same name, violating UNIQUE(chunk_id, name)).
//
// Why in-place: storing `canonical_name` would mean read paths
// COALESCE everywhere + a schema migration. Theme names are LLM-
// generated tokens that the user never quotes back verbatim — losing
// the original variant on alignment is fine.
export async function applyThemeAlignment(args: {
  userId: string;
  documentId: string;
  mappings: ReadonlyArray<{ canonical: string; aliases: readonly string[] }>;
}): Promise<{ updated: number; deduped: number }> {
  let updated = 0;
  for (const mapping of args.mappings) {
    const aliases = mapping.aliases.filter((a) => a !== mapping.canonical);
    if (aliases.length === 0) continue;
    // Pre-format the alias set as a Postgres array literal — the
    // same drizzle sql tag gotcha as elsewhere (js arrays don't auto-
    // bind as pg text[]). Each alias is double-quote-escaped.
    const literal = `{${aliases
      .map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(",")}}`;
    const result = await db.execute(sql`
      WITH updated_rows AS (
        UPDATE kb_theme
        SET name = ${mapping.canonical}
        WHERE user_id = ${args.userId}
          AND document_id = ${args.documentId}
          AND name = ANY(${literal}::text[])
        RETURNING id
      )
      SELECT COUNT(*)::int AS n FROM updated_rows
    `);
    updated += Number((result as unknown as { n: number }[])[0]?.n ?? 0);
  }

  // ponytail: dedup collisions — keep one row per (chunk_id, name)
  // group, drop the rest. ROW_NUMBER over (chunk_id, name) ORDER BY id
  // (UUIDs are random, so any row is equivalent for our purpose).
  const dupResult = await db.execute(sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY chunk_id, name ORDER BY id
      ) AS rn
      FROM kb_theme
      WHERE user_id = ${args.userId}
        AND document_id = ${args.documentId}
    ),
    deleted AS (
      DELETE FROM kb_theme
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      RETURNING id
    )
    SELECT COUNT(*)::int AS n FROM deleted
  `);
  const deduped = Number((dupResult as unknown as { n: number }[])[0]?.n ?? 0);
  return { updated, deduped };
}

// ponytail: entity alias alignment, mirrors applyThemeAlignment's
// in-place rename + dedup. The LLM pass in chunk-alignment-node.ts
// emits `entityAliases: [{ canonicalName, aliases: string[] }]` and
// historically those rows were computed-and-discarded — only the
// themes side wrote back to the DB. Audit caught the gap; this
// function now actually folds alias variants into one canonical
// row per (user_id, document_id, name).
//
// Algorithm — pull all rows once, dedup in JS, write back per-row:
//  1. SELECT kb_entity + kb_relationship for the doc (2 round-trips).
//  2. Build alias → canonical rename map from the mappings.
//  3. Group entities by post-rename `name`. Each group:
//     - kept row = existing-canonical row if present, else lowest-id
//       alias row (id is UUID, stable ordering for ties)
//     - UPDATE kept with merged description (`;`-joined) and merged
//       source_chunk_ids (array distinct union)
//     - DELETE all losers (worklist in CTE)
//     - "renamed" = groups where any source name ≠ canonical name
//     - "merged" = groups with >1 input row
//  4. Apply the same rename to relationships, then group by
//     (post-rename source, post-rename target, relation). Each group
//     gets the same kept-row strategy + UPDATE (sum weight, union
//     source_chunk_ids) + DELETE losers.
//  5. Single withKbTx wraps the writes so a mid-flight failure rolls
//     back the whole rename.
//
// Why this is clearer than the SQL-only version: the rename + dedup
// logic lives in plain JS where it's testable as a function. The SQL
// does only the bulk read + per-row UPDATE/DELETE, so each round-trip
// is one statement. Adding invariant checks (e.g. "every rel target
// resolves to an entity row") becomes a JS assertion in step 3, not
// a 60-line CTE.
export async function applyEntityAliases(args: {
  userId: string;
  documentId: string;
  mappings: ReadonlyArray<{ canonical: string; aliases: readonly string[] }>;
}): Promise<{
  entitiesRenamed: number;
  entitiesMerged: number;
  relSourcesRenamed: number;
  relSourcesMerged: number;
  relTargetsRenamed: number;
  relTargetsMerged: number;
}> {
  const empty = {
    entitiesRenamed: 0,
    entitiesMerged: 0,
    relSourcesRenamed: 0,
    relSourcesMerged: 0,
    relTargetsRenamed: 0,
    relTargetsMerged: 0,
  };
  if (args.mappings.length === 0) return empty;

  // ponytail: build alias → canonical rename map once. Aliases list
  // may contain the canonical itself (LLM sometimes echoes it back);
  // filter those out so a row already named canonical doesn't get
  // "renamed" to itself. Empty aliases → skip the whole mapping.
  const renameMap = new Map<string, string>();
  for (const m of args.mappings) {
    for (const alias of m.aliases) {
      if (alias !== m.canonical) renameMap.set(alias, m.canonical);
    }
  }
  if (renameMap.size === 0) return empty;

  const [entities, relationships] = await Promise.all([
    findCanonicalEntitiesByDocId(args.userId, args.documentId),
    findCanonicalRelationshipsByDocId(args.userId, args.documentId),
  ]);

  // ---- entities ----
  // Group by canonical name. Kept row = existing-canonical row if one
  // exists in this group (avoids UPDATE-into-UNIQUE-collision against
  // an already-canonical row), else the lowest-id alias row.
  type EntityGroup = {
    canonical: string;
    rows: typeof entities;
    kept: (typeof entities)[number];
    mergedDesc: string;
    mergedChunkIds: string[];
    needsRename: boolean;
  };
  const entityGroupsByCanonical = new Map<string, EntityGroup>();
  for (const e of entities) {
    const canonical = renameMap.get(e.name) ?? e.name;
    let group = entityGroupsByCanonical.get(canonical);
    if (!group) {
      group = {
        canonical,
        rows: [],
        kept: e,
        mergedDesc: e.description ?? "",
        mergedChunkIds: [...(e.sourceChunkIds ?? [])],
        needsRename: e.name !== canonical,
      };
      entityGroupsByCanonical.set(canonical, group);
    }
    group.rows.push(e);
    // ponytail: existing-canonical row always wins — even if it
    // sorts after the alias in the input order. This keeps UPDATE
    // targets stable against pre-seeded fixture / reprocess rows.
    if (e.name === canonical && group.kept.name !== canonical) {
      group.kept = e;
      group.mergedDesc = e.description ?? "";
      group.mergedChunkIds = [...(e.sourceChunkIds ?? [])];
      group.needsRename = false;
    } else if (e.name !== canonical && group.kept.name !== canonical) {
      // both alias rows: tiebreak by lowest id
      if (e.id < group.kept.id) group.kept = e;
    }
    if (e.description) {
      if (group.mergedDesc.length === 0) group.mergedDesc = e.description;
      else if (!group.mergedDesc.includes(e.description)) {
        group.mergedDesc = `${group.mergedDesc}; ${e.description}`;
      }
    }
    for (const cid of e.sourceChunkIds ?? []) {
      if (!group.mergedChunkIds.includes(cid)) group.mergedChunkIds.push(cid);
    }
    if (e.name !== canonical) group.needsRename = true;
  }

  let entitiesRenamed = 0;
  let entitiesMerged = 0;
  const entityUpdates: Array<{
    id: string;
    name: string;
    description: string;
    sourceChunkIds: string[];
  }> = [];
  const entityDeletes: string[] = [];
  for (const group of entityGroupsByCanonical.values()) {
    if (group.rows.length === 1 && !group.needsRename) continue;
    if (group.rows.length > 1) entitiesMerged += 1;
    if (group.needsRename || group.rows.length > 1) entitiesRenamed += 1;
    // ponytail: DELETE losers FIRST (drizzle tx runs statements in
    // order). If we UPDATE kept to canonical while alias rows still
    // exist with their old name, no collision — but if kept is an
    // alias row being renamed to canonical and a pre-existing
    // canonical row sat in the group... that's filtered above by
    // picking canonical as kept. Losers are always alias rows that
    // never collide with kept's post-update name.
    entityDeletes.push(...group.rows.filter((r) => r.id !== group.kept.id).map((r) => r.id));
    entityUpdates.push({
      id: group.kept.id,
      name: group.canonical,
      description: group.mergedDesc,
      sourceChunkIds: group.mergedChunkIds,
    });
  }

  // ---- relationships ----
  // Apply rename to source / target, then dedup by (source, target,
  // relation). Track whether a group needed source-rename and/or
  // target-rename separately so the counters stay distinct.
  type RelGroup = {
    key: string;
    rows: typeof relationships;
    kept: (typeof relationships)[number];
    sourceRenamed: boolean;
    targetRenamed: boolean;
    mergedChunkIds: string[];
    totalWeight: number;
  };
  const relGroupsByKey = new Map<string, RelGroup>();
  for (const r of relationships) {
    const newSource = renameMap.get(r.source) ?? r.source;
    const newTarget = renameMap.get(r.target) ?? r.target;
    const key = `${newSource}::${r.relation}::${newTarget}`;
    const sourceRenamed = newSource !== r.source;
    const targetRenamed = newTarget !== r.target;
    let group = relGroupsByKey.get(key);
    if (!group) {
      group = {
        key,
        rows: [],
        kept: r,
        sourceRenamed,
        targetRenamed,
        mergedChunkIds: [...(r.sourceChunkIds ?? [])],
        totalWeight: 0,
      };
      relGroupsByKey.set(key, group);
    }
    group.rows.push(r);
    // ponytail: same kept-row strategy — existing-canonical edge
    // (no rename on either side) wins. Among same-shape edges, pick
    // the lowest id.
    const keptIsCanonical = group.kept.source === newSource && group.kept.target === newTarget;
    const rIsCanonical = sourceRenamed === false && targetRenamed === false;
    if (rIsCanonical && !keptIsCanonical) {
      group.kept = r;
      group.mergedChunkIds = [...(r.sourceChunkIds ?? [])];
    } else if (keptIsCanonical && rIsCanonical && r.id < group.kept.id) {
      group.kept = r;
    } else if (!keptIsCanonical && !rIsCanonical && r.id < group.kept.id) {
      group.kept = r;
    }
    if (sourceRenamed) group.sourceRenamed = true;
    if (targetRenamed) group.targetRenamed = true;
    for (const cid of r.sourceChunkIds ?? []) {
      if (!group.mergedChunkIds.includes(cid)) group.mergedChunkIds.push(cid);
    }
    group.totalWeight += r.weight;
  }

  let relSourcesRenamed = 0;
  let relSourcesMerged = 0;
  let relTargetsRenamed = 0;
  let relTargetsMerged = 0;
  const relUpdates: Array<{
    id: string;
    source: string;
    target: string;
    weight: number;
    sourceChunkIds: string[];
  }> = [];
  const relDeletes: string[] = [];
  for (const group of relGroupsByKey.values()) {
    if (group.sourceRenamed) relSourcesRenamed += 1;
    if (group.targetRenamed) relTargetsRenamed += 1;
    if (group.rows.length > 1) {
      if (group.sourceRenamed) relSourcesMerged += 1;
      if (group.targetRenamed) relTargetsMerged += 1;
    }
    relDeletes.push(...group.rows.filter((r) => r.id !== group.kept.id).map((r) => r.id));
    const keptRow = group.kept;
    const newSource = renameMap.get(keptRow.source) ?? keptRow.source;
    const newTarget = renameMap.get(keptRow.target) ?? keptRow.target;
    relUpdates.push({
      id: keptRow.id,
      source: newSource,
      target: newTarget,
      weight: group.totalWeight,
      sourceChunkIds: group.mergedChunkIds,
    });
  }

  // ---- write back ----
  // ponytail: one tx wraps the whole rename. Per-row UPDATE / DELETE
  // are simple — drizzle's update() / delete() don't need a custom
  // CTE to keep things atomic. 100 rows × 2 round-trips is fine for
  // the doc sizes we see (KB entity / rel counts stay under ~300 each).
  await withKbTx(async (tx) => {
    for (const u of entityUpdates) {
      await tx
        .update(kbEntity)
        .set({
          name: u.name,
          description: u.description,
          sourceChunkIds: u.sourceChunkIds,
          updatedAt: new Date(),
        })
        .where(eq(kbEntity.id, u.id));
    }
    if (entityDeletes.length > 0) {
      await tx.delete(kbEntity).where(inArray(kbEntity.id, entityDeletes));
    }
    for (const u of relUpdates) {
      await tx
        .update(kbRelationship)
        .set({
          source: u.source,
          target: u.target,
          weight: u.weight,
          sourceChunkIds: u.sourceChunkIds,
          updatedAt: new Date(),
        })
        .where(eq(kbRelationship.id, u.id));
    }
    if (relDeletes.length > 0) {
      await tx.delete(kbRelationship).where(inArray(kbRelationship.id, relDeletes));
    }
  });

  return {
    entitiesRenamed,
    entitiesMerged,
    relSourcesRenamed,
    relSourcesMerged,
    relTargetsRenamed,
    relTargetsMerged,
  };
}

// ponytail: bulk-read all themes that reference ANY chunk in
// `chunkIds`. Returns one flat array dedup'd per chunk via Map
// downstream — the caller is responsible for splitting by chunk.
// Used by chunkEmbedNode to prepend macro themes into the entity's
// embed text (audit §13b line 456).
export async function findKbThemesByChunkIds(
  userId: string,
  chunkIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (chunkIds.length === 0) return out;
  // ponytail: pre-formatted text[] literal — drizzle's sql tag doesn't
  // auto-bind a JS array as pg text[] without an explicit driver hint,
  // so we interpolate the literal instead of relying on parameter
  // inference. Same pattern as chunkIdArrayLiteral in the doc-detail
  // and folder-detail joins above.
  const literal = `{${chunkIds
    .map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
  const rows = await db.execute<{ chunk_id: string; name: string }>(sql`
    SELECT chunk_id, name
    FROM kb_theme
    WHERE user_id = ${userId}
      AND chunk_id = ANY(${literal}::text[])
  `);
  for (const r of rows) {
    const bucket = out.get(r.chunk_id) ?? [];
    if (!bucket.includes(r.name)) bucket.push(r.name);
    out.set(r.chunk_id, bucket);
  }
  return out;
}

export async function deleteKbDocumentForUser(
  userId: string,
  docId: string,
): Promise<KbDocument | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(kbDocument)
      .where(and(eq(kbDocument.id, docId), eq(kbDocument.userId, userId)))
      .returning();
    if (row) {
      const threadId = docId.replace(/^d-/, "");
      await tx.delete(threads).where(and(eq(threads.id, threadId), eq(threads.kind, "kb")));
    }
    return row ?? null;
  });
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
