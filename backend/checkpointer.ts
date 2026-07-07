import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// Postgres checkpointer for thread persistence. Pass `configurable.thread_id`
// when invoking the graph to persist and resume conversations.
//
// Tables are created by `pnpm db:migrate` (scripts/db-migrate.ts →
// `checkpointer.setup()`). Never call setup() here — see backend/store.ts
// for the same rationale.
const databaseUrl = process.env.DATABASE_URL;
export const checkpointer: PostgresSaver | undefined = databaseUrl
  ? PostgresSaver.fromConnString(databaseUrl)
  : undefined;

// ponytail: per-invocation is the right default for our chat graph —
// subAgents (weatherAgent / chatAgent / cryptoAgent / codeAgent) run
// once per parent invoke, interrupt + resume happens inside the parent
// invoke (ask_location picker), and the subgraph's state is discarded
// when the parent invoke ENDs. None of that needs per-thread
// persistence. Leave this empty so the spread below resolves to no
// keys — equivalent to `checkpointer: null`.
//
// Flip `checkpointer: true` ONLY when a subgraph is invoked across
// multiple parent invokes on the same thread and needs its own
// cross-invoke state (e.g. a "research assistant" subgraph that
// accumulates sources / notes over several turns). At that point:
//   - Schema upgrades must stay backwards-compatible with persisted
//     checkpoints, or the subgraph will load a stale state shape and
//     crash.
//   - Same-subgraph multi-call in one node conflicts on the checkpoint
//     namespace (docs "Multiple calls (same subgraph)" row), so call
//     sites that loop over the subgraph need per-call wrapping.
export const subgraphCheckpointerConfig = {
  // checkpointer: true
};
