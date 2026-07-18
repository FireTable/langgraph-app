CREATE TYPE "public"."kb_chunk_status" AS ENUM('pending', 'parsing', 'success', 'failed');--> statement-breakpoint
-- ponytail: per-chunk status — chunk ingest (embed + entity extract)
-- can fail without downgrading the parent kb_document. New chunks
-- land as 'pending' via the column default; the chunkEmbedStoreNode
-- updates them to 'success' or 'failed' once the per-chunk pipeline
-- lands. Existing rows are all 'success' (legacy chunks were
-- functional — pre-status-column they were unconditionally indexed).
-- We add the column WITHOUT a DEFAULT, backfill, then add the
-- default + NOT NULL. Adding a column with a DEFAULT in one ALTER
-- statement would backfill every existing row with that default in
-- PG ≥11, which would silently de-list every legacy chunk from RAG
-- search (`lib/kb/search.ts` filters on status='success').
ALTER TABLE "kb_chunk" ADD COLUMN "status" "kb_chunk_status";--> statement-breakpoint
ALTER TABLE "kb_chunk" ADD COLUMN "error_message" text;--> statement-breakpoint
UPDATE "kb_chunk" SET "status" = 'success' WHERE "status" IS NULL;--> statement-breakpoint
ALTER TABLE "kb_chunk" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "kb_chunk" ALTER COLUMN "status" SET NOT NULL;