import "server-only";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { threads, type Thread, type ThreadCustom } from "./schema";

const DEFAULT_TITLE = "New chat";
const ID_LENGTH = 12;

export async function listThreads(): Promise<Thread[]> {
  return db
    .select()
    .from(threads)
    .where(eq(threads.status, "regular"))
    .orderBy(desc(threads.updatedAt));
}

export async function getThread(id: string): Promise<Thread | undefined> {
  const [row] = await db.select().from(threads).where(eq(threads.id, id));
  return row;
}

export async function createThread(title: string = DEFAULT_TITLE): Promise<Thread> {
  const id = nanoid(ID_LENGTH);
  const [row] = await db.insert(threads).values({ id, title }).returning();
  return row!;
}

export async function renameThread(id: string, title: string): Promise<Thread | undefined> {
  const [row] = await db
    .update(threads)
    .set({ title, updatedAt: new Date() })
    .where(eq(threads.id, id))
    .returning();
  return row;
}

export async function archiveThread(id: string): Promise<void> {
  await db.update(threads).set({ status: "archived" }).where(eq(threads.id, id));
}

export async function unarchiveThread(id: string): Promise<void> {
  await db.update(threads).set({ status: "regular" }).where(eq(threads.id, id));
}

export async function deleteThread(id: string): Promise<void> {
  await db.delete(threads).where(eq(threads.id, id));
}

export async function updateCustom(id: string, custom: ThreadCustom): Promise<void> {
  await db.update(threads).set({ custom, updatedAt: new Date() }).where(eq(threads.id, id));
}

export async function touchThread(id: string): Promise<void> {
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, id));
}

export type { Thread, ThreadCustom };
