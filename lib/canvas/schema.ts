import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { threads } from "@/lib/threads/schema";

// Canvas snapshot per thread. One row per threadId; the canvas document
// is a tldraw TLDocument blob (shapes + pages + bindings + assets refs).
//
// ponytail: snapshot is the full tldraw `store.serialize('document')` payload
// (per tldraw's SPEC §1, only the `document` scope is persisted + synced —
// session/presence stay per-browser in localStorage). Storing the full
// blob instead of a per-shape diff table keeps the surface tiny: one
// GET, one PUT, no merge logic. Tradeoff: large canvases write the
// whole document on every change — debounced 2s in lib/canvas/auto-save.

export type CanvasDocument = Record<string, unknown>;

export const canvasSnapshots = pgTable("canvas_snapshots", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  // ponytail: tldraw's TLDocument is a plain JSON object; we type it as
  // a free record so the runtime cost is just a jsonb roundtrip. A
  // stricter shape (typed records) is tempting but tldraw's store
  // validates on load — round-tripping an arbitrary JSON through zod
  // just to re-parse what tldraw already validates is duplication.
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
