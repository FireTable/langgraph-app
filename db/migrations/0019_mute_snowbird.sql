CREATE TABLE "eval_benchmark" (
	"id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"title" text NOT NULL,
	"input_prompt" text NOT NULL,
	"expected_output" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_judgment" ADD COLUMN "judge_thread_id" text;--> statement-breakpoint
CREATE INDEX "eval_benchmark_agent_idx" ON "eval_benchmark" USING btree ("agent");