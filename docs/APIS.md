# API Reference

Quick map of every HTTP endpoint under `app/api/`. For exact request/response shapes, status codes, and validation rules, read the route handler directly — the file path is the truth.

This doc exists so you can find your way around the API surface without grepping. Update it whenever a route is added, removed, or repurposed.

## Auth

Better Auth catch-all at `app/api/auth/[...all]/route.ts`. All paths below are proxied through Better Auth's `auth.handler`. See `lib/auth/config.ts` for provider config and `lib/auth/queries.ts` for server-side session lookup.

| Endpoint                                                             | Purpose                                                                   | Auth required     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| `POST /api/auth/sign-up/email`                                       | Email + password registration. Triggers `sendVerificationEmail`.          | No                |
| `POST /api/auth/sign-in/email`                                       | Email + password sign-in (requires `emailVerified=true`).                 | No                |
| `POST /api/auth/sign-out`                                            | End the current session.                                                  | Yes               |
| `GET /api/auth/get-session`                                          | Returns `{ user, session }` or `{ user: null, session: null }`.           | No (returns null) |
| `GET /api/auth/verify-email?token=...`                               | Verify email via a one-time token from the verification email.            | No                |
| `POST /api/auth/send-verification-email`                             | Re-send the verification email (invalidates the previous token).          | No                |
| `GET /api/auth/sign-in/social?provider=github\|google&callbackURL=/` | OAuth entry — 302 to provider.                                            | No                |
| `GET /api/auth/callback/:provider`                                   | OAuth callback — creates/links account and session, 302 to `callbackURL`. | No                |

### Error codes (stable)

`EMAIL_INVALID`, `PASSWORD_TOO_WEAK`, `EMAIL_TAKEN`, `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `RATE_LIMITED`, `EMAIL_QUOTA_EXCEEDED`, `OAUTH_FAILED`, `OAUTH_DENIED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`.

### Session shape

```ts
{
  user: { id: string; email: string; emailVerified: boolean; name?: string; image?: string };
  session: { id: string; userId: string; token: string; expiresAt: string };
}
```

## Threads

Thread metadata, backing the assistant-ui sidebar. Implementation: `lib/threads/{queries,validators}.ts`. Adapter: `lib/threads/adapter.ts`.

**Auth + isolation contract (Stage 1)**: every endpoint below requires a session cookie. `GET` lists only the calling user's threads. `GET / PATCH / DELETE` on `[id]` return 404 if the thread exists but belongs to another user (no existence leak). Deleting a user cascades through `ON DELETE CASCADE` and removes their threads.

Response shape (single row, same for list / fetch / create / update):

```ts
{
  id: string; // LangGraph thread_id
  status: "regular" | "archived";
  title: string;
  lastMessageAt: string; // ISO timestamp
}
```

`lastMessageAt` mirrors the most recent activity for the thread (creation time until a run-end sync lands; see `lib/threads/queries.ts`). The frontend adapter translates this object into assistant-ui's `RemoteThreadMetadata` (`remoteId` + `externalId` are both set to `id`).

| Endpoint                   | Purpose                                                                                       | Status codes          |
| -------------------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| `GET /api/threads`         | List regular (non-archived) threads owned by the current user.                                | 200 / 401             |
| `POST /api/threads`        | Create a new thread bound to the current user; registers the id with the LangGraph dev STORE. | 201 / 400 / 401       |
| `GET /api/threads/[id]`    | Fetch one thread's metadata (owner-only).                                                     | 200 / 401 / 404       |
| `PATCH /api/threads/[id]`  | Rename, archive, unarchive, or replace `custom` jsonb (owner-only).                           | 200 / 400 / 401 / 404 |
| `DELETE /api/threads/[id]` | Remove the thread metadata row (owner-only; does not touch LangGraph checkpoints).            | 204 / 401 / 404       |

## Attachments

Chat attachments backed by Cloudflare R2 (issue #12). The browser uploads directly to R2 via a presigned PUT — bytes never touch the Next.js server. Design doc: [`docs/ATTACHMENTS.md`](./ATTACHMENTS.md) (key convention, lazy-register, Content-Disposition per-object).

**Auth + isolation contract**: every endpoint below is wrapped in `withAuth` (rule #9). Reads scope by `user_id`; cross-user access returns 404 (no existence leak). When any `R2_*` server env is missing the routes return `503 ATTACHMENTS_NOT_CONFIGURED` rather than 500 — mirrors the DENO / ALCHEMY lazy-register pattern.

### `POST /api/attachments/presign`

Reserve an attachment row and a 5-minute presigned PUT URL. Browser immediately PUTs the file to R2 with the returned `uploadHeaders` (Content-Type is baked into the signature — a mismatch is a 403 from R2).

|               |                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ name: string (1..256), contentType: string (1..127), sizeBytes: number (>0), threadId?: string (1..128) }`. `contentType` must appear in `R2_ALLOWED_CONTENT_TYPES`; `sizeBytes` ≤ `R2_MAX_BYTES`. |
| 201 response  | `{ id, key, uploadUrl, publicUrl, contentType, sizeBytes, uploadHeaders: { "Content-Type": contentType } }`. The presigned URL expires in 300s. `publicUrl` is `${R2_PUBLIC_BASE_URL}/${key}`.        |
| Failure codes | 400 `BAD_REQUEST` (invalid JSON / schema). 400 `CONTENT_TYPE_NOT_ALLOWED`. 400 `FILE_TOO_LARGE` (`{ maxBytes, sizeBytes }`). 401 `UNAUTHORIZED`. 503 `ATTACHMENTS_NOT_CONFIGURED`.                    |

### `POST /api/attachments/[id]/confirm`

Finalize after the browser PUT. Server does a `HeadObject` to verify the upload landed with the claimed `Content-Length`; row flips from `pending` to `uploaded` and `confirmedAt` is stamped.

|               |                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | empty                                                                                                                                                                                                                                 |
| 200 response  | `{ id, publicUrl, contentType, sizeBytes, status: "uploaded" }`                                                                                                                                                                       |
| Failure codes | 401 `UNAUTHORIZED`. 404 `NOT_FOUND` (id missing or owned by another user). 409 `SIZE_MISMATCH` (`{ expected, actual }` — partial upload). 409 `UPLOAD_MISSING` (HeadObject 404 — PUT never landed). 503 `ATTACHMENTS_NOT_CONFIGURED`. |

### `DELETE /api/attachments/[id]`

Best-effort cleanup of a composer chip. Removes the row + the R2 object. Idempotent: R2 404 on delete is swallowed (the row is gone either way).

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| Response      | `204 No Content`                                                       |
| Failure codes | 401 `UNAUTHORIZED`. 404 `NOT_FOUND`. 503 `ATTACHMENTS_NOT_CONFIGURED`. |

### `POST /api/avatar/presign`

Presign a 5-minute PUT for a user avatar (issue #28). Same R2 backing as attachments (`withAuth`, 503 when `R2_*` unset), but **no DB row** — avatars aren't chat attachments. Key is `u/<userId>/avatar/<id>-<safe-name>`. The browser PUTs the file, then calls Better Auth `updateUser({ image: publicUrl })` — we store only the URL, never base64 (a base64 data URL in `user.image` flowed through the memory auth-overlay into every `<memory>` block uncapped; that was the 372K-token blow-up). Client gate: the Settings avatar upload is disabled unless `window.__CONFIG__.ATTACHMENTS_ENABLED === "true"`.

`contentType` must start with `image/` **and is not `image/svg+xml`** — unlike attachments (which uses `R2_ALLOWED_CONTENT_TYPES`), this route hardcodes the image check, and SVG is rejected because it can carry inline script and renders `inline` from a public bucket (XSS in the bucket origin).

|               |                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ name: string (1..256), contentType: string (1..127), sizeBytes: number (>0) }`. `contentType` must start with `image/` and not be `image/svg+xml`; `sizeBytes` ≤ `R2_MAX_BYTES`. |
| 201 response  | `{ key, uploadUrl, publicUrl, uploadHeaders: { "Content-Type": contentType, "Content-Disposition": "inline" } }`. Presigned URL expires in 300s.                                    |
| Failure codes | 400 `BAD_REQUEST`. 400 `CONTENT_TYPE_NOT_ALLOWED` (non-image or svg). 400 `FILE_TOO_LARGE` (`{ maxBytes, sizeBytes }`). 401 `UNAUTHORIZED`. 503 `AVATAR_UPLOADS_NOT_CONFIGURED`.    |

### `DELETE /api/avatar`

Delete the R2 object behind a previous avatar URL — avatars have no DB row, so nothing else sweeps the old object when the user deletes or replaces one. Called by the Settings UI on delete and after a successful replace. Owner-scoped: the key must live under `u/<user.id>/avatar/`.

|               |                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ url: string }` — the avatar's public URL.                                                                                                                     |
| Response      | `204 No Content`. Idempotent (R2 404 swallowed). An external / non-R2 URL is a no-op 204.                                                                        |
| Failure codes | 400 `BAD_REQUEST` (invalid JSON / missing url). 401 `UNAUTHORIZED`. 403 `FORBIDDEN` (key outside the caller's avatar path). 503 `AVATAR_UPLOADS_NOT_CONFIGURED`. |

## Observability

Per-thread captured LLM / Tool / Chain / Node / Human spans — written at every End hook by the callback handler attached to the compiled graph in `backend/agent.ts` via `compile({ checkpointer }).withConfig({ callbacks: [capturingHandler] })`. Attaching at the compile layer (not per-model) ensures ToolNode spans are captured too. Design doc: [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md) (storage, retention, FORBIDDEN regex, trade-offs).

**Auth + isolation contract**: every endpoint below is wrapped in `withAuth` (rule #9). Path id is a LangGraph `thread_id` — ownership is checked against the calling user; cross-user access returns 404 (no existence leak).

DB rows are cleared automatically by `ON DELETE CASCADE` when the parent `threads` row is removed — the observability endpoints don't need to manage thread lifecycle themselves.

### `GET /api/threads/[id]/observability`

Returns the thread's waterfall data + pre-computed aggregate for the panel header. The handler is `app/api/threads/[id]/observability/route.ts`. Side effect: preflight `markRunningAsFailed(id)` flips any still-`running` rows to `failed` so the client doesn't see stale running states when the chain crashed mid-flight. This is the un-filtered variant — for spans scoped to a single turn, see `GET /api/threads/[id]/observability/[parentMessageId]` below.

**Wire shape (200)** — server-transformed:

```ts
{
  thread_id: string;
  retention_days: number; // obs: from OBSERVABILITY_RETENTION_DAYS, default 30
  // ponytail: SpanData[] (not raw CapturedSpan[]) — the route runs
  // transformCapturedToSpanData server-side so the panel never sees the
  // collector's internal payload (input/output/usage/meta are stripped).
  // To inspect those on a single row, hit /spans/[spanId] below.
  spans: SpanData[];                  // ordered by startedAt ASC
  aggregate: AggregateDTO | null;     // pre-computed stat-card row; null when no spans
  in_flight_runs: InFlightRun[];      // always present, empty for the un-filtered route
  step_id_to_raw_span_id: Record<string, string>;  // synthetic step-wrapper id → raw span_id
}
```

- `SpanData` is the `@assistant-ui/react-o11y` waterfall input — `{ id, parentSpanId, name, type, status, startedAt, endedAt, latencyMs }`. Status is `"running" | "completed" | "failed" | "skipped"`. Extended on the wire with `parentMessageId?: string` (the turn this row belongs to) so the panel can build the per-turn detail URL without re-deriving from the waterfall tree.
- `AggregateDTO` mirrors `RootAggregate` in `lib/observability/aggregate.ts` — token totals (`totalInput` / `totalOutput` / `totalTokens` / `totalCacheRead` / `totalReasoning`), TTFT (`ttftAvgMs` / `ttftMaxMs`, both nullable), span counts by kind (`llmSpanCount` / `toolSpanCount` / `humanCount` / `failedCount`), and `totalDurationMs`.

Status codes:

| Status | Trigger                            | Body                       |
| ------ | ---------------------------------- | -------------------------- |
| 200    | owner query                        | the payload above          |
| 401    | no session                         | `{ code: "UNAUTHORIZED" }` |
| 404    | thread missing or owned by another | `{ code: "NOT_FOUND" }`    |

### `GET /api/threads/[id]/observability/[parentMessageId]`

Filtered variant of the GET above — returns only the spans tagged with `meta.parent_message_id === <parentMessageId>`. The id is the assistant-ui human-message id (`message.parentId`) that triggered the turn; the backend tags every span for that turn with the same value via `CapturingHandler.currentParentMessageId`. Implementation lives at `app/api/threads/[id]/observability/[parentMessageId]/route.ts`. Served by the btree index `observability_spans_thread_parent_started_idx (thread_id, parent_message_id, started_at)` so the planner can satisfy `WHERE thread_id = ? AND parent_message_id = ? ORDER BY started_at` from the index alone.

Same wire shape as the un-filtered route, with two additions:

```ts
{
  // ...same as above, plus:
  parent_message_id: string;
  in_flight_runs: Array<{
    run_id: string;
    thread_id: string;
    assistant_id: string;
    status: "pending" | "running";
    created_at: string; // ISO timestamp
    updated_at: string; // ISO timestamp
    metadata: {
      parent_message_id: string | null;
      [extra: string]: unknown; // passthrough — additional keys preserved
    };
  }>;
}
```

`in_flight_runs` is filtered by `metadata.parent_message_id === <parentMessageId>` to scope it to the current turn. The two SDK calls (`status: "running"` + `status: "pending"`) are because `list({status})` is single-valued; status values are documented in `@langchain/langgraph-sdk`'s `RunStatus` type. Main-agent runs are NOT in this list today — only `triggerBackgroundAgentNode` stamps `metadata.parent_message_id` on its `runs.create` payload. Main-agent in-flight state is observable via the `spans` array (CapturingHandler now persists on `handleChainStart`).

`step_id_to_raw_span_id` maps synthetic step-wrapper ids (e.g. `step-3-routerAgent-...`) to their representative raw `span_id`. The panel reads this to translate a clicked wrapper row into the raw span id the detail endpoint expects. Empty when the thread has no step wrappers.

Status codes:

| Status | Trigger                            | Body                       |
| ------ | ---------------------------------- | -------------------------- |
| 200    | owner query                        | the payload above          |
| 401    | no session                         | `{ code: "UNAUTHORIZED" }` |
| 404    | thread missing or owned by another | `{ code: "NOT_FOUND" }`    |

### `DELETE /api/threads/[id]/observability`

Clears all spans for the thread. Returns `{ cleared: number }` (the row count). Same auth + ownership contract as GET.

Status codes: 200 / 401 / 404 (same triggers as GET).

### `GET /api/threads/[id]/observability/[parentMessageId]/spans/[spanId]`

Returns the full `CapturedSpan` for a single span. Called from the panel when the user clicks a waterfall row — the waterfall renders from the server-transformed `SpanData[]`, but `SpanDetails` (and the row's hover tooltip fields like model name / TTFT / tokens) need the raw payload.

`spanId` is the raw `span_id`, NOT a synthetic step-wrapper id. The panel translates wrapper ids via the `step_id_to_raw_span_id` map from the parent route before issuing this fetch.

`parentMessageId` is the turn this row belongs to. The transform layer stamps it on every SpanData (root + step wrapper + leaf), so the panel can pluck it from the clicked row without re-deriving from the waterfall tree. The DB lookup is `(thread_id, parent_message_id, span_id)` — uses the existing `observability_spans_thread_parent_started_idx` btree. If the row's span isn't found in DB (e.g. retention evicted it between the parent fetch and the click), the route falls back to `langGraphClient.runs.list(threadId, { status: "running"|"pending" })` filtered by `metadata.parent_message_id === parentMessageId`, so an active bg-agent run still surfaces a details card. Missing in both → 404.

Response (200):

```ts
{
  thread_id: string;
  span: CapturedSpan; // full collector payload — input / output / usage / meta / error
}
```

Status codes:

| Status | Trigger                                                                                | Body                       |
| ------ | -------------------------------------------------------------------------------------- | -------------------------- |
| 200    | span exists for `(parent_message_id, span_id)` in DB or SDK                            | the payload above          |
| 401    | no session                                                                             | `{ code: "UNAUTHORIZED" }` |
| 404    | thread missing or owned by another, OR span not in this turn, OR span not found at all | `{ code: "NOT_FOUND" }`    |

## Memory

Backed by the LangGraph `PostgresStore` (per-user, cross-thread long-term memory). Every route is `withAuth`-wrapped and isolation is by namespace prefix `[userId, ...]`. Storage detail: `lib/memory/queries.ts`; schema (RFC 6902 patches, store): `lib/memory/validators.ts`; size guard: `backend/memory/profile-size.ts`. Read counterpart of `save_memory` (see "Graph tools").

### `GET /api/memory/profile`

Returns the user's profile doc plus read-only better-auth fields that the agent already sees via the recall middleware, plus a flat list of thread summaries enriched with the corresponding chat title. The store + auth fields are kept separate on purpose so the UI can classify each merged field as "summarized by AI" (store) vs "from account" (auth overlay) using store-keys membership — the same classification the model's `<memory>` block applies.

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body | (none)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Output       | `{ store: Record<string, unknown>, auth: { name, email, avatar, socials: Array<{ provider: string; email?: string }> }, threads: Array<{ key, value: SummaryEntry, threadTitle: string \| null }> }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Status codes | 200 / 401 / 500 (store throws). 401 is returned by the shared `withAuth` wrapper, not the handler body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Field notes  | `auth.avatar` is the user's profile image — an `https://...` URL once Settings → Account uploads to R2, `null` otherwise. Legacy `data:` base64 rows in `user.image` are filtered out on read so the model never sees them in the memory block (issue #28 — the 372K-token blow-up was a base64 avatar flowing through the auth overlay uncapped). `auth.socials[].provider` is the better-auth `providerId` for each linked OAuth account (`github`, `google`, ...). `auth.socials[].email` is the per-provider verified email when available: Google via OIDC `idToken` `email` claim (only when `email_verified === true`), GitHub via `GET /user/emails` with the stored `accessToken` (primary+verified preferred). Unverified / undecodable / fetch-failed → `email` is absent from that entry. `accountId` / tokens are deliberately NOT exposed (FR-020). The "credential" provider is filtered out so email+password accounts don't show as a misleading "linked account". `threads[]` is `createdAt`-asc (oldest-first); the Memory tab groups by threadId client-side using insertion order — do not sort on the client (FR-passthrough). `threadTitle` is the row from the `threads` table set by `renameThreadAgent`; `null` when the rename path hasn't run, in which case the UI falls back to the raw `threadId`. Storage detail: `lib/memory/queries.ts`; Zod shape: `lib/memory/validators.ts` `MemoryResponseSchema`. |

### `DELETE /api/memory/profile/[key]`

Removes a single profile key. Modeled as a one-shot RFC 6902 remove patch against `[userId,"profile"] main`. There is no separate "forget" tool — the Memory tab is the only path to forgetting.

|               |                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | (none)                                                                                                                                                       |
| Output        | `{ ok: true, deletedKey }` on success                                                                                                                        |
| Status codes  | 200 / 400 / 401 / 404                                                                                                                                        |
| Path regex    | `:key` MUST match `^[A-Za-z0-9_-]{1,64}$`. Decoded via `decodeURIComponent` first — `%2F` becomes `/` and is rejected. Empty string after decode also → 400. |
| Failure modes | 404 when the profile doc does not exist OR when `key` is not a top-level property of the doc. 400 when the regex fails.                                      |

### `GET /api/memory/threads`

Lists thread summaries the user has generated. Grouped by `threadId`, sorted by sequence desc within a group and by `updatedAt` desc across groups. Corrupt Zod-failing summaries are skipped server-side.

|              |                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body | (none)                                                                                                                                                                                       |
| Output       | `{ threads: Array<{ threadId: string, summaries: Summary[] }> }`. `Summary` shape: `{ threadId, sequence, name, description, startMessageIndex, endMessageIndex, messageCount, updatedAt }`. |
| Status codes | 200 / 401 / 500                                                                                                                                                                              |
| Field notes  | `startMessageIndex` / `endMessageIndex` are inclusive bounds on the user-message window (FR-010 closed interval); `messageCount === end - start + 1`.                                        |

### `DELETE /api/memory/threads/[threadId]`

Collapses all summary docs whose key starts with `${threadId}:` under the user's `[userId,"threads"]` namespace.

|               |                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Request body  | (none)                                                                                            |
| Output        | `{ ok: true, deletedCount }` on success                                                           |
| Status codes  | 200 / 401 / 404                                                                                   |
| Failure modes | 404 when no summary doc exists for `threadId` for the current user (a no-op for an empty thread). |

## Admin

Every endpoint is `withAuth({ role: "admin" }, ...)` (rule #9). The wire shape for providers strips `encryptedKey` + `iv` from `apiKeys[]` — see [`docs/ADMIN.md`](./ADMIN.md) § Secrets handling for the AES-256-GCM contract. Roles are returned in full (no secrets on that table). All providers endpoints live in `app/api/admin/providers/**`; all roles endpoints in `app/api/admin/roles/**`.

### `GET /api/admin/providers`

List every row in `provider`, ordered by `id`. The encrypted key material is stripped server-side — only `name` (the `"sk-…xyz9"` derived first-3 + last-4) + optional `baseUrl` are exposed.

|               |                                     |
| ------------- | ----------------------------------- |
| Request body  | (none)                              |
| 200 response  | `{ providers: PublicProvider[] }`   |
| Failure codes | 401 `UNAUTHORIZED`, 403 `FORBIDDEN` |

### `POST /api/admin/providers`

Create a new provider row. `apiKeys` / `models` default to `[]`.

|               |                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ id: string (^[a-z0-9_-]+$, 1..64), name: string (1..128), enabled?: boolean (default true), apiKeys?: ProviderApiKey[] (default []), models?: ModelConfig[] (default []) }`. |
| 201 response  | `PublicProvider`                                                                                                                                                                |
| Failure codes | 400 `BAD_REQUEST`, 401, 403. The DB PK rejects duplicates; the handler surfaces that as a generic 500 today (no 409 wrap yet).                                                  |

### `PATCH /api/admin/providers/[id]`

Partial update. Whole-array replacement is used for `apiKeys` / `models` when present — no merge semantics.

|               |                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ id?, name?, enabled?, apiKeys?, models? }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `PublicProvider`                                                                                   |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND`                                                       |

### `DELETE /api/admin/providers/[id]`

Hard-delete. Historical `credit_usage_log` rows keep their `provider_id` (text, not FK) even after the provider is gone.

|               |                           |
| ------------- | ------------------------- |
| Response      | `204 No Content`          |
| Failure codes | 401, 403, 404 `NOT_FOUND` |

### `POST /api/admin/providers/[id]/keys`

Encrypt + append a key. Plaintext is encrypted with AES-256-GCM (`lib/auth/encryption.ts`); the response only carries the derived `name` + optional `baseUrl`.

|               |                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Request body  | `{ plaintext: string (1..2048), baseUrl?: url }`                                                            |
| 201 response  | `PublicProvider` (full row, secrets stripped)                                                               |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider missing), 409 `DUPLICATE_KEY` (same-tail collision). |

### `DELETE /api/admin/providers/[id]/keys`

Remove a key by its `name` (the derived tail).

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| Request body  | `{ name: string (1..64) }`                                                                |
| 200 response  | `PublicProvider`                                                                          |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider missing OR no key matches `name`). |

### `PATCH /api/admin/providers/[id]/keys/[keyName]`

Rotate (new plaintext) and/or rename an existing key. Path is keyed on the **original** `keyName` so existing admin UI links keep working. `plaintext` re-derives `name` from the new plaintext via `deriveKeyName()` so the displayed tail stays in sync with what's encrypted. An explicit `name` in the body overrides the derived one (rename wins over rotate). Either field can be sent independently — sending only `plaintext` is the legacy rotate flow; sending only `name` is a pure rename. Collision check excludes the entry being patched — a rotate-to-same-tail is a no-op rename with a fresh ciphertext.

|               |                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | Any subset of `{ plaintext?: string (1..2048), name?: string (1..64, `^[a-zA-Z0-9_\-…]+$`) }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `PublicProvider`                                                                                                                     |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider or key missing), 409 `DUPLICATE` (renamed / derived name matches another).    |

### `POST /api/admin/providers/[id]/models`

Append a new model + rate config. `inputPer1k` / `outputPer1k` are credits-per-1k-tokens — see [`docs/CREDIT.md`](./CREDIT.md).

|               |                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Request body  | `{ name: string (1..128), enabled: boolean, inputPer1k: number (≥0), outputPer1k: number (≥0) }`. |
| 201 response  | `PublicProvider`                                                                                  |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider missing), 409 `DUPLICATE_MODEL`.           |

### `PATCH /api/admin/providers/[id]/models/[modelName]`

Partial update. Rate changes after a call are NOT retroactively applied to historical `credit_usage_log` rows — see [`docs/CREDIT.md`](./CREDIT.md).

|               |                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ enabled?, inputPer1k?, outputPer1k? }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `PublicProvider`                                                                               |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider or model missing).                      |

### `DELETE /api/admin/providers/[id]/models/[modelName]`

Remove a model from the provider. Historical call rows keep their `model_name`.

|               |                           |
| ------------- | ------------------------- |
| Response      | `204 No Content`          |
| Failure codes | 401, 403, 404 `NOT_FOUND` |

### `GET /api/admin/roles`

List every role row.

|               |                        |
| ------------- | ---------------------- |
| Request body  | (none)                 |
| 200 response  | `{ roles: RoleRow[] }` |
| Failure codes | 401, 403               |

### `POST /api/admin/roles`

Create a new role. The seeded trio (`guest`, `user`, `admin`) is inserted by the migration — POST is for adding extra tiers (e.g. `pro`, `vip`).

|               |                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ id: string (^[a-z0-9_-]+$, 1..64), name: string (1..128), creditLimit: number (≥0) \| null (null = unlimited), windowHours: number (1..720, default 24) }`. |
| 201 response  | `RoleRow`                                                                                                                                                      |
| Failure codes | 400 `BAD_REQUEST`, 401, 403                                                                                                                                    |

### `PATCH /api/admin/roles/[id]`

Partial update. `creditLimit` / `windowHours` changes take effect on the next LLM call — there is no caching layer.

|               |                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ name?, creditLimit?, windowHours? }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `RoleRow`                                                                                    |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND`                                                 |

### `DELETE /api/admin/roles/[id]`

Hard-delete. Refuses with 409 `ROLE_IN_USE` if any user still references the role — the handler counts `user.role_id = <id>` and rejects rather than dropping the FK.

|               |                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Response      | `204 No Content`                                                                                            |
| Failure codes | 401, 403, 404 `NOT_FOUND`, 409 `ROLE_IN_USE` (body carries `message: "role is referenced by <N> user(s)"`). |

## Admin — Users

Admin user management. Backing table is `user` in `lib/auth/schema.ts` (FK on `role_id` → `role.id`). The `banned` column was added in migration 0004 alongside a `databaseHooks.session.create.before` gate in `lib/auth/config.ts` — banned users cannot mint new sessions, and `PATCH ... { banned: true }` DELETEs every existing session row so the cutoff is immediate on the next request.

Better Auth's built-in `admin` plugin was considered and skipped: it brings a parallel `role` text column that conflicts with our `role_id` FK to the `role` table. A boolean on our schema is half the surface and stays consistent with the `default`-provider / last-admin guards elsewhere.

### `GET /api/admin/users`

List every user with a left-joined role snapshot. The admin /admin → Users tab renders this as the table source.

|               |                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | (none)                                                                                                                                                                                                                                  |
| 200 response  | `{ users: { id, name, email, emailVerified, roleId, roleName, banned, createdAt, updatedAt }[] }`. `roleName` is `null` if the FK target is missing (defensive — FK prevents it on a healthy DB; a leftJoin can still null it on race). |
| Failure codes | 401, 403.                                                                                                                                                                                                                               |

### `PATCH /api/admin/users/[id]`

Partial update. `roleId` / `banned` flip the same-name columns. The last-admin guard mirrors the `default`-provider protection — demoting or banning the only remaining admin returns 409 `LAST_ADMIN`.

When `banned: true` is sent, every row in `session` where `userId` matches is DELETEd in the same handler so the ban takes effect immediately on the next request (the client loses its session cookie → 401 → redirect to /login). Unban does NOT touch sessions — the user signs in fresh.

|               |                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ roleId?: string, banned?: boolean }`. Empty body returns 400 `BAD_REQUEST`.                                                   |
| 200 response  | The updated `user` row.                                                                                                                        |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (user missing OR `ROLE_NOT_FOUND` for unknown `roleId`), 409 `LAST_ADMIN` (would leave no admin). |

### `DELETE /api/admin/users/[id]`

Hard-delete. FK cascade removes `session` + `account` rows automatically. The last-admin guard fires with 409 `LAST_ADMIN` if the target is admin and no other admin exists.

|               |                                              |
| ------------- | -------------------------------------------- |
| Response      | `204 No Content`                             |
| Failure codes | 401, 403, 404 `NOT_FOUND`, 409 `LAST_ADMIN`. |

## Credit history

Per-LLM-call log surfaced to the end user. Source of truth is `credit_usage_log` in `lib/credit/schema.ts` (see [`docs/CREDIT.md`](./CREDIT.md) for the cap-enforcement side, [`docs/DB.md`](./DB.md) for the schema). The user-facing Settings → Credits tab renders this; the panel is a react-query `useInfiniteQuery` on top of this endpoint.

**Auth + isolation contract**: `withAuth` (rule #9), no role gate — any signed-in user reads their OWN history. The `WHERE user_id = ?` predicate in `app/api/credit/history/route.ts` is the only thing keeping one user's call log from leaking to another.

### `GET /api/credit/history`

Returns the signed-in user's `credit_usage_log` rows, ordered by `createdAt DESC`, paginated. Backs the Settings → Credits tab. Source rows: every `handleLLMEnd` (`status='success'`, with token counts + computed credits) and `handleLLMError` (`status='error'`, with the error message) row from `lib/credit/callback.ts`.

**Wire shape (200)**:

```ts
{
  calls: Array<{
    id: string; // uuid
    providerId: string; // "openai" | "anthropic" | ...
    modelName: string; // "gpt-4o-mini" | ...
    agentName: string; // "router" | "crypto" | "summarize" | ...
    inputTokens: number;
    outputTokens: number;
    credits: number; // numeric(12,4), exposed as JS number (4dp)
    status: "success" | "error";
    errorMessage: string | null; // populated when status === "error"
    createdAt: string; // ISO timestamp
  }>;
  total: number; // total row count for the user (used by the panel's "Load more" affordance)
}
```

|               |                                                                                 |
| ------------- | ------------------------------------------------------------------------------- |
| Query params  | `limit` (1..200, default 50), `offset` (>= 0, default 0). Coerced from strings. |
| 200 response  | the payload above                                                               |
| Failure codes | 400 `BAD_REQUEST` (invalid limit/offset). 401 `UNAUTHORIZED`.                   |

### `GET /api/credit/status`

Returns the signed-in user's current cap state. Backs the user-button dropdown's `CreditUsageSlot` and the Settings → Credits summary card. The client (`lib/credit/status.ts`) caches for 1s and collapses in-flight requests — see the module header for why that cadence matches the realistic "I want to see fresh data" need.

|               |                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | (none)                                                                                                                               |
| 200 response  | `{ used, limit \| null, windowHours \| null, resetAt, unlimited, roleName }` — `limit` and `windowHours` are `null` when `unlimited` |
| Failure codes | 401 `UNAUTHORIZED`                                                                                                                   |

## Proxy

| Endpoint             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANY /api/[...path]` | Node catch-all (`runtime = "nodejs"`) that forwards to `LANGGRAPH_API_URL` (the LangGraph dev server / production endpoint). `withAuth`-wrapped (rule #9) — anonymous traffic is rejected with 401 before any upstream hop. Strips hop-by-hop headers, adds CORS, sends `x-api-key`. Also injects the session's `userId` into the proxied body so `withMemoryRecall` and `CreditTrackingHandler` can attribute the run. See [`docs/CREDIT.md`](./CREDIT.md) § Where the cap is enforced for the per-turn credit gate. |

Behavior:

- **Auth gate** — `withAuth` runs before any upstream fetch. No session → 401 `UNAUTHORIZED`. (The previous build accepted anonymous traffic; any site's JS could create / list / delete threads through this proxy.)
- **Credit gate** — `POST / PUT / PATCH` triggers `checkCredit(user.id)` before the upstream `fetch`. If the rolling-window cap is reached, the proxy short-circuits with a synthetic SSE stream (`text/event-stream`) carrying one AI message with a `show_credit_card` tool_call — no LangGraph call, no `credit_usage_log` write. The assistant-ui SDK consumes the stream and `components/tool-ui/credit/credit-card.tsx` mounts inline in the thread. `GET` stays unchecked (reads only).
- **`userId` injection** — for `POST / PUT / PATCH` with a JSON body, the proxy injects `config.configurable.userId` and `config.metadata.userId` (= `ctx.user.id`) so the LangGraph SDK propagates the user through every `chatModel.invoke` call. Without this, `withMemoryRecall` would skip memory loading and `CreditTrackingHandler` would skip recording.
- **Header forwarding** — only `cookie` and `authorization` are forwarded (the two LangGraph consults). `x-api-key` is added from `LANGCHAIN_API_KEY` server-side. Everything else is dropped.
- **`OPTIONS`** — short-circuits to 204 with CORS headers (Better Auth / browser preflight).
- **Streaming passthrough** — `res.body` is forwarded as a `ReadableStream`; SSE for `runs.stream` / `runs.stream-log` keeps working because we never buffer it.

## Alchemy RPC

Server-side proxy so the Alchemy API key never reaches the browser. Implementation: `app/api/alchemy/[...path]/route.ts` + `app/api/alchemy/status/route.ts`. Allowlist source of truth: `lib/alchemy/networks.ts` (static catalog of every Alchemy-supported network). `ALCHEMY_DISABLED_NETWORKS` is an optional turn-off filter on top of the catalog.

| Endpoint                         | Purpose                                                                                                                                                                                | Response                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/alchemy/status`        | Reports whether `ALCHEMY_API_KEY` is set on the server. The actual key value is never included in the response — it only returns `{ configured: boolean }`.                            | `{ configured: true \| false }`                         |
| `POST /api/alchemy/<network>`    | Forwards a JSON-RPC body to `https://<network>.g.alchemy.com/v2/<ALCHEMY_API_KEY>`. The `<network>` slug must be in the catalog AND not in `ALCHEMY_DISABLED_NETWORKS`, otherwise 400. | Forwards upstream status + body. CORS headers attached. |
| `GET /api/alchemy/<network>`     | Same proxy path, used for Alchemy endpoints that take query params (e.g. `eth_getBlockByNumber` over GET). Same allowlist rules.                                                       | Forwards upstream status + body.                        |
| `OPTIONS /api/alchemy/<network>` | CORS preflight.                                                                                                                                                                        | 204 with `Access-Control-Allow-*` headers.              |

### Error responses (stable)

- `400 { error }` — network slug missing, not in the static catalog, or listed in `ALCHEMY_DISABLED_NETWORKS`.
- `500 { error }` — `ALCHEMY_API_KEY` is not configured on the server, or the upstream call threw.
- Upstream statuses (401 / 429 / 5xx) are passed through to the caller as-is, with the upstream body and `Retry-After` header preserved.

### Env contract

- `ALCHEMY_API_KEY` — server-only. The proxy reads it. Never reachable from the browser bundle.
- `ALCHEMY_DISABLED_NETWORKS` — server-only, optional, comma-separated Alchemy slugs the proxy will REJECT. Empty = every catalog network is enabled. The admin page (`/alchemy`) always shows the full catalog; a disabled network's Test button returns 400 so you can see at a glance what's turned off.

### Admin UI

`/alchemy` renders the full catalog grouped by L1 / L2 / testnets, with a status badge from `/api/alchemy/status` and a per-network **Test** button that runs `eth_blockNumber` through the proxy.

## Graph tools

The LangGraph `agent` graph exposes the following tools to the chat model. Both are read-only and run unconditionally — there is no per-call human approval prompt. Write tools added later should hang off their own node and pass `interruptBefore: ["<that-node>"]` to `compile()` so only the write path pauses for approval.

Implementation: `backend/tool/{web-fetch,web-search}.ts`. Shared key pool: `lib/jina.ts`.

### `search_web(query)`

Keyword / natural-language web search via Jina Search (`s.jina.ai`).

|               |                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ query: string }` — non-empty                                                                                                   |
| Output        | `{ query, results: Array<{ title, url, description }> }` (JSON string)                                                            |
| Auth          | Uses one key from `JINA_API_KEYS` (comma-separated in `.env.example`)                                                             |
| Failure modes | `500` from upstream → tool throws and the model reports the error; all keys exhausted → tool throws `"All N Jina keys exhausted"` |

### `fetch_url(url)`

Read a public web page and return it as markdown via Jina Reader (`r.jina.ai`).

|               |                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Input         | `{ url: string }` — must be a valid absolute URL with scheme                                                       |
| Output        | `{ title, content, url }` (JSON string; `content` is markdown)                                                     |
| Auth          | Same `JINA_API_KEYS` pool as `search_web`                                                                          |
| Failure modes | Non-2xx from upstream → tool throws with status code; URL validation failure → schema rejection before the request |

### Key pool semantics

`JINA_API_KEYS` is parsed once at module load into an in-memory pool. Each request picks a key at random. On `401` or `403`, the key is removed from the pool and the request retries with another random key. Up to N retries are attempted where N is the pool size at call start; once every key has rejected the same request, the tool throws. The pool is process-local and resets on LangGraph dev-server restart.

### `save_memory(patches)`

Persist structured facts to the user's long-term profile via RFC 6902 JSON Patch operations against `[userId,"profile"] main`. Implementation: `backend/tool/memory/save-memory-tool.ts`. Read counterpart (better-auth session / social accounts / thread summaries that the model already sees) is prepended to every model call by `withMemoryRecall` at `backend/middleware/with-memory-recall.ts`.

|                |                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input          | `{ patches: Array<MemoryPatch> }`. `MemoryPatch` discriminated union of `{op:"add", path, value}`, `{op:"replace", path, value}`, `{op:"remove", path}`. `move`/`copy`/`test` are rejected at the schema layer.              |
| Path shape     | RFC 6901. The profile is a flat k-v bag, so paths are constrained to `/[A-Za-z_][A-Za-z0-9_-]*` (object property names, NOT array indices).                                                                                  |
| Output         | `{ ok: true, bytes, keyCount }` (JSON string)                                                                                                                                                                                |
| Auth           | The `config.configurable.userId` arg passed to LangGraph — injected by the Next.js `/api/[..._path]` proxy after `withAuth`. Missing / empty userId **fails-fast**: throws `MissingUserIdError` (`code: "MISSING_USER_ID"`). |
| Size guard     | `MEMORY_PROFILE_MAX_BYTES` (default 8192) — measured post-patch against the serialized JSON. Failure throws `MemorySizeError` (`code: "MEMORY_SIZE_EXCEEDED"`) before any `store.put`.                                       |
| Patch validity | `replace` and `remove` ops on a path not present in the current profile throw `MemoryPatchError` (`code: "PATCH_FAILED"`) — silent no-op on a non-existent path is the failure mode this rule exists to avoid.               |
| Deletion UX    | No separate `forget_memory` tool — to forget a fact, the user removes it from the Memory settings tab (which calls `DELETE /api/memory/profile/[key]`).                                                                      |

## Crypto tools

The crypto sub-agent (`CRYPTO_AGENT_PROMPT` in `backend/prompt/system.ts`) drives the swap flow. The wallet is only used to identify the user — `place_crypto_order` does **not** read on-chain balances. The simulated flow auto-funds every user with 10,000 Mock Coin (MC, pegged 1:1 to USD) on the first trade, and the receive-side token is priced via live CoinGecko USD. There is no real signing and no on-chain broadcast in the current default path.

### `get_crypto_price(ids, vs_currency?)`

Read-only price lookup via CoinGecko's public `/coins/markets`. Used to render the price card. Has a 60s in-memory cache to stay under the free-tier rate limit.

|               |                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ ids: string[], vs_currency?: string }` — CoinGecko coin ids (e.g. `["bitcoin", "ethereum"]`); defaults to `"usd"` |
| Output        | `{ success: true, coins: [...] }` (JSON string) — normalized list with price, 24h change, 7d sparkline, market cap   |
| Auth          | None (CoinGecko public endpoint)                                                                                     |
| Failure modes | Non-2xx → `{ success: false, error }` carrying the upstream status. No retries.                                      |

### `get_fx_rate(from, to)`

Read-only FX lookup via frankfurter.app (ECB-sourced). Has a 60s in-memory cache. Currently unused by the wallet-token flow (fiat amounts are rejected) but kept for the chat agent's general knowledge lookups.

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Input         | `{ from: string, to: string }` — 3-letter ISO codes, case-insensitive |
| Output        | `{ success: true, from, to, rate, date }`                             |
| Failure modes | Non-2xx → `{ success: false, error }` with the upstream status.       |

### `get_token_balances(chainId, address)`

**Not currently exposed to the LLM.** Listed here for reference only — the file and tests are kept in `backend/tool/crypto/get-token-balances.ts` for direct programmatic use, but `CRYPTO_TOOLS` does not register it. The wallet's address is not in the LLM's context (it lives in wagmi/RainbowKit on the frontend), so the agent has no way to call this tool without inventing an address. The simulated `place_crypto_order` flow does not consult on-chain balances — every user is auto-funded with Mock Coin. If you want to re-enable this tool, register it in `backend/tool/index.ts` and update `CRYPTO_AGENT_PROMPT` step 2.

### `get_NFT_holdings(address)`

Read-only. Lists the NFT holdings of an EVM wallet across Ethereum, Arbitrum, Optimism, Base, and Polygon. Calls Alchemy's Portfolio API `nfts/by-address` directly from the server (uses `ALCHEMY_API_KEY`).

|               |                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ address: string }` — 0x-prefixed 40-hex chars. Case-insensitive. The LLM pulls this from the user's message or the most recent `connect_wallet` ToolMessage — never invents.                                                                                         |
| Output        | `{ success: true, address, totalCount, nfts: Array<{ contractAddress, contractName, collectionName, collectionSlug, contractImageUrl, network, tokenId, tokenType, name, thumbnailUrl, cachedUrl, contentType, balance, totalSupply, floorPriceEth }> }` (JSON string). |
| Auth          | None from the LLM's perspective. Server reads `ALCHEMY_API_KEY`.                                                                                                                                                                                                        |
| Failure modes | Missing / malformed address → zod-style rejection. Missing `ALCHEMY_API_KEY` → `{ success: false, error }`. Alchemy 4xx/5xx → `{ success: false, error: "alchemy N: ..." }`. Empty list → `{ success: true, nfts: [] }`, not an error.                                  |

The tool always sends `excludeSpam: true` plus an in-house name filter (`claim | airdrop | visit | gift | giveaway | voucher | reward | drop | bonus`) — Alchemy's own spam classifier leaves a lot of airdrop-bait through, and this regex catches the obvious patterns (yield-eth.net, USDC vouchers, etc.). Items whose contract name OR per-token name matches the regex are dropped from the response. Pagination via `pageKey` is handled internally (capped at 20 pages so a pathological wallet can't spin).

### `connect_wallet(message?)`

Wallet-authorization interrupt. Pauses via `interrupt()`; the frontend card opens RainbowKit, then resumes with `{address, chainId}` from wagmi. That becomes the ToolMessage content the LLM reads. Subsequent tools (`place_crypto_order`, `get_order_status`) auto-infer the address from wagmi state — the LLM does not need to thread an address through the schema.

|               |                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input         | `message?` (string) — short prompt shown above the Connect button. Defaults to `"Connect your wallet to continue."` if omitted.                        |
| Output        | `{ address: 0x...string, chainId: number }` (success) or `{ error: string }` (user cancelled / wallet not installed). Becomes the ToolMessage content. |
| Failure modes | User closes RainbowKit modal without connecting → no resume → turn does not progress. The card stays in the "Connect" state until the user reconnects. |

### `place_crypto_order(side, source_coin_id?, amount?, target_coin_id?)`

Simulated swap interrupt. Pauses via `interrupt()`; the frontend card reads the wallet from wagmi (auto-inferred from the most recent `connect_wallet` ToolMessage — never pass an address), spends from the auto-funded Mock Coin balance (10,000 MC, pegged 1:1 to USD), prices the receive-side token via live CoinGecko USD (with a hardcoded fallback table in `lib/prices/coingecko.ts` when CoinGecko is unreachable), polls the price every 30s with a visible countdown, lets the user pick slippage + simulated gas tier (gas is converted to MC at the live ETH/USD price the quote already loaded), and exposes one Place simulated order button. On click, the card synthesizes an order — no real signing, no real DEX POST. The closing ToolMessage is what the LLM uses to write the final sentence.

|                |                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input          | `side` (required, `"buy"` or `"sell"`) — `"sell my X"` / `"swap X for Y"` → sell; `"buy Y with X"` → buy. `source_coin_id?` (CoinGecko id) when the user named a source. `amount?` (positive number) when the user named a quantity. `target_coin_id?` when the user named what to receive. |
| Output         | `{ status: "simulated_filled", order: { id, coin, symbol, side, amount_human, qty, status, timestamp, note, slippage_bps } }` (success) or `{ status: "cancelled" }` (Cancel clicked) or `{ status: "error", error: string }` (price fetch failed and no fallback matched).                 |
| Failure modes  | Malformed CoinGecko id → zod rejection. Id not in `lib/tokens/catalog.ts` → zod rejection. Non-positive or NaN `amount` → zod rejection. CoinGecko 4xx/5xx surfaces inside the card as a fallback-priced quote; the user can still click Cancel.                                            |
| Missing source | The LLM does not pass a source — the card always spends from Mock Coin regardless of what the user names. The LLM does not need to verify wallet holdings before calling.                                                                                                                   |

### `get_order_status(order_uid, chain_id)`

Order-status interrupt. Pauses via `interrupt()`; the frontend card shows the order uid + chain and exposes one Check button. This is a simulated-order demo — the synthetic uid from `place_crypto_order` isn't a real on-chain order, so on click the card synthesizes a status (`filled` for the demo path) and returns it via the resume.

|               |                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `order_uid` (required, non-empty string) — the order uid returned by `place_crypto_order`. `chain_id` (required, integer) — EVM chain id where the order was placed: 1, 42161, 8453, or 11155111. |
| Output        | `{ status: "filled" \| "open" \| "partially_filled" \| "cancelled" \| "expired" \| "not_found", order_uid, chain_id, filled_buy_amount?, executed_at? }`.                                         |
| Failure modes | Empty `order_uid` or non-numeric `chain_id` → zod rejection.                                                                                                                                      |
