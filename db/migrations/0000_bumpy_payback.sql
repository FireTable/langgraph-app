CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"status" text DEFAULT 'regular' NOT NULL,
	"user_id" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "threads_status_updated_idx" ON "threads" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_status_last_message_idx" ON "threads" USING btree ("status","last_message_at" DESC NULLS LAST);