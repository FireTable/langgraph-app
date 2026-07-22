ALTER TABLE "kb_entity" ADD COLUMN "themes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_relationship" ADD COLUMN "themes" text[] DEFAULT '{}'::text[] NOT NULL;