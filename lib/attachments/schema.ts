import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { user } from "@/lib/auth/schema";
import { threads } from "@/lib/threads/schema";

// Per-file attachment metadata for chat uploads (issue #12).
// Backing bytes live in Cloudflare R2; this row is the source of truth
// for the URL the renderer hands the model and for thread-side cleanup.
//
// No `message_id` column: assistant-ui has no documented mechanism to
// correlate an attachment with the resulting message after send — see
// docs/ATTACHMENTS.md for the (thread_id, created_at) join strategy.

export const attachments = pgTable(
  "attachments",
  {
    // 12-char nanoid, also embedded as the R2 key prefix (e.g. "abc123def456-photo.png").
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set at presign time when the adapter knows the active thread; nullable
    // for the brief window between presign and confirm. ON DELETE CASCADE
    // so a thread removal also drops its attachments.
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    // Full R2 key, e.g. "u/<userId>/<nanoid>-<safe-name>".
    r2Key: text("r2_key").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    // Claimed at presign (matches R2_MAX_BYTES allow-list), verified at
    // confirm via HeadObject. Stored as bigint because we cap at 10 MiB but
    // Drizzle's pg bigint is cheap and future-proofs a higher cap.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: text("status", { enum: ["pending", "uploaded"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    // Sidebar / cleanup: "list this user's recent attachments".
    index("attachments_user_created_idx").on(t.userId, t.createdAt.desc()),
    // Thread-side join: "find attachments created around this message".
    index("attachments_thread_created_idx").on(t.threadId, t.createdAt.desc()),
  ],
);

export const AttachmentInsert = createInsertSchema(attachments);
export const AttachmentSelect = createSelectSchema(attachments);
export type Attachment = z.infer<typeof AttachmentSelect>;
export type NewAttachment = z.infer<typeof AttachmentInsert>;
