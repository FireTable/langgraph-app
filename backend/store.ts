import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

// Postgres store for cross-thread long-term memory. `setup()` is idempotent —
// the first call creates the store tables; subsequent calls are no-ops. Wire
// into the graph with `compile({ store })` and reach it inside nodes via
// `runtime.store`, scoped by namespace (typically `[userId, "memories"]`).
const databaseUrl = process.env.DATABASE_URL;
export const store = databaseUrl ? PostgresStore.fromConnString(databaseUrl) : undefined;

if (store) await store.setup();
