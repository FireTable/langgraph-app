import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { threads, type Thread, type ThreadCustom } from "./schema";
import { DEFAULT_THREAD_TITLE } from "@/lib/constants";
import { checkpointer } from "@/backend/checkpointer";
import { deleteMemoryDoc, deleteThreadSummaries } from "@/lib/memory/queries";

export async function listThreadsForUser(userId: string): Promise<Thread[]> {
  return (
    db
      .select()
      .from(threads)
      // ponytail: kind='chat' keeps standalone kbAgent ingestion threads
      // (kind='kb') out of the user's chat sidebar. status='regular' still
      // filters user-archived chats. The two flags are orthogonal.
      .where(
        and(eq(threads.userId, userId), eq(threads.status, "regular"), eq(threads.kind, "chat")),
      )
      .orderBy(desc(threads.updatedAt))
  );
}

export async function getThreadForUser(id: string, userId: string): Promise<Thread | undefined> {
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, userId)));
  return row;
}

export async function createThread(args: { userId: string; title?: string }): Promise<Thread> {
  const title = args.title ?? DEFAULT_THREAD_TITLE;
  // UUIDs are required by the LangGraph HTTP API's zod validation on
  // /threads/[id]/state and /threads/[id]/stream paths; using a short
  // nanoid breaks the "click thread to load history" path with a 400.
  const id = randomUUID();
  const [row] = await db
    .insert(threads)
    .values({ id, userId: args.userId, title, kind: "chat" })
    .returning();
  return row!;
}

export async function archiveThread(id: string, userId: string): Promise<void> {
  await db
    .update(threads)
    .set({ status: "archived" })
    .where(and(eq(threads.id, id), eq(threads.userId, userId)));
}

export async function unarchiveThread(id: string, userId: string): Promise<void> {
  await db
    .update(threads)
    .set({ status: "regular" })
    .where(and(eq(threads.id, id), eq(threads.userId, userId)));
}

export async function deleteThread(id: string, userId: string): Promise<void> {
  await db.delete(threads).where(and(eq(threads.id, id), eq(threads.userId, userId)));
}

// ponytail: best-effort sweep of the per-thread state that lives OUTSIDE the
// `threads` row — LangGraph checkpointer rows + PostgresStore thread summaries.
// The threads-row delete itself happens in `deleteThread` above; the route
// composes the two. Each step is wrapped so a partial failure (DB transient,
// store unavailable) doesn't leave the user staring at a thread they already
// asked to be rid of — orphaned checkpoints/summaries are a disk-cleanup
// problem, not a UX one. Observability spans ride on the `threads` row's FK
// ON DELETE CASCADE so they get swept automatically.
export async function purgeThreadState(id: string, userId: string): Promise<void> {
  try {
    await checkpointer?.deleteThread(id);
  } catch (err) {
    // ponytail: console.warn is the right level here — best-effort, the
    // caller is the DELETE route handler which has already validated
    // ownership. add a retention sweep when orphan rows actually pile up.
    console.warn(`purgeThreadState: checkpointer.deleteThread(${id}) failed`, err);
  }
  try {
    await deleteThreadSummaries(userId, id);
  } catch (err) {
    console.warn(`purgeThreadState: deleteThreadSummaries(${userId}, ${id}) failed`, err);
  }
}

// ponytail: account-level sweep. Iterates every thread this user owns and
// reuses `purgeThreadState` per row, then wipes the cross-thread memory
// profile key. Other tables (account, session, attachments, credit_usage_log)
// ride the user FK cascade so they don't need a manual call. Must run BEFORE
// db.delete(user) — once the threads cascade fires, their ids are gone.
export async function purgeUserState(userId: string): Promise<void> {
  const rows = await db.select({ id: threads.id }).from(threads).where(eq(threads.userId, userId));
  for (const { id } of rows) {
    try {
      await purgeThreadState(id, userId);
    } catch (err) {
      console.warn(`purgeUserState: purgeThreadState(${id}, ${userId}) failed`, err);
    }
  }
  try {
    await deleteMemoryDoc(userId);
  } catch (err) {
    console.warn(`purgeUserState: deleteMemoryDoc(${userId}) failed`, err);
  }
}

export async function updateCustom(
  id: string,
  userId: string,
  custom: ThreadCustom,
): Promise<void> {
  await db
    .update(threads)
    .set({ custom, updatedAt: new Date() })
    .where(and(eq(threads.id, id), eq(threads.userId, userId)));
}

// Internal graph-only helpers — no userId, no ownership check.
// Trust model: the graph runtime is reached through an HTTP session guarded
// at the /api/threads/* layer; thread_id is an opaque handle to a thread the
// calling user already owns. API routes that mutate these should pre-check
// ownership via getThreadForUser(id, userId).
export async function renameThread(id: string, title: string): Promise<void> {
  await db.update(threads).set({ title, updatedAt: new Date() }).where(eq(threads.id, id));
}

export async function touchLastMessageAt(id: string): Promise<void> {
  await db.update(threads).set({ lastMessageAt: new Date() }).where(eq(threads.id, id));
}

// ponytail: title-only read for the renameThreadAgent conditional edge.
// Avoids fetching the full thread row (status, custom, last_message_at...)
// when all we need is "is the title set yet?".
export async function getThreadTitle(id: string): Promise<string | null> {
  const [row] = await db
    .select({ title: threads.title })
    .from(threads)
    .where(eq(threads.id, id))
    .limit(1);
  return row?.title ?? null;
}

// ponytail: bulk title read for callers that already have a list of
// threadIds (the Memory tab's summary reader — joins summaries → threads
// without an N+1 select). Returns Map<threadId, title>; missing rows are
// absent (caller renders the bare threadId as fallback).
//
// Ownership: the rows are filtered to (userId, id IN threadIds) so a
// crafted threadId can't leak another user's title — same shape as
// getThreadForUser but batched. Empty input → empty map, no round trip.
export async function getThreadTitlesForUser(
  userId: string,
  threadIds: readonly string[],
): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({ id: threads.id, title: threads.title })
    .from(threads)
    .where(and(eq(threads.userId, userId), inArray(threads.id, threadIds as string[])));
  return new Map(rows.map((r) => [r.id, r.title]));
}

export type { Thread, ThreadCustom };
