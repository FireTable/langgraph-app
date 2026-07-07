import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

// Postgres store for cross-thread long-term memory. Wire into the graph with
// `compile({ store })` and reach it inside nodes via `runtime.store`, scoped
// by namespace (typically `[userId, "memories"]`).
//
// Tables are created by `pnpm db:migrate` (scripts/db-migrate.ts →
// `store.setup()`). Never call setup() here — module-load side effects race
// under `next build`'s N parallel page-data workers and break CI.
const databaseUrl = process.env.DATABASE_URL;
export const store: PostgresStore | undefined = databaseUrl
  ? PostgresStore.fromConnString(databaseUrl)
  : undefined;
