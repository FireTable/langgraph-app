CREATE TABLE "eval_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"rating" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_judgment" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"rubric_id" text NOT NULL,
	"scores" jsonb NOT NULL,
	"reasoning" text,
	"total_cost_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_rubric" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_run" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"template_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"branch_id" text,
	"parent_message_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"kb_document_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"content" text NOT NULL,
	"notes" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"label" text NOT NULL,
	"traffic_weight" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_variant_assignment" (
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"variant_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_variant_assignment_user_id_agent_pk" PRIMARY KEY("user_id","agent")
);
--> statement-breakpoint
ALTER TABLE "eval_feedback" ADD CONSTRAINT "eval_feedback_run_id_eval_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_feedback" ADD CONSTRAINT "eval_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_judgment" ADD CONSTRAINT "eval_judgment_run_id_eval_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_judgment" ADD CONSTRAINT "eval_judgment_rubric_id_eval_rubric_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."eval_rubric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_variant_id_prompt_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."prompt_variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variant" ADD CONSTRAINT "prompt_variant_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variant_assignment" ADD CONSTRAINT "prompt_variant_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_variant_assignment" ADD CONSTRAINT "prompt_variant_assignment_variant_id_prompt_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."prompt_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_feedback_run_idx" ON "eval_feedback" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_feedback_user_run_idx" ON "eval_feedback" USING btree ("user_id","run_id");--> statement-breakpoint
CREATE INDEX "eval_judgment_run_idx" ON "eval_judgment" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "eval_run_user_idx" ON "eval_run" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "eval_run_variant_idx" ON "eval_run" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "eval_run_thread_idx" ON "eval_run" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "eval_run_parent_message_idx" ON "eval_run" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "eval_run_created_idx" ON "eval_run" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "prompt_template_agent_idx" ON "prompt_template" USING btree ("agent");--> statement-breakpoint
CREATE INDEX "prompt_variant_template_idx" ON "prompt_variant" USING btree ("template_id");