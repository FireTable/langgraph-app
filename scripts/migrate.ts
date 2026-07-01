// ponytail: own migration runner — `drizzle-kit migrate` exits 1 with a
// stuck ora spinner in this repo's journal state. The canonical
// `drizzle-orm/postgres-js/migrator` API does the same job synchronously
// and exits cleanly. Run via `pnpm db:migrate`.
//
// `loadEnvConfig` must run BEFORE `@/db/client` is imported (the client
// throws at module load if DATABASE_URL is unset), so we dynamic-import
// the client after env is loaded.
import nextEnv from "@next/env";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const migrationsFolder = resolve(process.cwd(), "db", "migrations");

async function main() {
  // ponytail: dynamic import — db/client reads DATABASE_URL at module
  // load and throws if missing, so it has to come after loadEnvConfig.
  const { db } = await import("@/db/client");
  await migrate(db, { migrationsFolder });
  console.log(`[migrate] applied pending migrations from ${migrationsFolder}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  },
);
