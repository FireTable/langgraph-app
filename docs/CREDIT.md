# Credit

Every LLM call costs **credit** — a unitless accounting value computed from input + output token counts and the per-model rates registered in the admin's `provider.models[]` config. The cap is enforced at the **HTTP proxy boundary** (the browser → Next.js edge of every LangGraph SDK call), not inside the LangGraph process. The same cap check is what powers `GET /api/credit/status` (the user-facing slot in the user-button dropdown) and `GET /api/credit/history` (the Settings → Credits tab).

Credit is **not** token billing. One assistant turn with a router + sub-agent + summary can fire three LLM calls and consume three separate chunks of credit, all independently recorded into `credit_usage_log`. The user is never charged in tokens; the rate config is admin-tunable and opaque to the model.

## Roles & caps

Three roles ship in the migration seed (`db/migrations/0003_*.sql`):

| `id`    | `name` | `creditLimit` | `windowHours` |
| ------- | ------ | ------------- | ------------- |
| `guest` | Guest  | 20            | 24            |
| `user`  | User   | 200           | 24            |
| `admin` | Admin  | `null`        | 24            |

`user.roleId` (`lib/auth/schema.ts`) points at `role.id` via FK; Better Auth exposes `roleId` on the session via `additionalFields` (see [`docs/AUTH.md`](./AUTH.md) § Role mechanism). The default for new signups is `"user"`. The first admin is bootstrapped via `INITIAL_ADMIN_EMAIL` (see [`docs/AUTH.md`](./AUTH.md) § Bootstrap admin).

### Calendar-aligned rolling-window model

`creditLimit` is **per `windowHours`**, with windows bucketed at UTC multiples of `windowHours` from the Unix epoch. For `windowHours=24` the bucket is the UTC day; for `windowHours=8` the buckets are UTC 00:00 / 08:00 / 16:00; for any other `N` they're UTC 00:00 / N / 2N / ... On every cap check, `lib/credit/check.ts:checkCredit` runs:

```sql
-- windowStart = floor(now() / windowHours-hours) * windowHours-hours
SELECT COALESCE(SUM(credits), 0) AS used
FROM   credit_usage_log
WHERE  user_id = $1 AND status = 'success'
       AND created_at >= $windowStart  -- bound by JS-side floor
```

The cap holds iff `SUM(credits) < creditLimit`. `resetAt` is `windowStart + windowHours` — the next UTC-aligned boundary. Both `windowStart` (the SQL bound) and `resetAt` (the API payload) are derived from the same JS-side moment so they can't drift. Display components (`toLocaleTimeString` on the client) render `resetAt` in the user's **browser** timezone, so a UTC+8 user sees the UTC 16:00 boundary as "00:00", a UTC-8 user sees it as "08:00", etc. — same moment, localized. When the user is over, the proxy serves a synthetic SSE stream with a `show_credit_card` tool_call carrying that `resetAt`; the chat UI renders the credit-limit-reached card inline in the thread.

`windowHours` is capped at `720` (30 days) in the Zod schema. `0` is rejected; `null` is rejected. The `admin` role ships with `creditLimit = null` (= unlimited, see [`lib/credit/check.ts:checkCredit`](./../lib/credit/check.ts) — short-circuits the SUM entirely).

## How a credit is computed

For each successful LLM call:

```
credits = (inputTokens  / 1000) * inputPer1k
        + (outputTokens / 1000) * outputPer1k
```

`inputPer1k` and `outputPer1k` come from `provider.models[].inputPer1k` / `outputPer1k` (admin-managed). The result is **frozen** into `credit_usage_log.credits` at call time (`numeric(12, 4)` — 12 total digits, 4 after the decimal point, exposed as a JS `number` on the wire).

A rate change after the fact does **not** retroactively recompute historical rows. The semantics are deliberate: "this call cost X credits at the time it happened" is the audit story; backfilling would change the past and break reconciliation against provider invoices. A future backfill script could rewrite historical rows in place — the `updatedAt` column lets such a script identify touched rows.

The function (`lib/credit/charge.ts:computeCredits`) is pure and unit-testable without a DB — pass the usage object + the rate config directly.

## Where the cap is enforced

Single source of truth: **`app/api/[..._path]/route.ts`** (the LangGraph SDK proxy). Every `POST / PUT / PATCH` to `/api/<rest>` triggers `checkCredit(ctx.user.id)` BEFORE the upstream `fetch` to `LANGGRAPH_API_URL`:

- If `allowed === true`: the request is forwarded unchanged. LangGraph runs as normal, and any LLM calls it makes are recorded by `CreditTrackingHandler` (see below).
- If `allowed === false`: the proxy **short-circuits** — it never calls LangGraph. Instead it synthesizes a tiny SSE stream that mirrors LangGraph's wire shape (`metadata` event → `messages/partial` carrying a single AI message with a `show_credit_card` tool_call → `end`). The assistant-ui SDK consumes this stream and the `show_credit_card` render in `components/tool-ui/toolkit.tsx` mounts the inline credit-limit-reached card (`components/tool-ui/credit/credit-card.tsx`) with `used`, `limit`, `windowHours`, `resetAt`. No model invocation, no `credit_usage_log` write — the blocked turn doesn't burn tokens.

Why at the proxy and not in the LangGraph callback:

- A callback `throw` would only fail the bookkeeping step (LangChain's CallbackManager swallows throws from `handleLLMStart`); the LLM call still proceeds.
- Per-LLM-call enforcement inside the graph would still leave the SDK's first round-trip on the wire. Gating at the proxy blocks the call before bytes leave the Next.js process.
- The proxy's job is to gate token spend, not to know exactly which endpoints spend it — a single POST/PUT/PATCH rule covers `runs.create`, `runs.stream`, and any future write endpoint without a per-path allowlist.

## Where the log is written

`lib/credit/callback.ts` (`CreditTrackingHandler`) is a `BaseCallbackHandler` instantiated as a process-wide singleton in `backend/callbacks.ts` (`creditTrackingHandler`) and wired into every compiled graph via `compile({ callbacks: [capturingHandler, creditTrackingHandler] })` (see `backend/agent.ts` + `backend/background-agent.ts`). It is the **only** writer of `credit_usage_log`. The singleton lives in `backend/callbacks.ts` rather than `backend/agent.ts` so the `background_agent` graph (and any future graph) shares the same in-memory `runMeta` map.

Lifecycle:

1. **`handleLLMStart`** — read `metadata.userId`; cache a `RunMeta` keyed by `runId`. If `userId` is absent, skip (admin tooling, internal calls). The callback does **not** enforce the cap — see § Where the cap is enforced above.
2. **`handleLLMEnd`** — read token usage from `LLMResult` (probing `llmOutput.tokenUsage` / `.usage` then `generation[0][0].message.usage_metadata` — LangChain has shifted these shapes between minors). Look up `RunMeta` by `runId`, then `findProviderId({ baseUrl, modelName })` from `lib/credit/build-model.ts`, then `getModelRate`, then `computeCredits` + `recordLlmCall(status='success')`.
3. **`handleLLMError`** — same `RunMeta` lookup. Writes a `status='error'` row with `errorMessage`. A `CreditExceededError` (if ever thrown) would short-circuit — but as of today, no caller throws it, so this branch only fires on real LLM failures (provider 4xx/5xx, network timeout, etc.).

The `runMeta` map is necessary because `handleLLMEnd` / `handleLLMError` don't reliably receive `metadata` or `llm` in real LangChain runtime — only `handleLLMStart` does. Caching by `runId` is the only way to carry `userId` + `agentName` + `baseURL` across the three hooks.

## Metadata contract

Every `chatModel.invoke(messages, { metadata: { ... } })` in the graph **should** pass `userId` so the handler can attribute the call:

```ts
{
  userId: string; // pulled off config.configurable.userId (same pattern as memory/recall)
  providerId: string; // optional — handler can derive from baseUrl/modelName via findProviderId
  modelName: string; // optional — same
  agentName: string; // optional — handler falls back to metadata.langgraph_node; "unknown" if missing
}
```

Consequences of missing fields:

- Missing `userId` → `handleLLMStart` skips the entire pipeline (no cache, no `recordLlmCall`). The LLM call still goes through — the cap is enforced separately at the proxy. Internal / admin / test calls intentionally don't carry `userId` so they don't write to the log.
- Missing `agentName` → defaulted from `metadata.langgraph_node` (the LangGraph auto-injected field); "unknown" only as a last resort.

## Failure modes

### LLM error (provider 4xx/5xx, network timeout, etc.)

`handleLLMError` writes a `status='error'` row with `errorMessage` set to the thrown error's message. The row is **excluded** from the cap SUM (`checkCredit` filters `status = 'success'`), so users don't pay for upstream flakiness. The row IS visible in the call history (the Settings → Credits tab shows them with a red status badge).

### User over cap

The proxy serves the synthetic `show_credit_card` SSE stream described above. No `credit_usage_log` row is written for the blocked turn (the LLM was never called). The card renders inline in the thread alongside prior turns, and the next turn still gets re-checked.

### Admin

`creditLimit IS NULL` short-circuits `checkCredit` — cap check skipped, `used: 0`, `limit: Number.POSITIVE_INFINITY` on the returned status. The handler still records `status='success'` rows against admin calls; the SUM just doesn't apply. This matters for analytics: every LLM call shows up in the log, but admins never get a credit-blocked response.

## APIs for users

### `GET /api/credit/status`

Returns the signed-in user's current cap state. Backs the user-button dropdown's `CreditUsageSlot` (`components/auth/user/credit-usage-slot.tsx`) and the Settings → Credits summary card. The client (`lib/credit/status.ts`) caches the response for 1 second and collapses in-flight requests — see the module header for why that cadence matches the realistic "I want to see fresh data" need.

|               |                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | (none)                                                                                                                               |
| 200 response  | `{ used, limit \| null, windowHours \| null, resetAt, unlimited, roleName }` — `limit` and `windowHours` are `null` when `unlimited` |
| Failure codes | 401 `UNAUTHORIZED`                                                                                                                   |

### `GET /api/credit/history`

Returns the signed-in user's `credit_usage_log` rows, ordered by `createdAt DESC`, paginated. Backs the Settings → Credits tab (`useInfiniteQuery` over this endpoint). See [`docs/APIS.md`](./APIS.md) § Credit history for the full wire shape.

|               |                                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| Query params  | `limit` (1..200, default 50), `offset` (≥ 0, default 0). Coerced from strings. |
| 200 response  | `{ calls: CallRow[], total: number }` — see APIS for full row shape.           |
| Failure codes | 400 `BAD_REQUEST` (invalid limit/offset), 401 `UNAUTHORIZED`.                  |

**Isolation contract**: `withAuth` (rule #9), no role gate — any signed-in user reads their OWN history. Cross-user isolation is enforced by the `eq(credit_usageLog.userId, session.user.id)` predicate; without that WHERE, the count and rows would leak other users' call logs. There is no admin read-all endpoint today (an `/api/admin/credit/history` aggregator is a follow-up).

## See also

- [`docs/ADMIN.md`](./ADMIN.md) — admin UI for managing providers + roles (where `creditLimit` / `windowHours` are edited).
- [`docs/AUTH.md`](./AUTH.md) — `INITIAL_ADMIN_EMAIL` bootstrap + `additionalFields.roleId` plumbing.
- [`docs/DB.md`](./DB.md) — `role`, `credit_usage_log` schema, the `(user_id, created_at)` composite index that backs both the cap check and the history pagination.
- [`docs/APIS.md`](./APIS.md) — `/api/credit/*` endpoint reference.
