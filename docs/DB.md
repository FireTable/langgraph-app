# Database schema

Source of truth: `db/migrations/0000_*.sql` (drizzle-kit generated). This doc describes what each table is for and which code paths touch it.

## Tables

| Table              | Owner | Purpose                                                                                                                                                                           |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`             | app   | Better Auth user rows; FK target for owned rows                                                                                                                                   |
| `session`          | app   | Better Auth DB sessions (cookie → userId)                                                                                                                                         |
| `account`          | app   | Better Auth credentials / OAuth links per user                                                                                                                                    |
| `verification`     | app   | One-time tokens (email verify, password reset)                                                                                                                                    |
| `role`             | app   | Per-role credit cap + rolling window length                                                                                                                                       |
| `threads`          | app   | Chat threads; one row per assistant-ui thread                                                                                                                                     |
| `attachments`      | app   | Chat attachment metadata; bytes live in Cloudflare R2                                                                                                                             |
| `provider`         | app   | LLM provider registry (API keys, model rates)                                                                                                                                     |
| `credit_usage_log` | app   | Append-only per-LLM-call log; drives cap enforcement + call history UI                                                                                                            |
| `kb_folder`        | app   | Per-user grouping for KB docs (issue #13); default `Attachments` auto-created                                                                                                     |
| `kb_document`      | app   | One row per ingested PDF; status enum `pending \| parsing \| success \| failed`                                                                                                   |
| `kb_chunk`         | app   | Chunks with `vector(1024)` pgvector embedding (BAAI/bge-m3 via apimart) + GIN-indexed tsvector (`'simple'` config, multilingual); HNSW index over `embedding` (vector_cosine_ops) |
| `kb_entity`        | app   | Canonical extracted entities per `(user_id, document_id, name)` with 1024-dim embedding for GraphRAG ANN entrypoint (audit §8, migration `0012_blue_steve_rogers.sql`)            |
| `kb_relationship`  | app   | Directed entity→entity edges with 1024-dim embedding for global ANN, weight + `source_chunk_ids` for chunk provenance (audit §7, migration `0012_blue_steve_rogers.sql`)          |

## Cascade behavior

`user.id` is the cascade root. Deleting a user removes every `session`, `account`, `thread`, `attachment`, and `credit_usage_log` row they own. `attachments` has no FK to `threads` (Q3 — see `docs/ATTACHMENTS.md` for why), so thread deletion does NOT clean up attachment rows. Use the retention sweep if those accumulate. No soft delete; CASCADE only.

`role` deletion is refused at the API layer (`409 ROLE_IN_USE`) while any user row still references it — the schema's FK is `ON DELETE NO ACTION`, so the API check is what surfaces the conflict before the constraint trips. `provider` deletion is unconstrained (no FK from `credit_usage_log.provider_id` — see `provider` notes above).

`kb_folder` deletion is refused at the DB layer: `kb_document.folder_id` is `NOT NULL ... ON DELETE RESTRICT`. Move docs to another folder before deleting a folder.

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

| Column         | Type             | Notes                                                                                      |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `id`           | text PK          | 12-char nanoid (dedup-confirmation token + DB FK target; **not** part of the R2 key)       |
| `user_id`      | text FK→user     | CASCADE on user delete                                                                     |
| `r2_key`       | text             | `u/<userId>/upload/<sha256>.<ext>` (content-addressed; same bytes → same key → R2 dedupes) |
| `name`         | text             | Original (sanitized) filename                                                              |
| `content_type` | text             | MIME type — restricted to `R2_ALLOWED_CONTENT_TYPES`                                       |
| `size_bytes`   | bigint           | Claimed at presign, verified via `HeadObject` at confirm                                   |
| `sha256`       | text             | 64-char hex; powers dedup short-circuit + is the R2 key component                          |
| `status`       | enum             | `pending` \| `uploaded`                                                                    |
| `created_at`   | timestamptz      |                                                                                            |
| `confirmed_at` | timestamptz NULL | Stamped at confirm                                                                         |

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

## KB retrieval — index inventory (issue #13 v3)

The hybrid search function (`lib/kb/search.ts`) runs RRF (k=60) over three legs and depends on the following indexes:

| Index                              | Type         | Used by leg                               | Rationale                                                                                                                                            |
| ---------------------------------- | ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kb_chunk_embedding_idx`           | HNSW         | `vec` (pgvector cosine `<=>`)             | Online-friendly (no training required, unlike ivfflat). m=16, ef_construction=64 from pgvector README defaults.                                      |
| `kb_chunk_tsv_idx`                 | GIN          | `kw` (`tsv @@ websearch_to_tsquery`)      | Postgres built-in BM25-style. `tsv` is a `GENERATED ALWAYS AS to_tsvector('simple', content) STORED` column (language-neutral, post-migration 0012). |
| `kb_entity_embedding_idx`          | HNSW         | `entity` (B phase, GraphRAG local)        | `kb_entity.embedding <=> qvec` ANN entrypoint for entity-leg. B phase only.                                                                          |
| `kb_relationship_embedding_idx`    | HNSW         | `rel` (B phase, GraphRAG global)          | `kb_relationship.embedding <=> qvec` ANN entrypoint for relation-leg. B phase only.                                                                  |
| `kb_entity_user_doc_name_idx`      | unique btree | Canonical entity dedup                    | Composite `(user_id, document_id, name)`; `ON CONFLICT` on upsert accumulates `source_chunk_ids` + union-merges `themes`.                            |
| `kb_relationship_user_doc_str_idx` | unique btree | Canonical edge dedup                      | Composite `(user_id, document_id, source, target, relation)`; `ON CONFLICT` increments `weight`.                                                     |
| `kb_entity_user_name_idx`          | btree        | Cross-doc entity lookups                  | Composite `(user_id, name)` — supports `expandFromEntities` BFS traversal.                                                                           |
| `kb_relationship_user_source_idx`  | btree        | Graph hop 1 lookup                        | `(user_id, document_id, source)` — `WHERE source = $entity` edge scan.                                                                               |
| `kb_relationship_user_target_idx`  | btree        | Reverse-direction graph traversal         | `(user_id, document_id, target)` — needed when expand follows reverse edges.                                                                         |
| `kb_chunk_document_ordinal_idx`    | btree        | Per-doc chunk ordering                    | Composite `(document_id, ordinal)`; supports the `findKbChunksByDocumentId` resolver and per-doc scans.                                              |
| `kb_document_user_contenthash_idx` | unique btree | PRIMARY dedup in `kbAgent.screenshotNode` | Composite `(user_id, content_hash)`; same PDF re-uploaded short-circuits.                                                                            |
| `kb_document_user_attachment_idx`  | btree        | Backup dedup path                         | Composite `(user_id, attachment_id)`; covers the case where two PDFs collide on sha256 (rare but cheap to defend).                                   |
| `kb_document_user_created_idx`     | btree        | `list_documents` ordering                 | Composite `(user_id, created_at DESC)`; covers the Settings → KB tab list.                                                                           |
| `kb_document_folder_idx`           | btree        | Folder-scoped queries                     | `(folder_id)`; the per-folder doc list inside `kbAgent` and the Settings folder filter.                                                              |
| `kb_folder_user_name_idx`          | unique btree | Default-folder bootstrap                  | Composite `(user_id, name)`; lets the "Attachments" folder be auto-created idempotently on first upload.                                             |
| `kb_folder_user_idx`               | btree        | Folder list                               | `(user_id)`; covers the Settings sidebar.                                                                                                            |

All KB queries scope by `user_id` first; the composite indexes above let the planner index-only-scan the per-user slice.

Missing fields (follow-up migrations):

- `kb_chunk.page_numbers INTEGER[]` — currently absent. The Pages tab UI reads page numbers from `kb_document.pages` (the JSON column populated during ingest). `HybridSearchResult.pageNumbers` returns `[]` until a migration adds the column and the ingest pipeline writes per-chunk page boundaries.

## `kb_folder`

Per-user grouping. Default `Attachments` is auto-created on first upload; users can create more by hand. `(user_id, name)` is unique so the auto-create is idempotent.

| Column       | Type         | Notes                       |
| ------------ | ------------ | --------------------------- |
| `id`         | text PK      | `f-<uuid>`                  |
| `user_id`    | text FK→user | CASCADE on user delete      |
| `name`       | text         | 1..128 chars; user-editable |
| `created_at` | timestamptz  |                             |

Indexes: `kb_folder_user_name_idx` `(user_id, name)` UNIQUE, `kb_folder_user_idx` `(user_id)`.

## `kb_document`

One row per ingested source — KB v3 routes one of seven ingest kinds (PDF, image, markdown, plain text, DOCX, XLSX, PPTX, plus URL-fetched markdown) via `getIngestHandler(mimeType)`. `attachment_id` is the source FK (chat upload → KB); the URL flow writes an attachments row server-side via `putObject` so the same table backs both paths. `pages` is the JSONB page cache populated by `splitFileToPageNode` and reused by `chunksOnly` / `retryFailed` reprocess modes. `content_hash` is sha256 hex (the primary dedup key) — chat presign requires sha so the `r2key:<key>` fallback is dead code today but kept as a defensive fallback.

| Column          | Type                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | text PK                  | `d-<uuid>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `user_id`       | text FK→user             | CASCADE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `folder_id`     | text FK→kb_folder        | `NOT NULL`, `ON DELETE RESTRICT` (move docs before deleting a folder)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `attachment_id` | text FK→attachments NULL | `ON DELETE SET NULL`; NULL after the attachment is deleted, but the doc still appears in the Settings list (KB docs outlive their source upload by design)                                                                                                                                                                                                                                                                                                                                                          |
| `title`         | text                     | User-given (from upload) or filename fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `content_type`  | text                     | MIME; routes to one of seven ingest handlers in `lib/kb/ingest-handlers.ts` (`pdf`, `markdown`, `plain`, `image`, `docx`, `xlsx`, `pptx`)                                                                                                                                                                                                                                                                                                                                                                           |
| `content_hash`  | text                     | sha256 hex, or `r2key:<key>` fallback when `attachments.sha256` is null (legacy browsers)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `status`        | enum `kb_doc_status`     | `pending` (default) → `parsing` → `success` / `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `error_message` | text NULL                | Populated when `status='failed'`; surfaced on the doc row badge and the doc detail dialog                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pages`         | jsonb NULL               | `Array<{ pageIndex, imageUrl, markdown, referenceText?, textBlocks?, imageRefs?, errorMessage?, status? }>`; populated by `splitFileToPageNode`, reused by `chunksOnly` / `retryFailed` reprocess. `imageUrl` is the page PNG (PDF / image) or empty (text / office). `textBlocks` + `imageRefs` are populated only for PDF pages and feed the OCR prompt as structured hints. URLs are content-addressed (`u/<userId>/kb/<sha256>.<ext>`) — same logo embedded across N PDFs → one R2 object referenced by N rows. |
| `created_at`    | timestamptz              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `updated_at`    | timestamptz              | `$onUpdate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Indexes: `kb_document_user_contenthash_idx` `(user_id, content_hash)` UNIQUE, `kb_document_user_created_idx` `(user_id, created_at DESC)`, `kb_document_user_attachment_idx` `(user_id, attachment_id)`, `kb_document_folder_idx` `(folder_id)`.

## `kb_chunk`

One row per text chunk emitted by `backend/node/kb/entity-extract-node.ts` (formerly `kbAgent.chunkEmbedStoreNode`). Embeddings stored as `pgvector` (`vector(1024)` for BAAI/bge-m3 via apimart). `tsv` is a generated **language-neutral** tsvector (`'simple'` config — multilingual SaaS; English stemming is unsafe for CJK / 法语 / 德语 content) used by the BM25 leg. Per-chunk **entity / relationship / theme data lives on `kb_entity` and `kb_relationship`**, not on this row — the legacy `entities` / `relationships` jsonB columns and `themes text[]` were dropped in migration `0012_blue_steve_rogers.sql` to break the chunk-row write hot path and prepare for the B-phase graph legs.

> **Image requirement** — the `vector` extension must be installed before migration `0005_past_grey_gargoyle.sql` runs. The repo's postgres service is `pgvector/pgvector:pg16` (not stock `postgres:16-alpine`); the official pgvector image bundles the extension and inherits all upstream postgres wire format. CI services (`build` + `test` jobs) and the docker-compose deploy service all use the same tag.

| Column          | Type                                                                   | Notes                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | text PK                                                                | `c-<uuid>`                                                                                                                                                        |
| `document_id`   | text FK→kb_document                                                    | CASCADE on doc delete                                                                                                                                             |
| `ordinal`       | integer                                                                | 0-based chunk index within the doc (drives the Empty-ordinal rerun modes)                                                                                         |
| `content`       | text                                                                   | The chunk text, truncated to `KB_CHUNK_MAX_CHARS` (default 2000)                                                                                                  |
| `embedding`     | `vector(1024)`                                                         | BAAI/bge-m3 cosine; dim of column + dim of HNSW index + dim of embedder MUST agree (`22P02` otherwise)                                                            |
| `tsv`           | `tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED` | Read-only, maintained by Postgres; powers the BM25 leg. `'simple'` (not `'english'`) — language-neutral, no CJK-folding stemming. `INSERT` writes `content` only. |
| `status`        | enum `kb_chunk_status`                                                 | `pending` (default) → `parsing` → `success` / `failed`. Independent of `kb_document.status` so a single chunk can fail without downgrading the parent doc.        |
| `error_message` | text NULL                                                              | Populated when `status='failed'`; surfaced on the chunk badge in the doc detail dialog                                                                            |
| `created_at`    | timestamptz                                                            |                                                                                                                                                                   |

Indexes: `kb_chunk_embedding_idx` HNSW `(embedding vector_cosine_ops)`, `kb_chunk_tsv_idx` GIN `(tsv)`, `kb_chunk_document_ordinal_idx` `(document_id, ordinal)`.

> The `kb_chunk_entities_idx` and `kb_chunk_themes_idx` GIN indexes over the now-dropped jsonB columns are also gone (migration 0012). Graph data lives in `kb_entity` / `kb_relationship` below — query via `source_chunk_ids && ARRAY[chunkId]` instead of a per-chunk column scan.

## `kb_entity`

One row per canonical extracted entity per `(user_id, document_id, name)` (audit §8). Populated by `backend/node/kb/entity-extract-node.ts` per chunk + `resolveEntityAliasesForDoc` for cross-chunk canonical alignment. The 1024-dim embedding (BAAI/bge-m3) powers the `entityLeg` B-phase ANN entrypoint in `lib/kb/search/entity-leg.ts`. `themes` is an entity-level property (not chunk-level) — union-deduped on upsert conflict.

| Column             | Type                | Notes                                                                                                                                                   |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | text PK             | `e-<uuid>`                                                                                                                                              |
| `user_id`          | text FK→user        | CASCADE on user delete                                                                                                                                  |
| `document_id`      | text FK→kb_document | CASCADE on doc delete                                                                                                                                   |
| `name`             | text                | Canonical entity name (post-`appLevelCanonical` NFKC + trim + lower-unify; post-`resolveEntityAliasesForDoc` LLM alignment when it runs)                |
| `type`             | text                | LLM-supplied category (Organization / Person / Concept / etc.)                                                                                          |
| `description`      | text                | LLM-supplied short description                                                                                                                          |
| `source_chunk_ids` | `text[]`            | All chunks that surfaced this entity (canonical merge accumulates the union). Drives `findKbChunksContentByDocumentId` rehydrate for the doc-detail UI. |
| `themes`           | `text[]`            | Hashtag-style themes; default `'{}'::text[]`. Entity-level property — `themes` on `kb_chunk` was migrated here (audit §8, migration `0013_*.sql`).      |
| `embedding`        | `vector(1024)` NULL | Populated by `backend/node/kb/entity-embed-node.ts` (B phase; entityEmbedNode is a no-op when `KB_GRAPH_ENABLED=false`)                                 |
| `created_at`       | timestamptz         |                                                                                                                                                         |
| `updated_at`       | timestamptz         |                                                                                                                                                         |

Indexes: `kb_entity_user_doc_name_idx` UNIQUE `(user_id, document_id, name)`, `kb_entity_embedding_idx` HNSW `(embedding vector_cosine_ops)`, `kb_entity_user_name_idx` `(user_id, name)`, `kb_entity_document_idx` `(document_id)`.

## `kb_relationship`

Directed `source → relation → target` edges per `(user_id, document_id, source, target, relation)` (audit §7). Populated alongside `kb_entity` by `entity-extract-node.ts`; alignment in `resolveEntityAliasesForDoc` rewrites `source` / `target` to canonical names. `embedding` powers the `relationLeg` B-phase ANN entrypoint (global mode); `weight` increments on each upsert conflict (more chunks surfacing the same edge → higher confidence).

| Column             | Type                | Notes                                                           |
| ------------------ | ------------------- | --------------------------------------------------------------- |
| `id`               | text PK             | `r-<uuid>`                                                      |
| `user_id`          | text FK→user        | CASCADE on user delete                                          |
| `document_id`      | text FK→kb_document | CASCADE on doc delete                                           |
| `source`           | text                | Canonical source entity name                                    |
| `target`           | text                | Canonical target entity name                                    |
| `relation`         | text                | Edge label (`PARTNERED_WITH`, `ACQUIRED`, etc.)                 |
| `description`      | text                | LLM-supplied short description of the edge                      |
| `source_chunk_ids` | `text[]`            | Chunks that surfaced this edge — same purpose as on `kb_entity` |
| `themes`           | `text[]`            | Edge-level themes; default `'{}'::text[]`                       |
| `weight`           | integer             | `DEFAULT 1`; `+1` per upsert conflict                           |
| `embedding`        | `vector(1024)` NULL | Populated by `entity-embed-node.ts` (B phase)                   |
| `created_at`       | timestamptz         |                                                                 |
| `updated_at`       | timestamptz         |                                                                 |

Indexes: `kb_relationship_user_doc_str_idx` UNIQUE `(user_id, document_id, source, target, relation)`, `kb_relationship_embedding_idx` HNSW `(embedding vector_cosine_ops)`, `kb_relationship_user_source_idx` `(user_id, document_id, source)`, `kb_relationship_user_target_idx` `(user_id, document_id, target)`, `kb_relationship_document_idx` `(document_id)`. The source/target indexes support `expandFromEntities` BFS in `lib/kb/search/graph-context.ts` (1-2 hop graph traversal, hops from `KB_GRAPH_HOPS`).

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
