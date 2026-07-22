CREATE TABLE "kb_entity" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"source_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_relationship" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"relation" text NOT NULL,
	"description" text NOT NULL,
	"source_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_chunk_entities_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "kb_chunk_themes_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "kb_chunk_tsv_idx";--> statement-breakpoint
ALTER TABLE "kb_chunk" DROP COLUMN IF EXISTS "tsv";--> statement-breakpoint
ALTER TABLE "kb_chunk" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;--> statement-breakpoint
CREATE INDEX "kb_chunk_tsv_idx" ON "kb_chunk" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "kb_entity" ADD CONSTRAINT "kb_entity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entity" ADD CONSTRAINT "kb_entity_document_id_kb_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_relationship" ADD CONSTRAINT "kb_relationship_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_relationship" ADD CONSTRAINT "kb_relationship_document_id_kb_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_entity_user_doc_name_idx" ON "kb_entity" USING btree ("user_id","document_id","name");--> statement-breakpoint
CREATE INDEX "kb_entity_embedding_idx" ON "kb_entity" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_entity_user_name_idx" ON "kb_entity" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "kb_entity_document_idx" ON "kb_entity" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_relationship_user_doc_str_idx" ON "kb_relationship" USING btree ("user_id","document_id","source","target","relation");--> statement-breakpoint
CREATE INDEX "kb_relationship_embedding_idx" ON "kb_relationship" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_relationship_user_source_idx" ON "kb_relationship" USING btree ("user_id","document_id","source");--> statement-breakpoint
CREATE INDEX "kb_relationship_user_target_idx" ON "kb_relationship" USING btree ("user_id","document_id","target");--> statement-breakpoint
CREATE INDEX "kb_relationship_document_idx" ON "kb_relationship" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "kb_chunk" DROP COLUMN IF EXISTS "entities";--> statement-breakpoint
ALTER TABLE "kb_chunk" DROP COLUMN IF EXISTS "relationships";--> statement-breakpoint
ALTER TABLE "kb_chunk" DROP COLUMN IF EXISTS "themes";