import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { user } from "@/lib/auth/schema";

// Per-file attachment metadata for chat uploads (issue #12).
// Backing bytes live in Cloudflare R2; this row is the source of truth
// for the URL the renderer hands the model.
//
// Attachment rows are intentionally NOT bound to thread_id or message_id:
// (a) the assistant-ui composer dispatches the message AFTER
//     adapter.send() returns, so at presign time the thread is still a
//     __LOCALID_* placeholder — there's no row to FK against, and
//     backfill-by-time-window is fragile;
// (b) the renderer reads content parts directly off the message
//     (`{ type: "image", image: publicUrl }` is embedded by send()), so
//     no thread-side attachment query is needed;
// (c) dedup is per-user via sha256 (see Q2) — cross-thread sharing is
//     handled by message content parts already containing the publicUrl.
//
// Lifecycle: orphan rows (created but never sent) are swept by a
// retention job, NOT by thread ON DELETE CASCADE — see
// docs/ATTACHMENTS.md for the eventual cleanup script.

export const attachments = pgTable(
  "attachments",
  {
    // 12-char nanoid, also embedded as the R2 key prefix.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // SHA-256 of the file bytes as 64-char hex. Optional — clients that
    // don't compute a hash (older browsers, server-side flows) still work.
    // When set, presign dedups: a matching (user_id, sha256) row in
    // status='uploaded' short-circuits the PUT and returns the existing
    // publicUrl. Partial unique index below enforces "one uploaded row
    // per (user, sha)"; pending rows are unconstrained to avoid two
    // parallel uploads racing the same R2 key.
    sha256: text("sha256"),
    // Full R2 key, e.g. "u/<userId>/<sha256>.<ext>".
    r2Key: text("r2_key").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    // Claimed at presign (matches R2_MAX_BYTES allow-list), verified at
    // confirm via HeadObject. bigint because we cap at 10 MiB but
    // future-proofs a higher cap.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: text("status", { enum: ["pending", "uploaded"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    // "List this user's recent attachments" + retention sweep target.
    index("attachments_user_created_idx").on(t.userId, t.createdAt.desc()),
    // Dedup probe: "is there an uploaded row for this (user, sha)?"
    index("attachments_user_sha_idx").on(t.userId, t.sha256),
  ],
);

export const AttachmentInsert = createInsertSchema(attachments);
export const AttachmentSelect = createSelectSchema(attachments);
export type Attachment = z.infer<typeof AttachmentSelect>;
export type NewAttachment = z.infer<typeof AttachmentInsert>;
