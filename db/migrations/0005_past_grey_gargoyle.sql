CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."kb_doc_status" AS ENUM('pending', 'parsing', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "kb_chunk" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED NOT NULL,
	"entities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_document" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"attachment_id" text,
	"title" text NOT NULL,
	"content_type" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" "kb_doc_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunk" ADD CONSTRAINT "kb_chunk_document_id_kb_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_folder_id_kb_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."kb_folder"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_folder" ADD CONSTRAINT "kb_folder_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunk_document_ordinal_idx" ON "kb_chunk" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_chunk_embedding_idx" ON "kb_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_chunk_tsv_idx" ON "kb_chunk" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "kb_chunk_entities_idx" ON "kb_chunk" USING gin ("entities");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_user_contenthash_idx" ON "kb_document" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "kb_document_user_created_idx" ON "kb_document" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kb_document_folder_idx" ON "kb_document" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "kb_document_user_attachment_idx" ON "kb_document" USING btree ("user_id","attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_folder_user_name_idx" ON "kb_folder" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "kb_folder_user_idx" ON "kb_folder" USING btree ("user_id");