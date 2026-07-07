import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

// Postgres store for cross-thread long-term memory. Wire into the graph with
// `compile({ store })` and reach it inside nodes via `runtime.store`, scoped
// by namespace (typically `[userId, "memories"]`).
//
// `setup()` is idempotent but not concurrency-safe — `CREATE TABLE IF NOT
// EXISTS` races on pg_type_typname_nsp_index when multiple workers first
// touch the DB at the same time (CI `next build` evaluates routes under N
// page-data workers). Coalesce via globalThis (same-process workers) AND
// swallow the duplicate-key error (cross-process workers); either path
// leaves the tables present.
const databaseUrl = process.env.DATABASE_URL;
export const store: PostgresStore | undefined = databaseUrl
  ? PostgresStore.fromConnString(databaseUrl)
  : undefined;

declare global {
  // eslint-disable-next-line no-var
  var __lgStoreSetupPromise: Promise<void> | undefined;
}

if (store && !globalThis.__lgStoreSetupPromise) {
  globalThis.__lgStoreSetupPromise = (async () => {
    try {
      await store.setup();
    } catch (err) {
      // Postgres 23505 = unique_violation. Another worker won the race.
      if ((err as { code?: string })?.code !== "23505") throw err;
    }
  })();
}
