# Observability Panel (Design)

Real-time view of every LangGraph invoke inside a chat thread: LLM / Tool / Chain / Node spans, persisted to Postgres, surfaced through a right-edge Sheet anchored on each assistant message.

This file is the **design doc** — what it does, where the data lives, the security stance, retention, trade-offs. For HTTP endpoints (request / response / status codes / semantics) see [`docs/APIS.md`](./APIS.md) § Observability.

## Entry point

Each assistant message renders an icon-only `<ObservabilityButton>` inside its `<AssistantActionBar>`, sitting between `Refresh` and `More`. Click opens a right-edge Sheet (`w-[50vw] min-w-[40rem]`) named `<ObservabilitySheet>`.

- The Sheet is a **singleton** rendered once inside `<ThreadPrimitive.Root>` — adding more assistant messages does NOT add more dialog backdrops
- Per-message buttons reach the Sheet through `ObservabilitySheetProvider` / `useOpenObservabilitySheet()` from `components/observability/sheet-context.tsx`, so prop-drilling is avoided and only one `open` boolean exists thread-wide
- The Sheet derives its `threadId` via `useAuiState((s) => ... mainThreadId.externalId)` so it tracks whichever thread the user is on, and skips the dialog affordance entirely when the value is the `__LOCAL_*` placeholder
- The Sheet receives `threadId` as a prop (not derived from `useAuiState`) — `useAuiState` for `mainThreadId.externalId` can lag on first render after the thread is registered, while the sheet-context already has the active id from the button click. The panel uses the prop for `detail` fetch URLs
- The button passes `{ threadId, parentMessageId: message.parentId }` to the context. The Sheet fetches the per-turn filtered route (`/api/threads/<id>/observability/<parentMessageId>`) when `parentMessageId` is available, falling back to the unfiltered route for older messages without a captured id

### KB ingestion runs (Settings → KB)

KB standalone ingestions (`fireIngestionRun` from `/settings/knowledge-base` upload + `/api/kb/documents/[id]/reprocess`) also surface in the same panel. The wiring path differs from the chat thread entry:

- **`threadId` convention**: `docId.replace(/^d-/, "")` — strip the namespace prefix so the UUID portion satisfies LangGraph's `z.string().uuid()` validator and stays stable across reprocess. Every reprocess of the same doc lands on the same LangGraph thread; spans accumulate.
- **`parent_message_id` convention**: `fireIngestionRun` mints a fresh `messageId` per run and stamps it as `id` on the synthetic HumanMessage AND passes it to `langGraphClient.runs.create({ ... metadata: { parent_message_id: messageId } })` (top-level `metadata`, NOT `config.configurable` — see `lib/kb/ingest.ts` `fireIngestionRun`). LangGraph surfaces that on every LC callback's `metadata` for the run. `CapturingHandler.handleChainStart` reads `metadata.parent_message_id` first (per-run, immune to concurrent invokes) and falls back to `lastHumanMessageId(inputs.messages)` when the metadata key is absent (chat-path mainAgent invocations, which set pmid by other means). Every span in the run carries `meta.parent_message_id = messageId`, so the per-turn panel route (`/api/threads/<threadId>/observability/<messageId>`) returns only that run's spans.
- **Entry point on the UI**: each DocRow in `/settings/knowledge-base` has an `<Activity>` icon (between RefreshCw and Search). Click opens a Popover ("Observability List") listing kbAgent re-runs for the doc — fetched from `GET /api/kb/documents/[id]/observability`, which reads the `kb_observability` table (no SDK call) and reshapes to `[{runId, threadId, parentMessageId, source, mode, createdAt}]` (newest first, limit 50). Initial `full`-mode uploads are NOT in the popover — the `kb_documents` row is the event for those; the popover shows chunksOnly / retryFailed / retryFailedChunks re-runs only. Each row is a button that calls `openSheet({ threadId: run.threadId, parentMessageId: run.parentMessageId })` against the same singleton `<ObservabilitySheet>` used by chat messages.
- **Settings page wiring**: `KbView` (`components/settings/kb-view/kb-view.tsx`) wraps its content in `<ObservabilitySheetProvider>` + `<ObservabilitySheet />`, mirroring the chat thread tree. Without this provider, `useOpenObservabilitySheet()` throws "outside ObservabilitySheetProvider" on the KB page.
- **Thread visibility in chat sidebar**: `threads.kind` (`'chat' | 'kb'`) is filtered at `lib/threads/queries.ts:listThreadsForUser` — `WHERE kind='chat'` keeps KB threads out of the user's chat sidebar. The settings page is the only UI entry into KB observability.

### Where `capturingHandler` is wired

The handler is a process-global singleton (`backend/callbacks.ts`). It must be attached to every compiled graph that should produce spans:

- `backend/agent.ts` (`mainAgent`): wired via `.withConfig({ callbacks: [capturingHandler, ...] })` — also covers chat-path kbAgent subgraph (LC's callback propagation passes parent handlers to subgraph runs).
- `backend/background-agent.ts`: wired the same way.
- `backend/agent/kb-agent.ts` (standalone compile): wired via `.withConfig({ callbacks: [capturingHandler, ...] })` — needed for `fireIngestionRun` which dispatches the kbAgent graph directly over HTTP to the LangGraph dev server (no parent to inherit handlers from). The Postgres `threads` row is created lazily inside `kbAgent.prepareKBDataNode` so `observability_spans.thread_id` FK is satisfied.

The Sheet header shows the `retention_days` config as a banner ("spans 保留 X 天, 超过 X 天的数据将在下次 retention 清理时删除"). The body is a waterfall: a Span column on the left, a 0ms → Nms axis on the right, kind tags (`llm / node / tool / chain / human`), and indented rows for parent/child relationships. Header strip shows totals — duration, tokens, LLM count.

### Wire shape (server-side transformed)

The list payload is intentionally lean: `transformCapturedToSpanData()` runs in the route handler (`lib/observability/transform.ts`) so the panel never carries the raw collector payload (`input / output / usage / meta / error` are stripped). The 8-tile stat-card row is pre-computed by `aggregateRoot()` (`lib/observability/aggregate.ts`) against the same raw spans — the client does no per-render derivation. Per-row click lazy-loads the raw `CapturedSpan` via `GET /spans/[spanId]` so a thread with 100 spans only ships the bytes the waterfall UI actually consumes.

`parentMessageId` is stamped onto every SpanData (root chain + step wrapper + leaf), so the panel reads it from the clicked row to build the per-turn detail URL — no tree walk needed.

### LLM leaf display

LLM-kind leaves render with `meta.ls_model_name` as the row name (`gpt-4o-mini` reads better than the LangChain class name `ChatOpenAI`). Falls back to `span.name` when the provider didn't stamp the model name.

## Data source

The callback handler (`backend/observability/callback-collector.ts`) is a `BaseCallbackHandler` wired into the compiled graph in `backend/agent.ts` via `compile({ checkpointer }).withConfig({ callbacks: [capturingHandler] })`. Attaching at the compile layer (rather than on individual model instances) ensures ToolNode callbacks are also captured — model-level `.withConfig` misses tool spans.

During an invoke, the handler keeps a per-`runId` partial span in an in-process `Map`; End hooks fill `ended_at` / `output` / `usage` / `status`. On every End hook it fires `bulkInsertSpans([span])` so rows land while chains are still running — mid-stream UI visibility matters more than a single flush at the end. Re-flushing the same spanId when the outermost chain closes is a no-op via `ON CONFLICT DO NOTHING` (idempotent).

### `CapturedSpan` fields (`backend/observability/callback-collector.ts`)

| Field            | Type                                                              | Notes                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `span_id`        | string                                                            | LangChain `runId` (UUID); DB primary key                                                                                                                                      |
| `parent_span_id` | string \| null                                                    | Derived from `langgraph_checkpoint_ns`. LC `parent_run_id` is unreliable under compiled subgraphs (chains inside them report the root as parent)                              |
| `name`           | string                                                            | Callback name (class tail or tool name)                                                                                                                                       |
| `kind`           | `"llm"\|"tool"\|"node"\|"chain"\|"retriever"\|"human"\|"unknown"` | Set by the entry hook. `node` — LangGraph node-wrapper chains. `human` — synthetic interrupt-wait gap span (no LC callback origin)                                            |
| `status`         | `"running"\|"completed"\|"failed"\|"waiting"`                     | `waiting` is set on a `human` span while the graph is paused at a `GraphInterrupt`; flipped to `completed` by `backfillWaitingInterruptSpans` when the next tool span arrives |
| `started_at`     | number (ms epoch)                                                 | `Date.now()` at start                                                                                                                                                         |
| `ended_at`       | number \| null                                                    | `Date.now()` at end; null while `running` / `waiting`                                                                                                                         |
| `input`          | unknown \| null                                                   | LC envelope unwrapped (live `BaseMessage` / V1 / V2 / flat — see `unwrapMessage` / `deepUnwrapLC`)                                                                            |
| `output`         | unknown \| null                                                   | Same as input                                                                                                                                                                 |
| `usage`          | object \| null                                                    | LLM tokens (`input_tokens` / `output_tokens` / `total_tokens`)                                                                                                                |
| `error`          | string \| null                                                    | Error message                                                                                                                                                                 |
| `meta`           | object                                                            | LC metadata passthrough + `langgraph_node` / `langgraph_step` / `langgraph_checkpoint_ns` / `time_to_first_token_ms` / `ls_model_name` / `parent_message_id`                  |

### DB table `observability_spans` (`db/migrations/0001_observability_spans.sql`)

| Column              | Type        | Constraint                                                                      |
| ------------------- | ----------- | ------------------------------------------------------------------------------- |
| `span_id`           | text        | PRIMARY KEY                                                                     |
| `thread_id`         | text        | NOT NULL, REFERENCES `threads(id)` ON DELETE CASCADE                            |
| `parent_span_id`    | text        | NULL                                                                            |
| `name`              | text        | NOT NULL                                                                        |
| `kind`              | text        | NOT NULL (`llm\|tool\|node\|chain\|retriever\|human\|unknown`)                  |
| `status`            | text        | NOT NULL DEFAULT `'running'` (`running\|completed\|failed\|waiting`)            |
| `started_at`        | bigint      | NOT NULL                                                                        |
| `ended_at`          | bigint      | NULL                                                                            |
| `input`             | jsonb       | NULL                                                                            |
| `output`            | jsonb       | NULL                                                                            |
| `usage`             | jsonb       | NULL                                                                            |
| `error`             | text        | NULL                                                                            |
| `meta`              | jsonb       | NOT NULL DEFAULT `'{}'`                                                         |
| `parent_message_id` | text        | NULL; denormalized from `meta.parent_message_id` for indexed per-turn filtering |
| `created_at`        | timestamptz | NOT NULL DEFAULT `now()`                                                        |

Indexes:

- `(thread_id, started_at)` — unfiltered GET primary path
- `(thread_id, parent_message_id, started_at)` — per-turn GET (`/observability/[parentMessageId]`)
- `(created_at)` — retention cron physical delete

`ON DELETE CASCADE` from `threads(id)`: removing a thread row clears its spans in one shot, no separate cleanup needed.

## Lifecycle invariants

- `bulkInsertSpans` uses `ON CONFLICT DO NOTHING`. Outer chain-end that re-flushes an inner span is a no-op — the second insert is intentional, not a duplicate. Idempotent.
- `markRunningAsFailed(thread_id)` runs as a GET preflight (in the route handler) and flips any still-`running` rows to `failed`. The client never sees stale "running" states left over from a crashed chain.
- `backfillWaitingInterruptSpans` runs inside `bulkInsertSpans` before INSERT. When a tool span arrives for a thread, it closes any `waiting` human span on that thread (sets `status=completed`, `ended_at=tool.started_at`) — recovers from `langgraphjs dev` process restarts that clear in-memory state.
- `threadIdOf` reads `meta.thread_id ?? meta.langgraph_thread_id`. LangGraph populates this in the LC callback metadata automatically; older LC versions used the prefixed key, both are accepted.

## HTTP endpoints (summary)

Full request/response/status-code semantics are in [`docs/APIS.md`](./APIS.md) § Observability.

| Method   | Path                                                               | Purpose                                                                                    |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET`    | `/api/threads/[id]/observability`                                  | All spans for the thread (all turns merged). Server-transformed `SpanData[]` + `aggregate` |
| `GET`    | `/api/threads/[id]/observability/[parentMessageId]`                | Spans for a single turn (filtered by `parent_message_id` column). Same wire shape, scoped  |
| `GET`    | `/api/threads/[id]/observability/[parentMessageId]/spans/[spanId]` | Single span's full `CapturedSpan` (input/output/usage/meta). Lazy-loaded on row click      |
| `DELETE` | `/api/threads/[id]/observability`                                  | Clear all spans for the thread                                                             |

### curl examples

```bash
# Fetch all spans for a thread (all turns merged)
curl -s -b cookies.txt \
  http://localhost:3000/api/threads/THREAD_ID/observability \
  | jq '.spans | length'

# Fetch spans for a single assistant turn
curl -s -b cookies.txt \
  "http://localhost:3000/api/threads/THREAD_ID/observability/PARENT_MSG_ID" \
  | jq '[.spans[] | {name, kind, status, duration: (.ended_at - .started_at)}]'

# Fetch a single span's full payload (input / output / usage / meta)
curl -s -b cookies.txt \
  "http://localhost:3000/api/threads/THREAD_ID/observability/PARENT_MSG_ID/spans/SPAN_ID" \
  | jq '.span | {name, kind, usage, meta}'

# Delete all spans for a thread
curl -s -b cookies.txt -X DELETE \
  http://localhost:3000/api/threads/THREAD_ID/observability
```

> `cookies.txt` is a Netscape-format cookie jar written by `curl -c cookies.txt` during a prior login POST to `/api/auth/callback/credentials`.

## Security stance

- **No secrets / internal addresses**: `bulkInsertSpans` runs the FORBIDDEN regex `/(?:api[_-]?key|_password|^password$|_secret$|^secret$|bearer\s+[a-z0-9])/i` against `JSON.stringify(span)`. A match triggers **redaction** — the first 5 chars of the matched value are preserved and the remainder replaced with `***`. Hard-throwing is intentionally avoided to prevent false-positive drops on innocent user prose (e.g. "what is my api key?"). A `console.warn` is emitted for every redacted span so server logs remain auditable. SC-003 verifies 0 raw secret characters in the DB.
- **Cross-user thread_id → 404**: the route handler is wrapped in `withAuth` (rule #9) and ownership-checked before reading spans. Cross-user access returns 404, not 401/403, so thread existence is not enumerable. Belt-and-braces: the Sheet itself refuses to open when `useAuiState` resolves to a `__LOCAL_*` placeholder.
- **DB write failures don't block `graph.invoke`**: `handleChainEnd` wraps `bulkInsertSpans(...)` in `.catch(console.error)`. A blip becomes a missing row, not a runtime error — UI side surfaces the gap as "no spans recorded" while the chain continues normally.

## Retention

- **Window**: env `OBSERVABILITY_RETENTION_DAYS`. Must be a positive integer. Default 30.
- **Fallback**: missing / non-positive / non-integer env → default 30. Resolver lives in `lib/observability/config.ts: getRetentionDays()`.
- **Physical delete**: `pnpm exec tsx scripts/cleanup-observability.ts` (uses `@next/env loadEnvConfig` per rule #3) reads the resolver, then runs `DELETE FROM observability_spans WHERE created_at < now() - INTERVAL 'X days'`. Scheduling is the operator's responsibility (MVP leaves it out — see trade-offs below).
- **UI surfacing**: GET response echoes `retention_days`. Sheet header banner shows the value plus the cleanup cadence note (see [§ Entry point](#entry-point)).

## Known trade-offs

- **No turn boundary in panel UI (MVP+1, partially addressed)** — the unfiltered `/observability` route merges all turns. The per-turn `/observability/[parentMessageId]` route filters spans by `parent_message_id`; the Sheet uses this route when the button carries a valid `parentMessageId`. Full multi-turn split in the panel UI (e.g. collapsible turn groups) remains MVP+1.
- **List payload omits raw collector fields** — `transformCapturedToSpanData` strips `input / output / usage / meta / error` to keep wire bytes low. Per-row click lazy-loads those fields via `/spans/[spanId]`. Trade-off: an extra round trip per click vs. shipping the full collector payload on every list fetch.
- **bulkInsert on every End hook** — writes `N + 1` rows per invoke (innermost first, outermost last) and lets `ON CONFLICT` dedupe. Trade-off: streaming visibility vs. write amplification. Debounce (e.g. 500ms) is a future option if write rate becomes a concern.
- **`kind` includes `node` and `human`** — `node`: LangGraph's outer node-wrapper chain, distinct from LC `"chain"` wrappers. `human`: synthetic interrupt-wait gap; the transform layer maps `waiting` → `running` for the panel (which has no waiting state), while the DB keeps the precise value.
- **`parent_span_id` is reconstructed from ns, not LC** — LC's `parent_run_id` reports root inside subgraphs, so the handler derives parents from `langgraph_checkpoint_ns` and rewrites `parent_span_id` before bulkInsert.
- **Root chains are deduplicated by `meta.run_id`, not by `parent_span_id`** — under `streamSubgraphs: true` the LC inner `CompiledStateGraph` wrapper shares the outer wrapper's `meta.run_id` and `span_id === meta.run_id`, so `collectRootChains` keys by `run_id` to drop the duplicate. Two main invokes (regenerate + follow-up) emit two roots because their `run_id`s differ.
- **`parent_message_id` resolution is per-call, not shared state** — concurrent invokes (e.g. two parallel kb uploads on different threads) previously clobbered each other via a process-wide `currentParentMessageId` instance field; the handler now resolves pmid inside `handleChainStart` from `metadata.parent_message_id` (LangGraph-configurable passthrough, set per-run via `runs.create`) with `lastHumanMessageId(inputs.messages)` as the fallback. `findLatestParentMessageId` (used by `bulkInsertSpans` backfill) calls `langGraphClient.threads.getState(threadId)` and parses `state.values.messages` via `lastHumanMessageId` — the column is **not** read for backfill. Pre-backfill or partially captured rows keep `parent_message_id IS NULL` and intentionally 404 on the per-turn detail endpoint (the wire's SpanData omits `parentMessageId` and the panel surfaces a "missing parent_message_id" error rather than sending a loose query).
- **Redact instead of throw on forbidden fields** — avoids false-positive drops when user messages contain innocuous phrases like "api key". Auditable via `console.warn`. If zero-tolerance is required, change `redactForbidden` to throw.
- **404 on cross-user thread access (not 401/403)** — deliberate, prevents enumeration. Implies ownership checks live at the route layer; the Sheet confirms by checking `useAuiState` threadId is real (not a `__LOCAL_*` placeholder) before mounting.
