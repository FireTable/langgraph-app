CREATE TABLE "kb_theme" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_theme" ADD CONSTRAINT "kb_theme_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_theme" ADD CONSTRAINT "kb_theme_document_id_kb_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_theme" ADD CONSTRAINT "kb_theme_chunk_id_kb_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."kb_chunk"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_theme_chunk_name_idx" ON "kb_theme" USING btree ("chunk_id","name");--> statement-breakpoint
CREATE INDEX "kb_theme_user_name_idx" ON "kb_theme" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "kb_theme_user_document_idx" ON "kb_theme" USING btree ("user_id","document_id");--> statement-breakpoint
CREATE INDEX "kb_theme_chunk_idx" ON "kb_theme" USING btree ("chunk_id");--> statement-breakpoint
ALTER TABLE "kb_entity" DROP COLUMN "themes";--> statement-breakpoint
ALTER TABLE "kb_relationship" DROP COLUMN "themes";