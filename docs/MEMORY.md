# Memory & Thread Summarize

How the assistant remembers the user across conversations, and how long
threads stay readable when the chat itself outgrows the context window.
The runtime wiring lives under `backend/memory/` + `backend/node/`; the
storage + schema under `lib/memory/`; the user-facing surface under
`components/settings/memory-view.tsx` and the Memory tab card. HTTP
endpoints (request / response / status codes) live in
[`docs/APIS.md`](./APIS.md) § Memory.

## Topology at a glance

The agent runtime runs **two graphs** side by side, both registered in
`langgraph.json`:

- `agent` (`backend/agent.ts:graph`) — the user-facing chat graph.
  Router picks a sub-agent (`weatherAgent` / `chatAgent` / `cryptoAgent` /
  `codeAgent`); `renameThreadAgent` runs once off `START` to set the
  thread title on the first turn. Each sub-agent node ends in
  `triggerBackgroundAgent`, which HTTP-dispatches the background graph
  via `langGraphClient.runs.create(...)` and returns immediately — the
  chat stream doesn't wait for background work.
- `background_agent` (`backend/background-agent.ts:graph`) — the
  turn-end side-effect graph. Linear: `START → touchLastMessage →
summarize → END`. Runs after every chat turn. Cheap to add a router
  between the two nodes later if `summarize` becomes a bottleneck.

Memory is split across these two graphs in the same way: profile reads
happen on the chat path (recall middleware prepends `<memory>` + `<threads>`
blocks to the SystemMessage); thread-compression writes happen on the
background path (`summarize` node persists a `SummaryEntry` to the
store, returns empty state).

```
                         mainAgent (backend/agent.ts)
                         ────────────────────────────
START ─▶ routerAgent ─▶ subAgent ─▶ triggerBackgroundAgent ─▶ END
  │
  └────────▶ renameThreadAgent (first-turn only; END on subsequent turns)

                         backgroundAgent (backend/background-agent.ts)
                         ─────────────────────────────────────────────
START ─▶ touchLastMessage ─▶ summarize ─▶ END
                                  │
                                  └─ persist SummaryEntry to store
```

## What the assistant sees on every turn

Every sub-agent's model node (`backend/agent/{chat,weather,crypto,code}-agent.ts`)
runs the same three-call sequence before binding messages to the model:

```ts
const threads = await loadThreadSummariesForPrompt(config);
const history = trimMessagesForInvoke(messages, threads?.summaries ?? []);
const sysMsg = await buildSystemMessageWithMemory(BASE_PROMPT, config, threads);
```

`buildSystemMessageWithMemory` (entry point in `backend/memory/template.ts`)
does the heavy lifting. It:

1. Reads `userId` from `config.configurable.userId` (set by
   `app/api/[..._path]/route.ts` from the cookie session).
2. Hits `getCachedMemory(userId)` (`backend/memory/recall.ts`) —
   LRU-cached, max 1000 entries, 60s TTL, keyed by `userId`.
3. Loads the user's profile doc (`[userId, "memory"] main`) and the
   auth record (name / email / avatar / socials from drizzle `user` +
   `account` tables), merges them via `mergeMemory`, and renders the
   SystemMessage through the `MEMORY_AUGMENTED_PROMPT_TEMPLATE`
   mustache template.

`MEMORY_AUGMENTED_PROMPT_TEMPLATE` (defined in `backend/prompt/system.ts`)
carries two conditional blocks:

```
{{base}}

{{#memoryJson}}<memory>
{ ... merged user profile ... }
</memory>{{/memoryJson}}

{{#threadsJson}}<earlier_conversation>
{ ... compressed Q&A history for the current thread ... }
</earlier_conversation>{{/threadsJson}}
```

Both blocks are gated on truthy mustache variables — a user with no
profile and no summaries sees just `{{base}}`, no empty scaffolding.

### The `<memory>` block — what lands in it

The merged view from `mergeMemory(doc, auth)` (`lib/memory/merge.ts`):

- User-saved doc wins. Keys written via `save_memory` always appear
  in the merged view (regardless of whether the auth overlay has a value
  for them).
- Auth overlay fills the gaps. For each `AUTH_OVERLAY_KEYS` entry
  (`name`, `email`, `avatar`, `socials`), if the user-saved doc doesn't
  have that key AND the auth value isn't `null`/`undefined`/`[]`, the
  auth value fills the slot.
- `socials` is the list of OAuth providers linked to the user
  (GitHub, Google, etc.). The `"credential"` provider (email+password)
  is filtered out — showing it as a "linked account" would be
  misleading.

`getStoreKeys(doc)` returns the set of keys present in the store doc;
the Memory tab UI uses this exact set to classify each merged field as
"summarized by AI" (key present in store) vs "from account" (key only
filled by auth overlay). The model's system prompt carries both blocks
under the same merged shape.

### The `<threads>` block — what lands in it

Comes from `loadThreadSummariesForPrompt(config)`. Pulls every
`SummaryEntry` for `(userId, threadId)` from the store, sorts by
`sequence` ASC (oldest pass first), and formats each pass's
`summary.entries` through `formatSummaryText`. Empty when the thread
has no summaries yet → the mustache gate collapses the whole block.

Format mirrors the Memory tab UI exactly — the LLM sees the same
Q&A text the user sees. Joining per-pass output with `\n\n` so the
model can spot the boundary between consecutive summary passes.

## Profile writes — `save_memory`

The model calls `save_memory` when the user says something durable
about themselves. Implementation: `backend/tool/memory/save-memory-tool.ts`,
wired into every sub-agent's tool list (`backend/tool/index.ts`).

### Input shape

```ts
{
  patches: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
}
```

`path` is RFC 6901 — a single object key, no array indices, no nested
traversal. Regex: `^\/[A-Za-z_][A-Za-z0-9_-]*$`. Patches operate on
the **merged view** (store + auth overlay), not just the store, so
`replace /name "X"` succeeds when the model is reacting to a name
field that came from OAuth.

### Write path

1. `getMemoryDoc(userId)` + `getAuthInfo(userId)` in parallel.
2. `mergeMemory` to get the effective view.
3. Validate: `replace` / `remove` ops on a path not in the effective
   view throw `MemoryPatchError` (`code: "PATCH_FAILED"`). A silent
   no-op on a non-existent path is the failure mode this guard exists
   to avoid.
4. `immutableJSONPatch(effective, patches)` — pure-function patch
   application, no store round-trip.
5. `filterToStoreOnly(next, storeDoc, patches)` strips auth-only
   fields that no patch touched. Without this, every save would copy
   the OAuth email/name into the store, bloating the doc and
   breaking the "summarized vs from account" classification.
6. `assertProfileSize(nextStore, MEMORY_PROFILE_MAX_BYTES)` —
   NFR-003 fail-fast size guard, throws `MemorySizeError` with
   `attemptedBytes` + `maxBytes` so the model can retry with a
   smaller patch.
7. `putMemoryDoc(userId, nextStore)` — single store write.
8. `invalidateMemory(userId)` — drop the LRU cache entry so the
   very next model invoke sees the patched profile.

### Output shape (returned to the model)

```ts
{
  ok: true,
  bytes: number,         // JSON.stringify(nextStore).length
  keyCount: number,      // Object.keys(nextStore).length
  before: MemoryDoc,     // pre-patch merged view (the model decides "before" values)
  after: MemoryDoc,      // post-patch merged view
  patches: Array<
    | { op: "add"; path: string; value: unknown }
    | { op: "replace"; path: string; oldValue: unknown; value: unknown }
    | { op: "remove"; path: string; oldValue: unknown }
  >,
}
```

The frontend's `SaveMemoryCard` reads this payload from the matching
`ToolMessage` and renders a before/after diff. The `patches` array
re-walks the input so each entry's `oldValue` is the value that was
actually there _just before that patch ran_ — a `remove /city` after
a `replace /city` reports the replaced value, not the original.

### Fail-closed errors

| Error class          | `code`            | When                                                    |
| -------------------- | ----------------- | ------------------------------------------------------- |
| `MissingUserIdError` | `MISSING_USER_ID` | `config.configurable.userId` missing or empty           |
| `MemoryPatchError`   | `PATCH_FAILED`    | `replace` / `remove` on a path not in merged view       |
| `MemorySizeError`    | (no code)         | Patch result > `MEMORY_PROFILE_MAX_BYTES` (default 8KB) |

## Profile reads — recall middleware

`backend/memory/recall.ts` owns the cache:

```ts
const memoryCache = new LRUCache<string, LoadedMemory>({
  max: 1000,
  ttl: 60_000,
  updateAgeOnGet: true,
});
```

- Key: `userId`. Value: `{ memory: mergeMemory(doc, auth) }`.
- Max 1000 entries × ~10–50 KB per payload = single-digit MB. Way
  more than concurrent users in dev; trim if memory becomes a concern.
- 60s TTL is a belt-and-suspenders against missed `invalidate()`
  calls — `save_memory` clears the cache on write, so this is mostly
  theoretical.
- `updateAgeOnGet: true` — repeated reads inside the TTL window
  don't age out the entry.

`getCachedMemory` swallows per-fetch failures (`getMemoryDoc` / `getAuthInfo`
both `.catch(() => EMPTY_AUTH)` in `lib/memory/queries.ts`) so a store
flap doesn't 500 the chat.

### What `configurable.userId` is

Set by `app/api/[..._path]/route.ts` from the cookie session — same
field every LangGraph node reads. The `extractUserId` /
`extractThreadId` helpers in `backend/memory/recall.ts` parse it out
defensively (typed `unknown` check + non-empty string assertion).

Without a `userId` (unauthed dev path), every call returns the base
prompt verbatim — no `<memory>` block, no `<threads>` block. The chat
still works, just with no continuity.

## Thread summaries — compression

When a thread outgrows the model's recent-message window, the older
turns need to be replaced with a structured recap the model can read
on every invoke. That's the thread-summarize path.

### Where it runs

`threadSummarizeNode` (`backend/node/thread-summarize-node.ts`) is
the `summarize` node on the background graph
(`backend/background-agent.ts`). Runs after every chat turn, but is a
**side-effect-only node**: writes the `SummaryEntry` to the store and
returns `{ messages: [] }`. `state.messages` is NEVER touched —
removing original turns would erase user-visible history ("where did
my messages go?") and injecting a synthetic HumanMessage would render
in the chat as a phantom user turn ("I didn't say that"). The summary
lives in the store AND in the chat agent's `<threads>` system block at
invoke time (see `backend/memory/template.ts`); the model reads it as
compressed history, the Memory tab displays it, but `state.messages`
stays the original turns.

### Trigger rule — store-anchored

Pure-formula triggers (`(humanCount - 1) % K === 0`) can't survive
deletion or replay: rolling the chat back / emptying the Memory tab /
replaying old turns would re-fire on the same window. The actual
trigger reads back from the store:

```ts
const lastEnd = await lastCompressedEndIdx(userId, threadId); // max(endMessageIndex) across this thread's entries
const window = computeCumulativeWindow(humanCount, KEEP_RECENT, lastEnd);
```

`computeCumulativeWindow(humanCount, keepRecent, lastCompressedEndIdx)`:

- **Window length = largest K-multiple ≤ uncompressedCount** (round-down).
  Examples with K=3: uncompressedCount=4 → window [0..2] (3 humans);
  uncompressedCount=7 → window [0..5] (6 humans); uncompressedCount=10
  → window [0..8] (9 humans).
- Round-down is intentional: a single LLM call covers up to K humans
  of transcript anyway, and the cost scales with input size, not
  call count. Each store write is the maximum summarizable window
  that fits in one prompt — fewer total passes than fixed-K (which
  would write [0..2], then [0..5] on round 9 with no progress until
  `lastEnd` moves).
- **Gate**: `uncompressedCount < K` → `null`. Below K the next turn
  accumulates.
- **Heals deletion**: when the user empties the Memory tab,
  `lastEnd` drops back to -1 and the next trigger re-writes the
  earliest missing chunk. No "holes" in coverage. Multiple triggers
  stack if the user keeps deleting.

Patterns with K=3:

- Fresh: round 3 → [0..2], quiet until round 6 → [3..5], round 9 →
  [6..8], ... (3, 6, 9, 12, ... = every K after K).
- Deletion: user empties Memory tab → `lastEnd=-1`, next trigger
  re-writes [0..2], then continues with [3..5], [6..8].

K is `MEMORY_THREAD_SUMMARY_KEEP_RECENT` (default 10; see
[§ Configuration](#configuration)).

### Compression pipeline

Inside `threadSummarizeNode`, after the trigger fires:

1. **Build excerpt** from `[humanIndices[startIdx]..nextHumanPos]`,
   inclusive of every interleaved AI/tool reply. Extend past the last
   human to the next human (or `messages.length`) so the trailing
   user question captures its assistant reply. Slicing on
   `humanIndices[endIdx]` alone stops at the user message itself —
   the AI/tool messages immediately following would be dropped,
   leaving the last JSONL entry as a Q with no A.
2. **Filter** to `KEEPABLE_TYPES = { human, ai, assistant, tool,
function }`. Unknown / orphan roles are dropped from the
   LLM-facing transcript (the original messages still live in
   `state.messages` for the chat UI).
3. **Render transcript** as JSONL — one line per human turn in the
   thread, 1-indexed globally (e.g. `{"id":"#3","messages":[...]}`).
   Tool calls are a first-class field on each message. Structured
   input ↔ structured output eliminates the prose↔JSON translation
   step on the model side; the prior markdown `#N\nUser: ...\n
Assistant: ...` format caused the LLM to drop trailing tool_call
   lines and produce meta-question paraphrases.
4. **LLM call** via `chatModel.withStructuredOutput(summaryOutputSchema,
{ method: "jsonSchema" })` under the `nostream` tag (so partial
   tokens don't leak into the chat stream). Failures are swallowed
   with `console.warn` — bg agent; a failed pass means one missed
   trigger point, and the next turn re-fires the same window.
5. **Validate**: empty `entries` (LLM skipped everything) → no
   `SummaryEntry` written.
6. **Sequence assignment**: read the latest sequence for this thread
   and write `latestSeq + 1`.
7. **Persist** via `writeSummary(userId, { threadId, sequence,
startMessageIndex, endMessageIndex, messageCount, messageIds,
summary, triggerReason: "turn_based", tokenCountBefore,
tokenCountAfter, createdAt })`.

### Triggering summary reads — `trimMessagesForInvoke`

After `<threads>` injects compressed history into the system prompt,
the model still has the original `messages` array passed to
`invoke()`. Cutting the older turns out is a token-cost move (not a
context-loss one) — `state.messages` is NEVER touched, so UI +
checkpointer read the original turns directly.

`trimMessagesForInvoke(messages, summaries)` (`backend/memory/template.ts`):

1. Strip stray `SystemMessage` instances — the bindTools runner
   leaks them across invokes.
2. Compute `maxEnd` across the summaries' `endMessageIndex`.
3. Find the index of the next human turn past `maxEnd`; slice
   from there.
4. No summaries OR no human turns → return the de-systemed
   messages untouched.

### LLM-facing shape

The `summary` field on a `SummaryEntry` is the **structured LLM
output** (`summaryOutputSchema`), stored verbatim:

```ts
{
  entries: Array<{ question: string; answer: string; refs: string[] }>;
}
```

Display sites (the `<threads>` system block in the chat prompt, the
Memory tab UI) call `formatSummaryText(s.summary.entries)` to render
the entries as text. The structured shape is preserved on disk so
later passes can compare / merge / dedupe across re-runs.

`refs: ["#3", "#4"]` are the global `#N` labels from the input
transcript — they map 1:1 back to `BaseMessage.id` values via the
program-side `messageIds` field. The LLM never sees the original
message ids, only the human-index labels; the node resolves them.

## Memory tab — UI surface

`components/settings/memory-view.tsx` is the user-facing Memory tab
in the settings surface. Fetches `/api/memory/profile` on mount,
groups summaries by `threadId` via `groupThreadsByThreadId`, and
renders the two sections side by side.

### Section 1 — About you

Rows are flat key → value pairs from the merged memory doc. Two
visual classes:

- **"Summarized by AI"** (Bot icon) — keys present in the store doc
  (`save_memory` wrote them, or they predate the auth overlay).
- **"From account"** (User icon) — keys only present in the auth
  overlay (name / email / avatar / socials). Read-only — clicking
  shows a tooltip explaining the user should edit these in account
  settings.

Rows sort by:

1. Auth-overlay rows first, in the order they appear in
   `AUTH_OVERLAY_KEYS` (`name`, `email`, `avatar`, `socials`).
2. Store rows alphabetically by key.

`Delete` opens a confirmation dialog (`Delete this memory?`). On
confirm, `DELETE /api/memory/profile/[key]` removes the key from
the store doc.

Structured values (object / array) render through the same
`JsonBlock` primitive the observability panel uses for span payloads.
`maxHeight={240}` caps the height so a deep profile field can't
push the rest of the card off-screen; `CopyButton` overlay
top-right for raw-JSON copy.

### Section 2 — Thread summaries

Each thread with at least one `SummaryEntry` renders as one row
(header + collapsible Q&A body). Header:

- ScrollText icon (classified as "summarized by AI" — same hint
  shape as profile rows).
- Title (from `threads.title`, set by `renameThreadAgent` on the
  first turn) with raw `threadId` underneath in muted meta when the
  title is present. When title is missing, the threadId IS the
  header (no duplicate below).
- Expand / Collapse toggle (chevron pointing right when collapsed,
  left when expanded). Defaults to **collapsed** — long lists of
  past threads render as scannable single-line headers; expand on
  demand.
- Delete button — wipes every SummaryEntry for the thread. Opens
  the same dialog shape as profile deletion.

The toggle is wired via Radix `Collapsible` so the body height
interpolates from 0 to auto via `--radix-collapsible-content-height`
(200ms ease-out, keyframes in `app/globals.css`). No hard show /
hide.

Inside the body, each `SummaryEntry` renders as:

```
Summary · N  ·  <formatted timestamp>
┌────────────────────────────────────────┐
│ Q&A entries (formatted prose)          │
│ ...                                    │
└────────────────────────────────────────┘
```

Multiple entries within a thread stack vertically with the same
indent as the thread header's content column.

### Empty states

- **No profile fields yet** — Bot icon, "When the assistant writes
  down something to remember about you, it'll show up here."
- **No thread summaries yet** — ScrollText icon, "Once a
  conversation runs long enough to compress, the earlier turns get
  summarized and land here."

### Sort order (frontend)

Threads sort by `max(summaries[].createdAt)` DESC — most
recently-active first. Within a thread, summaries render in
backend order (oldest pass first). The Memory tab is a strict
passthrough: no client-side sort on either layer (memory note in
`lib/memory/queries.ts`).

## HTTP endpoints (summary)

Full request / response / status codes in [`docs/APIS.md`](./APIS.md)
§ Memory.

| Method   | Path                             | Purpose                                                 |
| -------- | -------------------------------- | ------------------------------------------------------- |
| `GET`    | `/api/memory/profile`            | Merged memory doc + flat thread summaries (with titles) |
| `DELETE` | `/api/memory/profile/[key]`      | Remove a single profile key                             |
| `GET`    | `/api/memory/threads`            | All summaries, grouped by threadId                      |
| `DELETE` | `/api/memory/threads/[threadId]` | Remove every summary for the thread                     |

## Configuration

Two env knobs (`lib/memory/constants.ts`, parsed once at module load):

| Variable                            | Default | Purpose                                                                                                                                    |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MEMORY_THREAD_SUMMARY_KEEP_RECENT` | `10`    | Trigger cadence for `summarize`. Same number drives batch size and recent-floor (last K turns never compressed). `< 1` collapses to no-op. |
| `MEMORY_PROFILE_MAX_BYTES`          | `8192`  | Max `JSON.stringify(storeDoc).length` after a `save_memory` patch. Exceeding throws `MemorySizeError`.                                     |

Defaults match the docs / worked examples (K=10 means a fresh
trigger fires every 10 turns past K).

## Storage model — `PostgresStore`

Profile + thread summaries both live in LangGraph's `PostgresStore`
(the same `store` instance wired into both compiled graphs via
`compile({ store })` in `backend/agent.ts` and
`backend/background-agent.ts`).

Namespace layout:

| Namespace             | Key                     | Value                                         |
| --------------------- | ----------------------- | --------------------------------------------- |
| `[userId, "memory"]`  | `main`                  | `MemoryDoc` (the user-saved profile)          |
| `[userId, "threads"]` | `<threadId>:<sequence>` | `SummaryEntry` (one row per compression pass) |

`getMemoryDoc` / `putMemoryDoc` go straight to
`store.get(memoryNs(userId), MEMORY_KEY)` / `store.put(...)`.
Thread-summary reads use `store.search(threadsNs(userId))` filtered
by `threadId` — `RECALL_LIMIT` was retired; unbounded reads stay
well under any realistic budget (a few KB per entry).

### Cross-user isolation

Every namespace is prefixed with `userId`. Every code path that
reads memory (`loadMemory`, `getThreadSummaries`,
`getRecentThreadSummaries`) takes the `userId` from
`config.configurable.userId` or the session row — there's no path
that crosses user boundaries without an explicit re-key. The
route layer (`app/api/memory/*`) is `withAuth`-wrapped; cross-user
access returns 404 (no existence leak).

### Delete semantics

`DELETE /api/memory/profile/[key]` removes one key from the store
doc. Modeled as an RFC 6902 remove patch via the same path
`save_memory` uses.

`DELETE /api/memory/threads/[threadId]` removes every summary for
the thread. Loops `store.delete(threadsNs(userId), s.key)` per row
because `PostgresStore.batch()` rejects `{ op: "delete" }` entries
with "Unsupported operation type" (verified at
`@langchain/langgraph-checkpoint-postgres` 1.0.4
`/store/index.js:155`).

`DELETE /api/threads/[id]` and `DELETE /api/admin/users/[id]`
also fire this sweep as part of `purgeThreadState` / `purgeUserState`
(`lib/threads/queries.ts`), so a thread or account going away
takes its summaries + LangGraph checkpointer rows + memory profile
with it. No separate cron needed for the happy-path lifecycle;
see [`docs/APIS.md`](./APIS.md) for the endpoint contracts.

## Security stance

- **No forget tool.** The Memory tab is the only path to deletion —
  no `forget_memory` tool exposed to the model. The model writes,
  the user deletes.
- **Fail-closed on missing userId.** `MissingUserIdError` (`code:
"MISSING_USER_ID"`) is thrown before any store write — a missing
  / empty `config.configurable.userId` cannot silently write to the
  wrong user's profile.
- **Path validation.** RFC 6901 pointer regex `^\/[A-Za-z_][A-Za-z0-9_-]*$`
  rejects array indices and any path-traversal primitive. Move /
  copy / test ops are rejected at the Zod level — the profile is a
  flat k-v bag, structured merge isn't a useful primitive.
- **Size guard.** `assertProfileSize` runs BEFORE the store write.
  Exceeding `MEMORY_PROFILE_MAX_BYTES` throws `MemorySizeError`
  with `attemptedBytes` + `maxBytes` so the model can retry with a
  smaller patch.
- **Patch validation.** `replace` / `remove` on a path not in the
  merged view throws `MemoryPatchError` (`code: "PATCH_FAILED"`).
  Silent no-op is the failure mode this guard exists to avoid.
- **Token redaction (OAuth).** `getAuthInfo` returns
  `{ provider }` only — `accountId`, `access_token`, `refresh_token`,
  `id_token` are deliberately excluded (FR-020). The `"credential"`
  provider is filtered out so email+password accounts don't show as
  a misleading "linked account" in the Memory tab.
- **Cross-user isolation.** Every `app/api/memory/*` route is
  `withAuth`-wrapped (CLAUDE.md rule #9); ownership returns 404
  (no existence leak).

## Known trade-offs

- **`store.search` over the whole `[userId,"threads"]` prefix is
  fine for MVP** — N users × few threads × tens of summaries stays
  small. Add a filter on `threadId` at the search layer if this
  grows.
- **No summary retention yet.** Unlike observability spans,
  SummaryEntries have no `OBSERVABILITY_RETENTION_DAYS`-style
  cron. They're meant to persist for the life of the account —
  thread/account delete sweeps them via `purgeThreadState` /
  `purgeUserState`, no separate cron needed.
- **Char-based token estimate.** `estimateTokens` is
  `Math.ceil(text.length / 4)` — rough heuristic used for the
  SummaryEntry's `tokenCountBefore/After` analytics fields. Not
  used for triggering (trigger is turn-count-based). A future
  token-budget secondary pass can swap in `@langchain/core`'s
  real counting without changing the call sites.
- **`getRecentThreadSummaries` is unbounded** — `RECALL_LIMIT` was
  retired because thread summaries are small (a few KB each).
  Reintroduce a cap if usage data shows otherwise.
- **Background graph shares the chat runtime.** Both compiled
  graphs run on the same dev server (port 2024) and inherit the
  `langgraphjs dev` in-memory checkpointer. The chat stream
  doesn't block on background work, but the background work does
  share the process's CPU / DB connections — a noisy
  `threadSummarizeNode` LLM call competes with concurrent chat
  invokes.
- **`triggerBackgroundAgentNode` dispatches via HTTP.** Uses the
  SDK's `client.runs.create(...)` over HTTP to `langgraphjs dev`
  on `:2024` rather than in-process `graph.invoke(...)`. The
  in-process path would be killed by the parent invoke's composed
  `AbortSignal` the moment the chat invoke `END`s — the only clean
  path for fire-and-forget is cross-process HTTP. Dev-server
  behavior determines whether the call blocks (no worker pool
  locally, yes; LangSmith Deployments, no).
- **`config.configurable` envelope.** `userId` and `thread_id`
  ride on the LangGraph runtime config, set by
  `app/api/[..._path]/route.ts` from the cookie session. Sub-agent
  nodes forward the same envelope to background calls via
  `client.runs.create(... config: { configurable: { userId,
thread_id }})`. Any future node reading either field should
  parse defensively — `extractUserId` / `extractThreadId` in
  `backend/memory/recall.ts` are the canonical parsers.
- **Empty / corrupt entries are skipped at read time, not at write
  time.** `getAllUserSummaries` runs `SummaryEntrySchema.safeParse`
  on each row and drops failures. Corrupt rows leave a silent
  gap in the displayed summary; Zod-valid rows land normally.
  No cleanup cron today; add one if the schema evolves.
- **`createSystemPromptWithMemoryTemplate` failure isolation.**
  `loadThreadSummariesForPrompt` swallows its own fetch errors
  and returns `null`. A store flap degrades the prompt to "no
  compressed history" rather than 500-ing the chat — acceptable
  since the most recent K turns are still in the input messages.
