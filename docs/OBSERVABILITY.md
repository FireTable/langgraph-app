# Observability Panel (Design)

Real-time view of every LangGraph invoke inside a chat thread: LLM / Tool / Chain / Node spans, persisted to Postgres, surfaced through a right-edge Sheet anchored on each assistant message.

This file is the **design doc** — what it does, where the data lives, the security stance, retention, trade-offs. For HTTP endpoints (request / response / status codes / semantics) see [`docs/APIS.md`](./APIS.md) § Observability.

## Entry point

Each assistant message renders an icon-only `<ObservabilityButton>` inside its `<AssistantActionBar>`, sitting between `Refresh` and `More`. Click opens a right-edge Sheet (`w-[50vw] min-w-[40rem]`) named `<ObservabilitySheet>`.

- The Sheet is a **singleton** rendered once inside `<ThreadPrimitive.Root>` — adding more assistant messages does NOT add more dialog backdrops
- Per-message buttons reach the Sheet through `ObservabilitySheetProvider` / `useOpenObservabilitySheet()` from `components/observability/sheet-context.tsx`, so prop-drilling is avoided and only one `open` boolean exists thread-wide
- The Sheet derives its `threadId` via `useAuiState((s) => ... mainThreadId.externalId)` so it tracks whichever thread the user is on, and skips the dialog affordance entirely when the value is the `__LOCAL_*` placeholder

The Sheet header shows the `retention_days` config as a banner ("spans 保留 X 天, 超过 X 天的数据将在下次 retention 清理时删除"). The body is a waterfall: a Span column on the left, a 0ms → 1.3s axis on the right, kind tags (`llm / node / tool / chain`), and indented rows for parent/child relationships. Header strip shows totals — duration, tokens, LLM count.

## Data source

The callback handler (`backend/observability/callback-collector.ts`) is a `BaseCallbackHandler` wired into the model singletons in `backend/model.ts` via `ChatOpenAI.withConfig({ callbacks: [getCapturingHandler()] })`. During an invoke, the handler keeps a per-`runId` partial span in an in-process `Map`; End hooks fill `ended_at` / `output` / `usage` / `status`. On every `handleChainEnd` it fires `bulkInsert([span])` so rows land while chains are still running — mid-stream UI visibility matters more than a single flush at the end. Re-flushing the same spanId when the outermost chain closes is a no-op via `ON CONFLICT DO NOTHING` (idempotent).

### `CapturedSpan` fields (`backend/observability/callback-collector.ts`)

| Field            | Type                                                     | Notes                                                                                                                                        |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `span_id`        | string                                                   | LangChain `runId` (UUID); DB primary key                                                                                                     |
| `parent_span_id` | string \| null                                           | Derived from `langgraph_checkpoint_ns`. LC `parent_run_id` is unreliable under `USE_SUBGRAPH` (chains inside compiled subgraphs report root) |
| `name`           | string                                                   | Callback name (class tail or tool name)                                                                                                      |
| `kind`           | `"llm"\|"tool"\|"node"\|"chain"\|"retriever"\|"unknown"` | Set by the entry hook. `node` is necessary — LangGraph node-wrapper chains report it; collapsing into `chain` would conflate layers          |
| `status`         | `"running"\|"completed"\|"failed"`                       | State-machine triple                                                                                                                         |
| `started_at`     | number (ms epoch)                                        | `Date.now()` at start                                                                                                                        |
| `ended_at`       | number \| null                                           | `Date.now()` at end; null while `running`                                                                                                    |
| `input`          | unknown \| null                                          | LC envelope unwrapped (live `BaseMessage` / V1 / V2 / flat — see `unwrapMessage` / `deepUnwrapLC`)                                           |
| `output`         | unknown \| null                                          | Same as input                                                                                                                                |
| `usage`          | object \| null                                           | LLM tokens (`input_tokens` / `output_tokens` / `total_tokens`)                                                                               |
| `error`          | string \| null                                           | Error message                                                                                                                                |
| `meta`           | object                                                   | LC metadata passthrough + `langgraph_node` / `langgraph_step` / `langgraph_checkpoint_ns` / `time_to_first_token_ms` / `ls_model_name`       |

### DB table `observability_spans` (`db/migrations/0001_observability_spans.sql`)

| Column           | Type        | Constraint                                           |
| ---------------- | ----------- | ---------------------------------------------------- |
| `span_id`        | text        | PRIMARY KEY                                          |
| `thread_id`      | text        | NOT NULL, REFERENCES `threads(id)` ON DELETE CASCADE |
| `parent_span_id` | text        | NULL                                                 |
| `name`           | text        | NOT NULL                                             |
| `kind`           | text        | NOT NULL                                             |
| `status`         | text        | NOT NULL DEFAULT `'running'`                         |
| `started_at`     | bigint      | NOT NULL                                             |
| `ended_at`       | bigint      | NULL                                                 |
| `input`          | jsonb       | NULL                                                 |
| `output`         | jsonb       | NULL                                                 |
| `usage`          | jsonb       | NULL                                                 |
| `error`          | text        | NULL                                                 |
| `meta`           | jsonb       | NOT NULL DEFAULT `'{}'`                              |
| `created_at`     | timestamptz | NOT NULL DEFAULT `now()`                             |

Indexes:

- `(thread_id, started_at)` — GET primary path
- `(created_at)` — retention cron physical delete

`ON DELETE CASCADE` from `threads(id)`: removing a thread row clears its spans in one shot, no separate cleanup needed.

## Lifecycle invariants

- `bulkInsertSpans` uses `ON CONFLICT DO NOTHING`. Outer chain-end that re-flushes an inner span is a no-op — the second insert is intentional, not a duplicate. Idempotent.
- `markRunningAsFailed(thread_id)` runs as a GET preflight (in the route handler) and flips any still-`running` rows to `failed`. The client never sees stale "running" states left over from a crashed chain.
- `threadIdOf` reads `meta.langgraph_thread_id`. LangGraph populates this in the LC callback metadata automatically.

## Security stance

- **No secrets / internal addresses**: `bulkInsertSpans` runs the FORBIDDEN regex `/(?:api[_-]?key|_password|^password$|_secret$|^secret$|baseURL|organization|bearer\s+[a-z0-9])/i` against `JSON.stringify(span)`. Any key or value match **throws**. Spec FR-009, SC-003 verifies 0 hits. Fail-closed: any new provider kwarg containing a forbidden token halts the write until whitelisted.
- **Cross-user thread_id → 404**: the route handler is wrapped in `withAuth` (rule #9) and ownership-checked before reading spans. Cross-user access returns 404, not 401/403, so thread existence is not enumerable. Belt-and-braces: the Sheet itself refuses to open when `useAuiState` resolves to a `__LOCAL_*` placeholder.
- **DB write failures don't block `graph.invoke`**: `handleChainEnd` wraps `bulkInsert(...)` in `.catch(console.error)`. A blip becomes a missing row, not a runtime error — UI side surfaces the gap as "no spans recorded" while the chain continues normally.

## Retention

- **Window**: env `OBSERVABILITY_RETENTION_DAYS`. Must be a positive integer. Default 30.
- **Fallback**: missing / non-positive / non-integer env → default 30. Resolver lives in `lib/observability/config.ts: getRetentionDays()`.
- **Physical delete**: `pnpm exec tsx scripts/retention.ts` (uses `@next/env loadEnvConfig` per rule #3) reads the resolver, then runs `DELETE FROM observability_spans WHERE created_at < now() - INTERVAL 'X days'`. Scheduling is the operator's responsibility (MVP leaves it out — see trade-offs below).
- **UI surfacing**: GET response echoes `retention_days`. Sheet header banner shows the value plus the cleanup cadence note (see [§ Entry point](#entry-point)).

## Known trade-offs

- **No turn boundary (MVP+1)** — multiple user turns in one thread appear as a single flat span list in the Sheet. `meta.langgraph_path` carries `__start__` at the turn origin; future work can split on that without schema change.
- **bulkInsert on every chain end** — writes `N + 1` rows per invoke (innermost first, outermost last) and lets `ON CONFLICT` dedupe. Trade-off: streaming visibility vs. write amplification. Debounce (e.g. 500ms) is a future option if write rate becomes a concern.
- **`kind` includes `node`** — LangGraph's outer node-wrapper chain reports `kind: "node"`, distinct from the LangChain `"chain"` wrappers. Spec early version only listed `{llm, tool, chain, retriever, unknown}`; `node` cannot be dropped at write time or the waterfall mixes layers.
- **`parent_span_id` is reconstructed from ns, not LC** — LC's `parent_run_id` reports root inside subgraphs, so the handler derives parents from `langgraph_checkpoint_ns` and rewrites `parent_span_id` before bulkInsert. `snapshot()` (used by the legacy live preview path) does the same rewriting on read.
- **404 on cross-user thread access (not 401/403)** — deliberate, prevents enumeration. Implies ownership checks live at the route layer; the Sheet confirms by checking `useAuiState` threadId is real (not a `__LOCAL_*` placeholder) before mounting.
