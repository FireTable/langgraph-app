# Database schema

Source of truth: `db/migrations/0000_*.sql` (drizzle-kit generated). This doc describes what each table is for and which code paths touch it.

## Tables

| Table          | Owner | Purpose                                               |
| -------------- | ----- | ----------------------------------------------------- |
| `user`         | app   | Better Auth user rows; FK target for owned rows       |
| `session`      | app   | Better Auth DB sessions (cookie → userId)             |
| `account`      | app   | Better Auth credentials / OAuth links per user        |
| `verification` | app   | One-time tokens (email verify, password reset)        |
| `threads`      | app   | Chat threads; one row per assistant-ui thread         |
| `attachments`  | app   | Chat attachment metadata; bytes live in Cloudflare R2 |

## Cascade behavior

`user.id` is the cascade root. Deleting a user removes every `session`, `account`, `thread`, and `attachment` they own. `threads.id` cascade also removes its `attachments` (so thread delete cleans up uploads). No soft delete; CASCADE only.

## `user`

| Column           | Type        | Notes                     |
| ---------------- | ----------- | ------------------------- |
| `id`             | text PK     | Better Auth user id       |
| `name`           | text NULL   | Display name              |
| `email`          | text UNIQUE | Login + verify target     |
| `email_verified` | bool        | Gates redirect to `/chat` |
| `image`          | text NULL   | Avatar URL                |
| `created_at`     | timestamptz |                           |
| `updated_at`     | timestamptz | `$onUpdate`               |

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

Bytes live in Cloudflare R2 — this table is the source of truth for the URL the renderer hands the model and for thread-side cleanup. One row per uploaded file. Lifecycle:

- `POST /api/attachments/presign` → INSERT row with `status='pending'`, `size_bytes` from request
- Browser PUTs bytes directly to R2 (presigned URL)
- `POST /api/attachments/[id]/confirm` → `HeadObject` size check, then `UPDATE status='uploaded', confirmed_at=now()`
- `DELETE /api/attachments/[id]` → DELETE row + `DeleteObject` on R2

| Column         | Type                 | Notes                                                                                                                             |
| -------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | text PK              | 12-char nanoid; also embedded in the R2 key                                                                                       |
| `user_id`      | text FK→user         | CASCADE on user delete                                                                                                            |
| `thread_id`    | text FK→threads NULL | Set at presign when the adapter knows the active thread; nullable for the brief window before `confirm`. CASCADE on thread delete |
| `r2_key`       | text                 | `u/<userId>/<nanoid>-<safe-filename>`                                                                                             |
| `name`         | text                 | Original (sanitized) filename                                                                                                     |
| `content_type` | text                 | MIME type — restricted to `NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES`                                                                  |
| `size_bytes`   | bigint               | Claimed at presign, verified via `HeadObject` at confirm                                                                          |
| `status`       | enum                 | `pending` \| `uploaded`                                                                                                           |
| `created_at`   | timestamptz          |                                                                                                                                   |
| `confirmed_at` | timestamptz NULL     | Stamped at confirm                                                                                                                |

No `message_id` column: assistant-ui has no documented mechanism to correlate an attachment with the resulting message after send. Thread-side rendering joins `attachments` to LangGraph `messages` via `(thread_id, created_at)` window — see `docs/ATTACHMENTS.md`.

Indexes:

- `attachments_user_created_idx` `(user_id, created_at DESC)` — sidebar / cleanup
- `attachments_thread_created_idx` `(thread_id, created_at DESC)` — `(thread_id, created_at)` join

## Code → table map

| Table          | Reads                                           | Writes                                                                                                           |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `user`         | `lib/auth/queries.ts` (`getSessionFromHeaders`) | Better Auth handlers in `app/api/auth/[...all]`                                                                  |
| `session`      | `withAuth` (`lib/auth/with-auth.ts`)            | Better Auth sign-in / sign-out / refresh                                                                         |
| `account`      | Better Auth internal                            | Sign-up (credential provider writes password hash)                                                               |
| `verification` | Better Auth internal                            | Better Auth on email verify / password reset request                                                             |
| `threads`      | `lib/threads/queries.ts` (UI list + adapter)    | API routes under `app/api/threads/`                                                                              |
| `attachments`  | `lib/attachments/queries.ts`                    | API routes under `app/api/attachments/` (presign → row, confirm → `status='uploaded'`, DELETE → row + R2 object) |

## Tooling

- Migrations: `pnpm db:generate` (drizzle-kit) → commit `db/migrations/*.sql` + `db/migrations/meta/*.json`.
- Apply: `pnpm db:migrate` against `DATABASE_URL`.
- Inspect: `pnpm db:studio` (Drizzle Studio).
- Reset (DESTRUCTIVE): `pnpm db:reset` drops the public schema. LangGraph checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) are owned by PostgresSaver.setup() at backend startup, not by our migrations.
