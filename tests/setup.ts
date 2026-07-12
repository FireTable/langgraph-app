import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { loadEnvConfig } from "@next/env";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { KEK_LENGTH_BYTES } from "@/lib/auth/encryption";

// Use Next.js's own env loader. With NODE_ENV=test, .env.test / .env.test.local
// are read (and .env.local is intentionally skipped).
loadEnvConfig(process.cwd());

// Postgres error codes that mean "object already exists" — safe to
// ignore when re-running against a possibly-stale test DB.
const SWALLOW = new Set(["42P07", "42710", "42P06", "42701"]); // duplicate_table / duplicate_object / duplicate_schema / duplicate_column

async function applyContent(sql: postgres.Sql, content: string) {
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

// ponytail: tests/setup.ts mirrors scripts/db-migrate.ts for env-driven
// placeholders in migration SQL. Pure SQL can't read process.env, so the
// runner expands __VAR__ to env values (including AES-256-GCM encryption
// of OPENAI_API_KEY via the lib/provider/admin helpers) before applying.
async function interpolateEnv(content: string): Promise<string> {
  const { encryptApiKey } = await import("@/lib/provider/admin");

  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const providerId = process.env.OPENAI_SEED_PROVIDER_ID ?? "openai";

  const apiKeyJson = (() => {
    const plain = process.env.OPENAI_API_KEY;
    // ponytail: loadEnvConfig intentionally skips .env.local under
    // NODE_ENV=test, so LLM_KEY_ENCRYPTION_KEY isn't carried in. Treat
    // "no KEK" the same as "no key" — seed an empty api_keys array and
    // let the migration's `enabled=true, api_keys=[]` row be a harmless
    // stub rather than crashing the entire global setup.
    const kekHex = process.env.LLM_KEY_ENCRYPTION_KEY;
    const kekOk =
      !!kekHex && kekHex.length === KEK_LENGTH_BYTES * 2 && /^[0-9a-fA-F]+$/.test(kekHex);
    if (!plain || !kekOk) return "[]";
    const blob = encryptApiKey(plain);
    return JSON.stringify([blob]).replace(/'/g, "''");
  })();

  const modelJson = (() => {
    const name = process.env.OPENAI_MODEL;
    if (!name) return "[]";
    return JSON.stringify([{ name, enabled: true, inputPer1k: 0.25, outputPer1k: 1 }]).replace(
      /'/g,
      "''",
    );
  })();

  return content
    .replaceAll("__SEED_PROVIDER_ID__", providerId.replace(/'/g, "''"))
    .replaceAll("__OPENAI_BASE_URL__", baseUrl.replace(/'/g, "''"))
    .replaceAll("__OPENAI_API_KEY_ENCRYPTED__", apiKeyJson)
    .replaceAll("__OPENAI_MODEL_JSON__", modelJson)
    .replace(/__([A-Z][A-Z0-9_]+)__/g, (m, name) => {
      const v = process.env[name];
      if (v === undefined) return m;
      return v.replace(/'/g, "''");
    });
}

// Vitest globalSetup: runs once before all tests in a fresh process.
// Apply migrations to the test database before tests run.
//
// Uses the `postgres` npm package (matching scripts/db-migrate.ts) so CI
// runners without a `psql` binary still work.
export default async function setup() {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!testUrl) throw new Error("DATABASE_URL_TEST is required for vitest");

  // db/client.ts reads DATABASE_URL. Alias the test URL so application code
  // under test stays unchanged.
  process.env.DATABASE_URL = testUrl;

  // Ensure the target database exists. CI's POSTGRES_DB env creates the
  // default db on the service container; the explicit `-d langgraph_app_test`
  // db needs to be created on demand when the env didn't propagate (e.g.
  // local `act` runs).
  const dbName = new URL(testUrl).pathname.replace(/^\//, "");
  const serverUrl = testUrl.replace(/\/[^/?]+(\?.*)?$/, "/postgres$1");
  const bootstrap = postgres(serverUrl, { max: 1, onnotice: () => {} });
  try {
    await bootstrap.unsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`  → created database ${dbName}`);
  } catch (e) {
    // Already exists is fine; anything else rethrow so vitest surfaces it.
    const msg = (e as Error).message ?? "";
    if (!/already exists/i.test(msg)) throw e;
  } finally {
    await bootstrap.end({ timeout: 5 });
  }

  const sql = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    // Drizzle migrations — Better Auth schema + observability_spans.
    // Applied via the same path as `pnpm db:migrate`.
    const dir = join(process.cwd(), "db", "migrations");
    const sqlFiles = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const f of sqlFiles) {
      console.log(`  → ${f}`);
      const content = await interpolateEnv(readFileSync(join(dir, f), "utf-8"));
      await applyContent(sql, content);
    }

    // langgraph tables — Node-side memory store + checkpointer. Idempotent.
    // tests/setup.ts mirrors db-migrate.ts but is NOT identical: in prod
    // langgraph-api creates the checkpointer tables itself (PostgresSaver
    // would clash on column types — see scripts/db-migrate.ts header); in
    // tests there's no langgraph-api, so PostgresSaver.setup() has to
    // create the tables itself.
    console.log("  → PostgresStore.setup()");
    await PostgresStore.fromConnString(testUrl).setup();
    console.log("  → PostgresSaver.setup()");
    await PostgresSaver.fromConnString(testUrl).setup();
  } finally {
    await sql.end({ timeout: 5 });
  }
}
