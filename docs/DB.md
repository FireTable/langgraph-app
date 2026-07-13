# Database schema

Source of truth: `db/migrations/0000_*.sql` (drizzle-kit generated). This doc describes what each table is for and which code paths touch it.

## Tables

| Table              | Owner | Purpose                                                                |
| ------------------ | ----- | ---------------------------------------------------------------------- |
| `user`             | app   | Better Auth user rows; FK target for owned rows                        |
| `session`          | app   | Better Auth DB sessions (cookie → userId)                              |
| `account`          | app   | Better Auth credentials / OAuth links per user                         |
| `verification`     | app   | One-time tokens (email verify, password reset)                         |
| `role`             | app   | Per-role credit cap + rolling window length                            |
| `threads`          | app   | Chat threads; one row per assistant-ui thread                          |
| `attachments`      | app   | Chat attachment metadata; bytes live in Cloudflare R2                  |
| `provider`         | app   | LLM provider registry (API keys, model rates)                          |
| `credit_usage_log` | app   | Append-only per-LLM-call log; drives cap enforcement + call history UI |

## Cascade behavior

`user.id` is the cascade root. Deleting a user removes every `session`, `account`, `thread`, `attachment`, and `credit_usage_log` row they own. `attachments` has no FK to `threads` (Q3 — see `docs/ATTACHMENTS.md` for why), so thread deletion does NOT clean up attachment rows. Use the retention sweep if those accumulate. No soft delete; CASCADE only.

`role` deletion is refused at the API layer (`409 ROLE_IN_USE`) while any user row still references it — the schema's FK is `ON DELETE NO ACTION`, so the API check is what surfaces the conflict before the constraint trips. `provider` deletion is unconstrained (no FK from `credit_usage_log.provider_id` — see `provider` notes above).

## `user`

| Column           | Type         | Notes                                                                                                                                                                                 |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | text PK      | Better Auth user id                                                                                                                                                                   |
| `name`           | text NULL    | Display name                                                                                                                                                                          |
| `email`          | text UNIQUE  | Login + verify target                                                                                                                                                                 |
| `email_verified` | bool         | Gates redirect to `/chat`                                                                                                                                                             |
| `image`          | text NULL    | Avatar URL                                                                                                                                                                            |
| `role_id`        | text FK→role | `DEFAULT 'user'`; Better Auth exposes it on `session.user.roleId` via `additionalFields`                                                                                              |
| `banned`         | bool         | `DEFAULT false` (migration 0004). New signins blocked at `session.create.before`; ban toggle in admin UI DELETEs all sessions for the user so the cutoff is immediate on next request |
| `created_at`     | timestamptz  |                                                                                                                                                                                       |
| `updated_at`     | timestamptz  | `$onUpdate`                                                                                                                                                                           |

## `session`

| Column       | Type         | Notes                      |
| ------------ | ------------ | -------------------------- |
| `id`         | text PK      | Better Auth session id     |
| `token`      | text UNIQUE  | Cookie value               |
| `expires_at` | timestamp    | Better Auth rotates on use |
| `user_id`    | text FK→user | CASCADE on user delete     |
| `ip_address` | text NULL    |                            |
| `user_agent` | text NULL    |                            |

Indexed: `session_userId_idx` on `user_id` (for ownership lookups during cleanup).

## `account`

| Column                                                 | Type           | Notes                                            |
| ------------------------------------------------------ | -------------- | ------------------------------------------------ |
| `id`                                                   | text PK        | Better Auth account id                           |
| `provider_id`                                          | text           | `"credential"` for email/password, `"github"`, … |
| `account_id`                                           | text           | Provider-side user id                            |
| `user_id`                                              | text FK        | CASCADE on user delete                           |
| `access_token` / `refresh_token` / `id_token`          | text NULL      | OAuth only                                       |
| `access_token_expires_at` / `refresh_token_expires_at` | timestamp NULL | OAuth only                                       |
| `scope`                                                | text NULL      | OAuth scopes                                     |
| `password`                                             | text NULL      | bcrypt hash for `provider_id="credential"`       |

Indexed: `account_userId_idx` on `user_id`.

## `verification`

| Column       | Type      | Notes                    |
| ------------ | --------- | ------------------------ |
| `id`         | text PK   |                          |
| `identifier` | text      | Usually the user's email |
| `value`      | text      | Token / OTP              |
| `expires_at` | timestamp | Single-use               |

Indexed: `verification_identifier_idx` on `identifier` (Better Auth lookup).

No FK to `user` — verification rows are written before the user exists (sign-up flow).

## `threads`

| Column            | Type         | Notes                                                      |
| ----------------- | ------------ | ---------------------------------------------------------- |
| `id`              | text PK      | UUIDv4 — required by LangGraph `/threads/[id]/*`           |
| `user_id`         | text FK→user | CASCADE; every thread belongs to exactly one user          |
| `title`           | text         | `DEFAULT 'New Chat'`; renamed by graph `renameThread` node |
| `status`          | text         | `"regular"` \| `"archived"`; `DEFAULT 'regular'`           |
| `custom`          | jsonb        | `DEFAULT '{}'`; free-form per-thread metadata              |
| `created_at`      | timestamptz  |                                                            |
| `updated_at`      | timestamptz  | `$onUpdate`; bumped on title/status/custom edits           |
| `last_message_at` | timestamptz  | Bumped by `afterAgent` graph node on every reply           |

Indexes:

- `threads_status_updated_idx` `(status, updated_at DESC)` — drives the thread sidebar list
- `threads_status_last_message_idx` `(status, last_message_at DESC)` — reserved for future "recent activity" sort
- `threads_user_id_idx` `(user_id)` — supports `eq(threads.userId, userId)` lookups in every `*ForUser` query

## `attachments`

Bytes live in Cloudflare R2 — this table is the source of truth for the URL the renderer hands the model. One row per uploaded file. Lifecycle:

- `POST /api/attachments/presign` → INSERT row with `status='pending'`, `size_bytes` from request
- Browser PUTs bytes directly to R2 (presigned URL)
- `POST /api/attachments/[id]/confirm` → `HeadObject` size check, then `UPDATE status='uploaded', confirmed_at=now()`
- `DELETE /api/attachments/[id]` → DELETE row + `DeleteObject` on R2

| Column         | Type             | Notes                                                    |
| -------------- | ---------------- | -------------------------------------------------------- |
| `id`           | text PK          | 12-char nanoid; also embedded in the R2 key              |
| `user_id`      | text FK→user     | CASCADE on user delete                                   |
| `r2_key`       | text             | `u/<userId>/<nanoid>-<safe-filename>`                    |
| `name`         | text             | Original (sanitized) filename                            |
| `content_type` | text             | MIME type — restricted to `R2_ALLOWED_CONTENT_TYPES`     |
| `size_bytes`   | bigint           | Claimed at presign, verified via `HeadObject` at confirm |
| `status`       | enum             | `pending` \| `uploaded`                                  |
| `created_at`   | timestamptz      |                                                          |
| `confirmed_at` | timestamptz NULL | Stamped at confirm                                       |

No `thread_id` or `message_id` column by design (Q3): the renderer reads content parts directly off the message (`{ type: "image", image: publicUrl }` is embedded by `send()`), so the `attachments` table only tracks upload metadata for retention sweeps + dedup. See `docs/ATTACHMENTS.md` for the full reasoning.

Indexes:

- `attachments_user_created_idx` `(user_id, created_at DESC)` — "list this user's recent uploads" + retention sweep target

## `role`

Per-tier credit cap. Referenced by `user.role_id` (FK) and read on every LLM call by `lib/credit/check.ts:checkCredit`. Three rows ship in the migration seed: `guest` (20 credits / 24h), `user` (200 credits / 24h), `admin` (`null` credit limit = unlimited, 24h window). Migration adds the FK AFTER the seed INSERT so existing user rows have a target.

| Column         | Type         | Notes                                                   |
| -------------- | ------------ | ------------------------------------------------------- |
| `id`           | text PK      | `^[a-z0-9_-]+$` (e.g. `"guest"`, `"user"`, `"admin"`)   |
| `name`         | text         | Human-readable display name                             |
| `credit_limit` | integer NULL | `null` = unlimited (admin). Otherwise non-negative int. |
| `window_hours` | integer      | `DEFAULT 24`, rolling-window length in hours (max 720)  |
| `created_at`   | timestamptz  |                                                         |
| `updated_at`   | timestamptz  | `$onUpdate` (admin edits bump this)                     |

Notes:

- `creditLimit IS NULL` short-circuits the cap check in `lib/credit/check.ts` — admins never see a credit-blocked response.
- DELETE refuses with 409 `ROLE_IN_USE` from `app/api/admin/roles/[id]/route.ts` while any user row still references the role.
- `windowHours` is **UTC-aligned** — the cap window is bucketed at multiples of `windowHours` from the Unix epoch (which lands on UTC midnight), so `windowHours=24` gives the UTC-day boundary and `windowHours=8` gives UTC 00:00 / 08:00 / 16:00. See [`docs/CREDIT.md`](./CREDIT.md) § Calendar-aligned rolling-window model.

## `provider`

LLM provider registry — one row per upstream (openai / anthropic / ...). Holds the encrypted API key pool + per-model rate config. All edits go through `/api/admin/providers/**`. The migration seeds one `default` row, encrypted-blob-prefilled from `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` by the migration runner (see `scripts/db-migrate.ts`).

| Column       | Type        | Notes                                                                                   |
| ------------ | ----------- | --------------------------------------------------------------------------------------- |
| `id`         | text PK     | `^[a-z0-9_-]+$` (e.g. `"openai"`, `"anthropic"`)                                        |
| `name`       | text        | Display name                                                                            |
| `enabled`    | bool        | `DEFAULT true`; a top-level kill-switch (model-level `enabled` lives inside `models[]`) |
| `base_url`   | text        | OpenAI-compatible endpoint URL — one per provider, shared across all apiKeys            |
| `api_keys`   | jsonb       | `DEFAULT '[]'::jsonb`; array of `{ encryptedKey, iv, name }` (see below)                |
| `models`     | jsonb       | `DEFAULT '[]'::jsonb`; array of `{ name, enabled, inputPer1k, outputPer1k }`            |
| `created_at` | timestamptz |                                                                                         |
| `updated_at` | timestamptz | `$onUpdate`                                                                             |

`api_keys[]` entry shape (`lib/provider/schema.ts:ProviderApiKey`):

- `encryptedKey` — AES-256-GCM ciphertext + GCM auth tag, base64-packed. **Never** returned on the wire.
- `iv` — 12-byte nonce, base64. **Never** returned on the wire.
- `name` — `"sk-…xyz9"`, auto-derived from the plaintext first-3 + last-4 chars at create time. The only persistent identifier exposed to clients.

`models[]` entry shape (`ModelConfig`):

- `name` (e.g. `"gpt-4o-mini"`), `enabled` (bool), `inputPer1k` / `outputPer1k` (number ≥ 0; credits-per-1k-tokens).

Notes:

- The seeded `id = "default"` row is **protected** at the API layer — `DELETE /api/admin/providers/default` returns 409 `PROTECTED` because the system needs at least one provider to boot.
- No FK from `credit_usage_log.provider_id` to `provider.id` — historical call rows survive a provider delete.
- `getChatModelFromDB` collects every enabled `(provider, model, key)` tuple, sorts by `(providerId, modelName, keyName)`, and round-robin picks the primary. Returns a bare `ChatOpenAI` (no fallback chain — a previous `withFallbacks(...)` wrap dropped `.bindTools` / `.withStructuredOutput` and crashed the 6 LangGraph node consumers). `buildChatModel` (used by `lib/credit/build-model.ts` for rate lookup) still consults `apiKeys[0]` only — it doesn't make LLM calls, just looks up credit rates.
- See [`docs/PROVIDERS.md`](./PROVIDERS.md) for how the runtime resolves which provider to call (DB registry + LRU + cross-process TTL + env fallback).

## `credit_usage_log`

Append-only per-LLM-call log. Source of truth for two things: cap enforcement (the rolling-window SUM in `lib/credit/check.ts`) and the user-facing Settings → Credits history panel (`GET /api/credit/history`). Written only by `lib/credit/callback.ts` (`CreditTrackingHandler`).

| Column          | Type               | Notes                                                                                       |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `id`            | text PK            | UUIDv4 (matches the project row-id convention used everywhere else)                         |
| `user_id`       | text FK→user       | CASCADE on user delete; the composite index below assumes this                              |
| `provider_id`   | text               | `"openai"` / `"anthropic"` / ... (free-form text, NOT a FK — see `provider` notes)          |
| `model_name`    | text               | `"gpt-4o-mini"` / ...                                                                       |
| `agent_name`    | text               | `"router"` / `"crypto"` / `"summarize"` / ... (or `"unknown"` when the metadata is missing) |
| `input_tokens`  | integer            | From `LLMResult.llmOutput.tokenUsage` / `generation[0][0].message.usage_metadata`           |
| `output_tokens` | integer            | Same                                                                                        |
| `credits`       | numeric(12,4)      | `(input/1000)*inputPer1k + (output/1000)*outputPer1k`, frozen at call time                  |
| `status`        | enum `call_status` | `success` \| `error`. Errors excluded from the cap SUM.                                     |
| `error_message` | text NULL          | Populated when `status = 'error'` (the thrown error's message)                              |
| `created_at`    | timestamptz        | `DEFAULT now()` — drives the rolling window                                                 |
| `updated_at`    | timestamptz        | `DEFAULT now()` + `$onUpdate`; lets backfill scripts identify touched rows                  |

Indexes:

- `credit_usage_log_userId_createdAt_idx` `(user_id, created_at)` — composite btree. Covers BOTH the cap-check `WHERE user_id = ? AND status = 'success' AND created_at >= ?` (with a status filter applied after) AND the history pagination `WHERE user_id = ? ORDER BY created_at DESC LIMIT/OFFSET`. Single index, two workloads.

Notes:

- The `updated_at` is intentional — backfill scripts (e.g. after a model rate correction) can rewrite historical rows in place, and `updated_at` lets an audit identify which rows were touched. Rate changes after the fact are NOT retroactively applied automatically.
- Successful rows write `credits > 0`; errored rows write `credits = 0` (token counts default to `0` on the error path). The cap SUM only counts `status = 'success'`, so users don't pay for upstream flakiness.

## Code → table map

| Table              | Reads                                                                                                                   | Writes                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`             | `lib/auth/queries.ts` (`getSessionFromHeaders`), `withAuth` (`lib/auth/with-auth.ts`)                                   | Better Auth handlers in `app/api/auth/[...all]`; `app/api/admin/users/[id]` for ban/roleId/delete                                                                   |
| `session`          | `withAuth` (`lib/auth/with-auth.ts`)                                                                                    | Better Auth sign-in / sign-out / refresh; `app/api/admin/users/[id]` DELETE on ban                                                                                  |
| `account`          | Better Auth internal                                                                                                    | Sign-up (credential provider writes password hash)                                                                                                                  |
| `verification`     | Better Auth internal                                                                                                    | Better Auth on email verify / password reset request                                                                                                                |
| `role`             | `lib/credit/check.ts` (`checkCredit`), `lib/auth/role-queries.ts` (`getUserWithRole`)                                   | `app/api/admin/roles/**`                                                                                                                                            |
| `threads`          | `lib/threads/queries.ts` (UI list + adapter)                                                                            | API routes under `app/api/threads/`                                                                                                                                 |
| `attachments`      | `lib/attachments/queries.ts`                                                                                            | API routes under `app/api/attachments/` (presign → row, confirm → `status='uploaded'`, DELETE → row + R2 object)                                                    |
| `provider`         | `lib/provider/model-registry.ts` (`getChatModelFromDB`), `lib/credit/build-model.ts` (`findProviderId`, `getModelRate`) | `app/api/admin/providers/**` (encrypt at POST/PATCH; rotate re-encrypts in place; `stripProviderSecrets` on every response); all CUD calls `invalidateModelCache()` |
| `credit_usage_log` | `lib/credit/check.ts` (cap SUM), `app/api/credit/status` (read), `GET /api/credit/history`                              | `lib/credit/callback.ts` (`CreditTrackingHandler.handleLLMEnd` writes `success`, `handleLLMError` writes `error`; no row written when proxy short-circuits)         |

## Tooling

- Migrations: `pnpm db:generate` (drizzle-kit) → commit `db/migrations/*.sql` + `db/migrations/meta/*.json`.
- Apply: `pnpm db:migrate` against `DATABASE_URL`.
- Inspect: `pnpm db:studio` (Drizzle Studio).
- Reset (DESTRUCTIVE): `pnpm db:reset` drops the public schema. LangGraph checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) are owned by PostgresSaver.setup() at backend startup, not by our migrations.
