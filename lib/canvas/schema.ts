import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { threads } from "@/lib/threads/schema";

// Canvas snapshot per thread. One row per threadId; the canvas document
// is a React Flow (xyflow) `{ nodes, edges }` blob — typed shapes we
// define ourselves (text / preview / generate).
//
// ponytail: snapshot is the live React Flow state. We serialise both
// arrays and restore them on thread switch. Storing the full document
// instead of a per-node diff table keeps the surface tiny: one GET,
// one PUT, no merge logic. Tradeoff: large canvases write the whole
// document on every change — debounced 2s in lib/canvas/auto-save.

export type CanvasDocument = Record<string, unknown>;

export const canvasSnapshots = pgTable("canvas_snapshots", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  // ponytail: the document is a plain JSON object; we type it as a
  // free record so the runtime cost is just a jsonb roundtrip. A
  // stricter shape (typed records) is tempting but React Flow's own
  // store validates on load — round-tripping arbitrary JSON through
  // zod just to re-parse what React Flow already validates is
  // duplication.
  document: jsonb("document").$type<CanvasDocument>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const CanvasSnapshotInsert = createInsertSchema(canvasSnapshots);
export const CanvasSnapshotSelect = createSelectSchema(canvasSnapshots);

export type CanvasSnapshot = z.infer<typeof CanvasSnapshotSelect>;
export type NewCanvasSnapshot = z.infer<typeof CanvasSnapshotInsert>;
