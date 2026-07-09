ALTER TABLE "attachments" ADD COLUMN "sha256" text;--> statement-breakpoint
-- Ponytail: partial index — only uploaded rows participate in dedup.
-- Two pending rows with the same sha can exist (in-flight uploads from
-- different tabs) without conflicting. Becomes unique when both flip to
-- 'uploaded' because the dedup lookup returns the existing row before
-- inserting a second one.
CREATE UNIQUE INDEX "attachments_user_sha_uploaded_idx"
  ON "attachments" ("user_id", "sha256")
  WHERE "status" = 'uploaded' AND "sha256" IS NOT NULL;