/**
 * Consolidated DB migrations: Drizzle + langgraph PostgresStore + langgraph
 * PostgresSaver + langgraph-api 0.10.x workaround. Runs in order. Idempotent
 * — safe to re-run on every deploy.
 *
 * The Python langgraph-api runtime runs its own PostgresSaver migrations
 * (langgraph_runtime_postgres.database.migrate) at uvicorn startup. We don't
 * re-run those here — it's a separate process + the langgraph base image owns
 * the schema. This script handles the Node-side tables + the upstream-quirk
 * shim for migration 29.
 *
 * Usage:
 *   pnpm db:migrate
 *
 * Where it's invoked:
 *   - Local dev:    once after `pnpm db:reset` to bring the schema up.
 *   - CI:           before `pnpm build` (so `next build`'s page-data
 *                   collection finds tables), and before vitest (covered by
 *                   tests/setup.ts).
 *   - Deploy:       from scripts/start.sh automatically, every container
 *                   start. No manual step needed.
 *
 * Why a single command:
 *   - All migrations, one canonical sequence. No "did I run the workaround?"
 *     confusion.
 *   - Module-load setup() in the app races under `next build`'s parallel
 *     page-data workers — moving it to an explicit pre-step eliminates the
 *     race entirely.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

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

// langgraph-api 0.10.x hardcodes column `prefix` in migration 29's
// CREATE INDEX, but the actual PostgresStore schema (created in step 2
// below) uses `namespace_path`. Without this shim, the Python runtime
// crashes at uvicorn startup on first deploy against a fresh DB. Drop
// this step once a langgraph-api release patches migration 29.
function applyLanggraphApi029Workaround() {
  const cmds = [
    "ALTER TABLE store ADD COLUMN IF NOT EXISTS prefix text",
    "UPDATE store SET prefix = namespace_path WHERE prefix IS NULL",
    // CONCURRENTLY can't run inside a transaction; each -c is its own.
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx ON store USING btree (prefix text_pattern_ops)",
    "INSERT INTO store_migrations (v) VALUES (29) ON CONFLICT DO NOTHING",
  ];
  for (const cmd of cmds) {
    execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", cmd], {
      stdio: "inherit",
    });
  }
}

async function main() {
  // 1. Drizzle migrations — Better Auth schema + observability_spans.
  //    Apply via psql directly so we don't depend on drizzle-kit CLI
  //    behavior (same approach tests/setup.ts uses for the test DB).
  await step("drizzle migrations (db/migrations/*.sql)", () => {
    const dir = join(process.cwd(), "db", "migrations");
    const sqlFiles = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of sqlFiles) {
      process.stdout.write(`\n    ${f}`);
      execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=0", "-f", join(dir, f)], {
        stdio: "inherit",
      });
    }
  });

  // 2. langgraph PostgresStore (Node-side memory doc tables).
  await step("PostgresStore.setup()", async () => {
    await PostgresStore.fromConnString(databaseUrl).setup();
  });

  // 3. langgraph-api 0.10.x migration 29 workaround. Runs after step 2 so
  //    the `store` table exists; the index column + migration marker are
  //    idempotent so re-runs are safe.
  await step("langgraph-api 0.10.x migration 29 workaround", () => {
    applyLanggraphApi029Workaround();
  });

  // 4. langgraph PostgresSaver (Node-side checkpointer tables — distinct
  //    from the Python-side checkpointer langgraph-api auto-migrates at
  //    uvicorn startup; both share the same table names so this is
  //    effectively idempotent against the Python run).
  await step("PostgresSaver.setup()", async () => {
    await PostgresSaver.fromConnString(databaseUrl).setup();
  });

  console.log("\nAll migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
