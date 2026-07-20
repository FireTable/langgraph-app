ALTER TABLE "threads" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_kind_idx" ON "threads" USING btree ("kind");