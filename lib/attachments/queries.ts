import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { attachments, type Attachment, type NewAttachment } from "./schema";

// All attachment reads scope by user_id at the query layer; routes wrap in
// withAuth but a leaked id from another user must still 404 (no existence
// leak — mirrors the threads module).

export async function insertAttachment(row: NewAttachment): Promise<Attachment> {
  const [out] = await db.insert(attachments).values(row).returning();
  return out;
}

export async function getAttachmentForUser(id: string, userId: string): Promise<Attachment | null> {
  const row = await db.query.attachments.findFirst({
    where: and(eq(attachments.id, id), eq(attachments.userId, userId)),
  });
  return row ?? null;
}

export async function setAttachmentStatus(
  id: string,
  userId: string,
  patch: { status: "pending" | "uploaded"; confirmedAt?: Date; threadId?: string },
): Promise<Attachment | null> {
  const [row] = await db
    .update(attachments)
    .set(patch)
    .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteAttachmentForUser(
  id: string,
  userId: string,
): Promise<Attachment | null> {
  const [row] = await db
    .delete(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
    .returning();
  return row ?? null;
}
