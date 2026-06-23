import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { user } from "@/lib/auth/schema";
import { DEFAULT_THREAD_TITLE } from "@/lib/constants";

// Threads metadata for assistant-ui RemoteThreadListAdapter.
// The LangGraph checkpoint_* tables are created by PostgresSaver.setup()
// at runtime and are NOT managed here.

export type ThreadCustom = Record<string, unknown>;

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default(DEFAULT_THREAD_TITLE),
    status: text("status", { enum: ["regular", "archived"] })
      .notNull()
      .default("regular"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // $type<> makes Drizzle treat the jsonb column as a typed record rather
    // than the generic `unknown` json shape.
    custom: jsonb("custom").$type<ThreadCustom>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Set to `now()` by afterAgentNode when a turn finishes; falls back to
    // `created_at` (via defaultNow) for threads that have never seen a
    // message. Approximates "last activity" for sidebar sort — do not
    // treat as the actual max(updatedAt) of any checkpoint table.
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("threads_status_updated_idx").on(t.status, t.updatedAt.desc()),
    index("threads_status_last_message_idx").on(t.status, t.lastMessageAt.desc()),
    index("threads_user_id_idx").on(t.userId),
  ],
);

// Zod schemas derived from the Drizzle table. Used internally for type-safe
// inserts/selects and re-exported for API consumers via lib/threads/validators.ts.

export const ThreadInsert = createInsertSchema(threads);
export const ThreadSelect = createSelectSchema(threads);

export type Thread = z.infer<typeof ThreadSelect>;
export type NewThread = z.infer<typeof ThreadInsert>;
