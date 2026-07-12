CREATE TYPE "public"."call_status" AS ENUM('success', 'error');--> statement-breakpoint
CREATE TABLE "role" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credit_limit" integer,
	"window_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
-- Seed role rows BEFORE the FK on user.role_id is added.
-- Without this, ALTER TABLE ... ADD CONSTRAINT fails on existing user
-- rows whose role_id default ('user') has no matching role row.
-- ON CONFLICT keeps the migration idempotent across re-runs.
INSERT INTO "role" ("id", "name", "credit_limit", "window_hours") VALUES
  ('guest', 'Guest', 20,   24),
  ('user',  'User',  200,  24),
  ('admin', 'Admin', NULL, 24)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"base_url" text NOT NULL,
	"api_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_usage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_name" text NOT NULL,
	"agent_name" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"credits" numeric(12, 4) NOT NULL,
	"status" "call_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role_id" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage_log" ADD CONSTRAINT "credit_usage_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_usage_log_userId_createdAt_idx" ON "credit_usage_log" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed the MVP OpenAI provider. `__VAR__` placeholders are expanded by
-- scripts/db-migrate.ts (and tests/setup.ts) before the SQL is applied —
-- pure SQL can't read process.env, so base_url + the encrypted api_key
-- blob + the enabled-model entry are interpolated by the runner.
-- ON CONFLICT keeps the seed idempotent across re-runs.
INSERT INTO "provider" ("id", "name", "enabled", "base_url", "api_keys", "models", "created_at", "updated_at")
VALUES (
  'default',
  'Default Provider',
  true,
  '__OPENAI_BASE_URL__',
  '__OPENAI_API_KEY_ENCRYPTED__'::jsonb,
  '__OPENAI_MODEL_JSON__'::jsonb,
  now(),
  now()
)
ON CONFLICT ("id") DO NOTHING;