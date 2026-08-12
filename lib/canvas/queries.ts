import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { canvasSnapshots, type CanvasDocument, type CanvasSnapshot } from "./schema";
import { threads } from "@/lib/threads/schema";

// ponytail: threadId is the natural primary key — one row per thread,
// no auto-generated id needed. The FK to threads cascades on delete so
// archive/cleanup paths don't need a parallel canvas query.
//
// All read paths JOIN against threads.userId so the owner check is one
// query. There's no separate 403 path; the route treats "not yours" the
// same as "doesn't exist" and returns 404 — prevents enumeration of
// other users' thread ids.

export async function getCanvasSnapshotForUser(
  threadId: string,
  userId: string,
): Promise<CanvasSnapshot | undefined> {
  const [row] = await db
    .select({ snap: canvasSnapshots })
    .from(canvasSnapshots)
    .innerJoin(threads, and(eq(threads.id, canvasSnapshots.threadId), eq(threads.userId, userId)))
    .where(eq(canvasSnapshots.threadId, threadId))
    .limit(1);
  return row?.snap;
}

export async function threadOwnedByUser(threadId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);
  return !!row;
}

// ponytail: upsert — first save creates the row, subsequent saves update
// in place. No "create" / "update" branches to keep wrong. onConflictDoUpdate
// on the PK with `updatedAt = now()` is the canonical "last write wins"
// pattern; debounce in lib/canvas/auto-save keeps write rate low.
export async function upsertCanvasSnapshot(args: {
  threadId: string;
  userId: string;
  document: CanvasDocument;
}): Promise<CanvasSnapshot> {
  // ponytail: race-safe ownership check before upsert — the FK already
  // cascades from threads, so an upsert targeting a non-owned thread
  // would write a row that we then can't filter on the read path. A
  // cheap pre-check keeps the write path clean.
  const owned = await threadOwnedByUser(args.threadId, args.userId);
  if (!owned) throw new Error("thread not owned by user");
  const [row] = await db
    .insert(canvasSnapshots)
    .values({ threadId: args.threadId, document: args.document })
    .onConflictDoUpdate({
      target: canvasSnapshots.threadId,
      set: { document: args.document, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function deleteCanvasSnapshot(threadId: string, userId: string): Promise<void> {
  // ponytail: delete gated on ownership (same pattern as archiveThread).
  // No row count check — silent no-op for non-owned threads matches the
  // 404-on-miss read path.
  await db.delete(canvasSnapshots).where(
    and(
      eq(canvasSnapshots.threadId, threadId),
      // Existence of a matching threads row with userId is implied by FK,
      // but we double-check via a subquery to keep deletes scoped to
      // owned threads.
      sql`${canvasSnapshots.threadId} IN (
          SELECT id FROM ${threads} WHERE user_id = ${userId}
        )`,
    ),
  );
}
