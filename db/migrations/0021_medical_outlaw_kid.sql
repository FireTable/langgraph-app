ALTER TABLE "eval_benchmark" ADD COLUMN "latest_judgment_id" text;--> statement-breakpoint
ALTER TABLE "eval_benchmark" ADD COLUMN "latest_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_benchmark" ADD COLUMN "latest_run_status" text;--> statement-breakpoint
ALTER TABLE "eval_benchmark" ADD COLUMN "latest_score" integer;