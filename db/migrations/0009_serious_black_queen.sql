ALTER TABLE "kb_chunk" ALTER COLUMN "entities" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "kb_chunk" ALTER COLUMN "entities" SET DATA TYPE jsonb USING '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "kb_chunk" ALTER COLUMN "entities" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "kb_chunk" ADD COLUMN "relationships" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_chunk" ADD COLUMN "themes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "kb_chunk_themes_idx" ON "kb_chunk" USING gin ("themes");