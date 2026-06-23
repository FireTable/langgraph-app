import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { threads, type Thread, type ThreadCustom } from "./schema";

const DEFAULT_TITLE = "New Chat";

export async function listThreadsForUser(userId: string): Promise<Thread[]> {
  return db
    .select()
    .from(threads)
    .where(and(eq(threads.userId, userId), eq(threads.status, "regular")))
    .orderBy(desc(threads.updatedAt));
}

export async function getThreadForUser(id: string, userId: string): Promise<Thread | undefined> {
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, userId)));
  return row;
}

export async function createThread(args: {
  userId: string;
  title?: string;
}): Promise<Thread> {
  const title = args.title ?? DEFAULT_TITLE;
  // UUIDs are required by the LangGraph HTTP API's zod validation on
  // /threads/[id]/state and /threads/[id]/stream paths; using a short
  // nanoid breaks the "click thread to load history" path with a 400.
  const id = randomUUID();
  const [row] = await db
    .insert(threads)
    .values({ id, userId: args.userId, title })
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

export type { Thread, ThreadCustom };
