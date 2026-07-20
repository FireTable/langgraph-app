CREATE TYPE "public"."kb_observability_mode" AS ENUM('full', 'chunksOnly', 'retryFailed', 'retryFailedChunks');--> statement-breakpoint
CREATE TYPE "public"."kb_observability_source" AS ENUM('kb-upload', 'kb-reprocess', 'chat');--> statement-breakpoint
CREATE TABLE "kb_observability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_message_id" text NOT NULL,
	"run_id" text,
	"source" "kb_observability_source" NOT NULL,
	"mode" "kb_observability_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_observability" ADD CONSTRAINT "kb_observability_doc_id_kb_document_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."kb_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_observability_doc_created_idx" ON "kb_observability" USING btree ("doc_id","created_at" DESC NULLS LAST);