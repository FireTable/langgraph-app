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
  patch: { status: "pending" | "uploaded"; confirmedAt?: Date },
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

// Q2: dedup probe. Returns the user's existing uploaded row for this sha
// if one exists, so presign can return its publicUrl and skip the PUT.
export async function findUploadedBySha(
  userId: string,
  sha256: string,
): Promise<Attachment | null> {
  const row = await db.query.attachments.findFirst({
    where: (t, { and: a, eq: e }) =>
      a(e(t.userId, userId), e(t.sha256, sha256), e(t.status, "uploaded")),
  });
  return row ?? null;
}

// ponytail: kbAgent.screenshotNode (#13 v2) needs to look up an attachment
// by its R2 publicUrl — the URL is what rides in the chat message's
// file content part. Index on (userId, r2Key) would be ideal, but
// r2Key already serves the dedup index (attachments_user_sha_idx uses
// the same leading column). For v2 a scan over the user's recent
// attachments is fine; add the index when this gets hot.
export async function findAttachmentByR2Key(
  userId: string,
  r2Key: string,
): Promise<Attachment | null> {
  const row = await db.query.attachments.findFirst({
    where: (t, { and: a, eq: e }) => a(e(t.userId, userId), e(t.r2Key, r2Key)),
  });
  return row ?? null;
}
