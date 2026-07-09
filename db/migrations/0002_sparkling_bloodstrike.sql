CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sha256" text,
	"r2_key" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_user_created_idx" ON "attachments" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attachments_user_sha_idx" ON "attachments" USING btree ("user_id","sha256");