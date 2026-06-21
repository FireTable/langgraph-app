import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// Postgres checkpointer for thread persistence. `setup()` is idempotent —
// the first call creates the checkpoints / checkpoint_blobs /
// checkpoint_writes tables; subsequent calls are no-ops. Pass
// `configurable.thread_id` when invoking the graph to persist and resume
// conversations.
const databaseUrl = process.env.DATABASE_URL;
export const checkpointer = databaseUrl ? PostgresSaver.fromConnString(databaseUrl) : undefined;

if (checkpointer) await checkpointer.setup();
