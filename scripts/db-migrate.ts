/**
 * Consolidated DB migrations: Drizzle + langgraph PostgresStore +
 * langgraph PostgresSaver + langgraph-api 0.10.x migration 29 workaround.
 * Runs in order. Idempotent — safe to re-run on every deploy.
 *
 * Usage:
 *   pnpm db:migrate
 *
 * Where it's invoked:
 *   - Local dev:    once after `pnpm db:reset` to bring the schema up.
 *   - CI:           before `pnpm build` (so `next build`'s page-data
 *                   collection finds tables), and before vitest (covered by
 *                   tests/setup.ts).
 *   - Deploy:       once before `docker compose up -d`, and again after
 *                   every deploy that touches `db/migrations/`,
 *                   `backend/store.ts`, or `backend/checkpointer.ts`.
 *                   (For container-driven deploys, scripts/start.sh runs
 *                   this on every container start; see DEPLOY.md.)
 *
 * Why a single command:
 *   - Three migrations, one canonical sequence. No "did I run the store one
 *     after drizzle?" confusion.
 *   - Module-load setup() in the app races under `next build`'s parallel
 *     page-data workers — moving it to an explicit pre-step eliminates the
 *     race entirely.
 *
 * Why postgres-js and not the psql CLI: the prod image
 * (`langchain/langgraphjs-api:22`) ships without a postgres-client binary,
 * and adding one in the Dockerfile is pure waste — `postgres` is already a
 * direct dependency.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import postgres from "postgres";

// @next/env is CJS — default import keeps ESM happy.
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
// ponytail: narrowed once at module scope so the inner step() closures
// see `string`, not `string | undefined`.
const databaseUrl: string = rawDatabaseUrl;

function step(name: string, fn: () => Promise<void> | void) {
  return (async () => {
    process.stdout.write(`→ ${name} ... `);
    try {
      await fn();
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write("FAILED\n");
      throw err;
    }
  })();
}

// Postgres error codes that mean "object already exists" — safe to
// ignore on idempotent re-runs (start.sh calls this on every container
// start; tests/setup.ts re-runs against a possibly-stale DB).
const SWALLOW = new Set(["42P07", "42710", "42P06"]); // duplicate_table / duplicate_object / duplicate_schema

async function applyContent(sql: postgres.Sql, content: string) {
  // Drizzle SQL files are written with `--> statement-breakpoint`
  // between chunks; each chunk may itself contain multiple ;-separated
  // statements. Split on the marker so each piece gets its own error
  // scope — recovering from one "already exists" doesn't hide a real
  // syntax error in the next statement.
  for (const chunk of content.split(/--> statement-breakpoint/g)) {
    const text = chunk.trim();
    if (!text) continue;
    try {
      await sql.unsafe(text);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !SWALLOW.has(code)) throw e;
    }
  }
}

// langgraph-api 0.10.x hardcodes column `prefix` in migration 29's
// CREATE INDEX, but the actual PostgresStore schema (created by
// PostgresStore.setup() below) uses `namespace_path`. Without this shim,
// the Python runtime crashes at uvicorn startup on first deploy against
// a fresh DB. Drop this step + DELETE FROM store_migrations WHERE v = 29
// once a langgraph-api release patches migration 29.
const WORKAROUND_29 = [
  "ALTER TABLE store ADD COLUMN IF NOT EXISTS prefix text",
  "UPDATE store SET prefix = namespace_path WHERE prefix IS NULL",
  // CONCURRENTLY can't run inside a transaction; postgres-js sends each
  // statement in autocommit so this is fine.
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx ON store USING btree (prefix text_pattern_ops)",
  "INSERT INTO store_migrations (v) VALUES (29) ON CONFLICT DO NOTHING",
];

async function main() {
  // Single connection — sequential statements, no pool needed for migrations.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // 1. Drizzle migrations — Better Auth schema + observability_spans.
    //    postgres-js sends each chunk as a simple-query string;
    //    statements run sequentially in autocommit. ON_ERROR_STOP semantics
    //    is replaced by applyContent's per-chunk error filtering
    //    (already-existing-object errors are swallowed; everything else
    //    surfaces).
    await step("drizzle migrations (db/migrations/*.sql)", async () => {
      const dir = join(process.cwd(), "db", "migrations");
      const sqlFiles = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of sqlFiles) {
        const path = join(dir, f);
        process.stdout.write(`\n    ${f}`);
        const content = readFileSync(path, "utf-8");
        await applyContent(sql, content);
      }
    });

    // 2. langgraph PostgresStore (Node-side memory doc tables).
    await step("PostgresStore.setup()", async () => {
      await PostgresStore.fromConnString(databaseUrl).setup();
    });

    // 3. langgraph PostgresSaver (Node-side checkpointer tables) — Docker-only skip.
    //    langgraph-api 0.10.x's migration 5 declares an FK
    //    `checkpoints.thread_id REFERENCES thread(thread_id uuid)`, but
    //    PostgresSaver.setup() creates checkpoints.thread_id as TEXT → FK
    //    fails with DatatypeMismatch and the runtime crashes on first boot
    //    against a fresh DB. So when running inside a Docker container (where
    //    langgraph-api owns the schema), skip this step. Local Node dev
    //    (langgraphjs dev) uses InMemorySaver and never reads Postgres
    //    `checkpoints`; tests/setup.ts runs PostgresSaver.setup()
    //    independently because CI has no langgraph-api.
    if (nodeFs.existsSync("/.dockerenv")) {
      process.stdout.write(
        "→ PostgresSaver.setup() ... skipped (running in Docker; langgraph-api owns the schema)\n",
      );
    } else {
      await step("PostgresSaver.setup()", async () => {
        await PostgresSaver.fromConnString(databaseUrl).setup();
      });
    }

    // 4. langgraph-api 0.10.x migration 29 workaround. Runs after step 2
    //    so the `store` table exists; the index column + migration marker
    //    are idempotent so re-runs are safe.
    await step("langgraph-api 0.10.x migration 29 workaround", async () => {
      for (const stmt of WORKAROUND_29) {
        await sql.unsafe(stmt);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log("\nAll migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
