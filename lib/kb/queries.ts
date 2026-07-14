import { and, asc, desc, eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
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
    // Postgres unique-violation SQLSTATE is 23505.
    if ((err as { code?: string }).code === "23505") {
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
  await tx.insert(kbChunk).values(rows);
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

// ponytail: KB transaction helper. Wraps Drizzle's transaction so the
// caller (chunkEmbedStoreNode) inserts doc + chunks atomically. Returning
// the tx-bound objects lets the caller reuse the freshly-inserted doc.
export async function withKbTx<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
  return db.transaction(fn) as Promise<T>;
}
