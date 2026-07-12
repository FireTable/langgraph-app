# Credit

Every LLM call costs **credit** — a unitless accounting value computed from input + output token counts and the per-model rates registered in the admin's `provider.models[]` config. The cap is enforced at the call boundary (not after the fact) via a LangChain callback wired into the compiled graph; the same callback records every call into `credit_usage_log` for the user-facing call history.

Credit is **not** token billing. One assistant turn with a router + sub-agent + summary can fire three LLM calls and consume three separate chunks of credit, all independently capped and logged. The user is never charged in tokens; the rate config is admin-tunable and opaque to the model.

## Roles & caps

Three roles ship in the migration seed (`db/migrations/0003_*.sql`):

| `id`    | `name` | `creditLimit` | `windowHours` |
| ------- | ------ | ------------- | ------------- |
| `guest` | Guest  | 20            | 24            |
| `user`  | User   | 200           | 24            |
| `admin` | Admin  | `null`        | 24            |

`user.roleId` (`lib/auth/schema.ts`) points at `role.id` via FK; Better Auth exposes `roleId` on the session via `additionalFields` (see [`docs/AUTH.md`](./AUTH.md) § Role mechanism). The default for new signups is `"user"`. The first admin is bootstrapped via `INITIAL_ADMIN_EMAIL` (see [`docs/AUTH.md`](./AUTH.md) § Bootstrap admin).

### Calendar-aligned rolling-window model

`creditLimit` is **per `windowHours`**, with windows bucketed at UTC multiples of `windowHours` from the Unix epoch. For `windowHours=24` the bucket is the UTC day; for `windowHours=8` the buckets are UTC 00:00 / 08:00 / 16:00; for any other `N` they're UTC 00:00 / N / 2N / ... On every LLM call, `lib/credit/check.ts` runs:

```sql
-- windowStart = floor(now() / windowHours-hours) * windowHours-hours
SELECT COALESCE(SUM(credits), 0) AS used
FROM   credit_usage_log
WHERE  user_id = $1 AND status = 'success'
       AND created_at >= $windowStart  -- bound by JS-side floor
```

The cap holds iff `SUM(credits) < creditLimit`. `resetAt` is `windowStart + windowHours` — the next UTC-aligned boundary. Both `windowStart` (the SQL bound) and `resetAt` (the API payload) are derived from the same JS-side moment so they can't drift. Display components (`toLocaleTimeString` on the client) render `resetAt` in the user's **browser** timezone, so a UTC+8 user sees the UTC 16:00 boundary as "00:00", a UTC-8 user sees it as "08:00", etc. — same moment, localized. When the user goes over, the next call throws `CreditExceededError` carrying that `resetAt`, surfaced to the user via a friendly assistant message written by the graph node that caught the throw.

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

Single source of truth: **`lib/credit/callback.ts`'s `CreditTrackingHandler`**. It's a `BaseCallbackHandler` instantiated as a process-wide singleton in `backend/callbacks.ts` (`creditTrackingHandler`) and wired into every compiled graph via `compile({ callbacks: [..., creditTrackingHandler] })` (see `backend/agent.ts`). Every LangGraph node that calls an LLM fires the callback's `handleLLMStart` (pre-call) and `handleLLMEnd` / `handleLLMError` (post-call). The handler is the only writer of `credit_usage_log`. The singleton lives in `backend/callbacks.ts` rather than `backend/agent.ts` so the background_agent graph (and any future graph) shares the same in-memory `runMeta` map — see `backend/callbacks.ts` header comment for the rationale.

Lifecycle:

1. **`handleLLMStart`** — read `metadata.userId`; if absent, skip (admin tooling, internal calls). Otherwise call `checkCredit(userId)`. If `!status.allowed`, throw `CreditExceededError` carrying `resetAt`, `limit`, `used`. LangChain converts the throw into `handleLLMError`; the throwing node catches it and writes a friendly assistant message to the thread instead of bubbling the error out of the graph.
2. **`handleLLMEnd`** — read token usage from `LLMResult` (probing `llmOutput.tokenUsage` / `.usage` then `generation[0][0].message.usage_metadata` — LangChain has shifted these shapes between minors). If usage is present and metadata has `providerId` / `modelName`, compute credits + write a `status='success'` row.
3. **`handleLLMError`** — if metadata has `providerId` / `modelName` AND the error is NOT a `CreditExceededError` (which short-circuits — no LLM call happened, don't pollute the log), write a `status='error'` row with `errorMessage`.

Why a callback and not a per-node `invokeWithCredit` wrapper:

- There's no way to forget the wrapper — every `ChatModel.invoke()` in the graph fires this regardless of who calls it (router, sub-agents, future agents, tools).
- Token usage comes from the LangChain result object the same way observability does, so the credit log and the spans see identical numbers.

## Metadata contract

Every `chatModel.invoke(messages, { metadata: { ... } })` in the graph **must** pass four fields:

```ts
{
  userId: string; // pulled off config.configurable.userId (same pattern as memory/recall)
  providerId: string; // "openai" / "anthropic"
  modelName: string; // "gpt-4o-mini"
  agentName: string; // "router" / "crypto" / "summarize" / ...
}
```

Nodes that skip these fields won't get cap enforcement. Specifically:

- Missing `userId` → `handleLLMStart` skips the credit check, the handler treats it as a non-user-facing call (admin tooling, internal prompts) and writes no log row. This is intentional — internal calls shouldn't count against the user's cap.
- Missing `providerId` or `modelName` → `handleLLMEnd` / `handleLLMError` skip the `recordLlmCall` write. The LLM call still goes through (LangChain doesn't know about our schema), but no row is recorded — meaning the call ALSO doesn't count toward the cap. This is the silent bug to watch for: a node that forgets metadata would let users burn unlimited credits.
- Missing `agentName` → defaulted to `"unknown"` at write time (the credit log stays accurate, but agent-name breakdowns lose fidelity).

`providerId` and `modelName` are typically hardcoded in the node that builds the chat model (mirroring `backend/model.ts`'s `ChatOpenAI` construction). `userId` is the one runtime-injected field.

## Failure modes

### LLM error (provider 4xx/5xx, network timeout, etc.)

`handleLLMError` writes a `status='error'` row with `errorMessage` set to the thrown error's message. The row is **excluded** from the cap SUM (`checkCredit` filters `status = 'success'`), so users don't pay for upstream flakiness. The row IS visible in the call history (the Settings → Credits tab shows them with a red status badge).

### User over cap

`handleLLMStart` throws `CreditExceededError` BEFORE the LLM call. LangChain converts the throw into `handleLLMError` — which has a special-case `if (err instanceof CreditExceededError) return;` so no row is written (no LLM call happened). The throwing node catches the error and writes a friendly assistant message to the thread, e.g. "You've used 200/200 credits in the last 24 hours — try again at <resetAt>." The graph continues; the next turn still gets re-checked.

### Admin

`creditLimit IS NULL` short-circuits `checkCredit` — cap check skipped, `used: 0`, `limit: Number.POSITIVE_INFINITY` on the returned status. The handler still records `status='success'` rows against admin calls; the SUM just doesn't apply. This matters for analytics: every LLM call shows up in the log, but admins never get a credit-exceeded throw.

## API for users

### `GET /api/credit/history`

Returns the signed-in user's `credit_usage_log` rows, ordered by `createdAt DESC`, paginated. Backs the Settings → Credits tab (`useInfiniteQuery` over this endpoint). See [`docs/APIS.md`](./APIS.md) § Credit history for the full wire shape.

|               |                                                                                |
| ------------- | ------------------------------------------------------------------------------ |
| Query params  | `limit` (1..200, default 50), `offset` (≥ 0, default 0). Coerced from strings. |
| 200 response  | `{ calls: CallRow[], total: number }` — see APIS for full row shape.           |
| Failure codes | 400 `BAD_REQUEST` (invalid limit/offset), 401 `UNAUTHORIZED`.                  |

**Isolation contract**: `withAuth` (rule #9), no role gate — any signed-in user reads their OWN history. Cross-user isolation is enforced by the `eq(credit_usageLog.userId, session.user.id)` predicate; without that WHERE, the count and rows would leak other users' call logs. The handler is the only place this check matters; there is no admin read-all endpoint today (an `/api/admin/credit/history` aggregator is a follow-up).

## See also

- [`docs/ADMIN.md`](./ADMIN.md) — admin UI for managing providers + roles (where `creditLimit` / `windowHours` are edited).
- [`docs/AUTH.md`](./AUTH.md) — `INITIAL_ADMIN_EMAIL` bootstrap + `additionalFields.roleId` plumbing.
- [`docs/DB.md`](./DB.md) — `role`, `credit_usage_log` schema, the `(user_id, created_at)` composite index that backs both the cap check and the history pagination.
- [`docs/APIS.md`](./APIS.md) — `GET /api/credit/history` endpoint reference.
