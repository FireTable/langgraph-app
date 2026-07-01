CREATE TABLE "observability_spans" (
	"span_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"input" jsonb,
	"output" jsonb,
	"usage" jsonb,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "observability_spans" ADD CONSTRAINT "observability_spans_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observability_spans_thread_started_idx" ON "observability_spans" USING btree ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "observability_spans_thread_parent_started_idx" ON "observability_spans" USING btree ("thread_id","parent_message_id","started_at");--> statement-breakpoint
CREATE INDEX "observability_spans_created_idx" ON "observability_spans" USING btree ("created_at");