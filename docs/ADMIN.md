# Admin

The admin area manages the LLM provider registry (API keys, model rates) and the role table that gates credit enforcement. Access is gated by `session.user.roleId === "admin"` — the `/admin` page server-component performs the redirect, and every route under `/api/admin/*` is `withAuth({ role: "admin" }, ...)`. Non-admin callers receive 401 (no session) or 403 (wrong role); unauthenticated UI visitors are bounced to `/login`.

The first admin is bootstrapped via the `INITIAL_ADMIN_EMAIL` env var (see [`docs/AUTH.md`](./AUTH.md) § Role mechanism + Bootstrap). Subsequent admins are created by promoting an existing user — the admin UI's Roles tab does this indirectly: edit the user's `roleId` via the DB, or use the bootstrap email to create a new admin via sign-up. There is no in-UI "make this user an admin" affordance today.

## Routes

Every endpoint is `withAuth({ role: "admin" }, ...)` (rule #9). Status codes: `401 UNAUTHORIZED` (no session), `403 FORBIDDEN` (wrong role), `404 NOT_FOUND`, `409 <conflict code>`, `400 BAD_REQUEST`. Auth contract is identical across the surface — only the resource shape changes.

### `GET /api/admin/providers`

List every row in `provider`, ordered by `id`. The `encryptedKey` + `iv` fields are stripped server-side (see [`lib/provider/admin.ts:stripProviderSecrets`](./../lib/provider/admin.ts)); the wire shape only exposes the `name` (`"sk-…xyz9"` — first 3 + ellipsis + last 4) + optional `baseUrl`.

|               |                                     |
| ------------- | ----------------------------------- |
| Request body  | (none)                              |
| 200 response  | `{ providers: PublicProvider[] }`   |
| Failure codes | 401 `UNAUTHORIZED`, 403 `FORBIDDEN` |

### `POST /api/admin/providers`

Create a new provider row. `apiKeys` / `models` default to `[]`; new providers are typically created empty and populated via the keys/models sub-routes.

|               |                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `ProviderInput` — `id` (`^[a-z0-9_-]+$`, 1..64), `name` (1..128), `enabled` (bool, default `true`), `apiKeys?` (`ProviderApiKey[]`, default `[]`), `models?` (`ModelConfig[]`, default `[]`). |
| 201 response  | `PublicProvider`                                                                                                                                                                              |
| Failure codes | 400 `BAD_REQUEST` (Zod), 401, 403, 409 `DUPLICATE` (PK collision on `id`).                                                                                                                    |

### `PATCH /api/admin/providers/[id]`

Partial update. Whole-array replacement is used for `models` when present — no merge semantics. **`apiKeys` is intentionally NOT exposed on PATCH** — encrypted material must travel through `POST /api/admin/providers/[id]/keys` so it goes through `encryptApiKey`. A raw `apiKeys[]` on PATCH would write caller-supplied bytes straight into the jsonb and fail later at `aesGcmDecrypt` with no signal.

|               |                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | `ProviderPatch` — any subset of `id`, `name`, `enabled`, `baseUrl`, `models`. Empty body returns 400 `BAD_REQUEST`. Sending `apiKeys` is silently ignored by the schema. |
| 200 response  | `PublicProvider`                                                                                                                                                         |
| Failure codes | 400 `BAD_REQUEST` (Zod or empty patch), 401, 403, 404 `NOT_FOUND`                                                                                                        |

### `DELETE /api/admin/providers/[id]`

Hard-delete the row. The FK to `credit_usage_log` is intentionally absent — historical call rows stay even after a provider is deleted (they reference `provider_id` as a free-form text column, not a FK). Be sure before deleting: there's no soft-delete.

The seeded `default` provider (migration `0003_*`) is **protected**: deleting it returns 409 `PROTECTED` because at least one provider must always exist for the system to boot. The admin UI disables the corresponding button.

|               |                                                         |
| ------------- | ------------------------------------------------------- |
| Request body  | (none)                                                  |
| Response      | `204 No Content`                                        |
| Failure codes | 401, 403, 404 `NOT_FOUND`, 409 `PROTECTED` (default id) |

### `POST /api/admin/providers/[id]/keys`

Encrypt + append a key. The plaintext is encrypted with AES-256-GCM (`lib/auth/encryption.ts`) and never leaves the server again — the response only carries the derived `name` (`"sk-…xyz9"`). `baseUrl` is NOT accepted here — it lives on the provider row (`POST /api/admin/providers`), one per provider.

|               |                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `{ plaintext: string (1..2048) }`                                                                                                                        |
| 201 response  | `PublicProvider` (full row, secrets stripped)                                                                                                            |
| Failure codes | 400 `BAD_REQUEST` (Zod), 401, 403, 404 `NOT_FOUND` (provider missing), 409 `DUPLICATE_KEY` (a key with the same tail already exists — `name` collision). |

### `DELETE /api/admin/providers/[id]/keys`

Remove a key by its `name` (the derived tail). The encrypted blob + IV are deleted from the `api_keys` jsonb array.

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| Request body  | `{ name: string (1..64) }`                                                                |
| 200 response  | `PublicProvider`                                                                          |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider missing OR no key matches `name`). |

### `PATCH /api/admin/providers/[id]/keys/[keyName]`

Rotate and/or rename an existing key. The path is keyed on the **original** `keyName` so existing admin UI links keep working. `plaintext` re-derives `name` from the new plaintext via `deriveKeyName()`; an explicit `name` in the body overrides the derived one (rename wins over rotate). Either field can be sent independently — sending only `plaintext` is the legacy rotate flow; sending only `name` is a pure rename. Collision check excludes the entry being patched, so a rotate-to-same-tail is a no-op rename with a fresh ciphertext.

|               |                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | Any subset of `{ plaintext?: string (1..2048), name?: string (1..64, `^[a-zA-Z0-9_\-…]+$`) }`. Empty body returns 400 `BAD_REQUEST`.       |
| 200 response  | `PublicProvider`                                                                                                                           |
| Failure codes | 400 `BAD_REQUEST` (Zod or empty patch), 401, 403, 404 `NOT_FOUND` (provider or key missing), 409 `DUPLICATE` (name collides with another). |

### `POST /api/admin/providers/[id]/models`

Append a new model + rate config. `inputPer1k` / `outputPer1k` are credits-per-1k-tokens (see [`docs/CREDIT.md`](./CREDIT.md) § How a credit is computed).

|               |                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request body  | `ModelConfig` — `name` (1..128), `enabled` (bool), `inputPer1k` (number ≥0), `outputPer1k` (number ≥0).                                                      |
| 201 response  | `PublicProvider`                                                                                                                                             |
| Failure codes | 400 `BAD_REQUEST` (Zod), 401, 403, 404 `NOT_FOUND` (provider missing), 409 `DUPLICATE_MODEL` (a model with the same `name` already exists on this provider). |

### `PATCH /api/admin/providers/[id]/models/[modelName]`

Partial update of a model row. Rate changes after a call are NOT retroactively applied to historical credit rows — see [`docs/CREDIT.md`](./CREDIT.md) § How a credit is computed.

|               |                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ enabled?, inputPer1k?, outputPer1k? }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `PublicProvider`                                                                               |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND` (provider or model missing).                      |

### `DELETE /api/admin/providers/[id]/models/[modelName]`

Remove a model from the provider. Same caveat as provider delete: `credit_usage_log` keeps historical `model_name` values even if the model is gone from the registry.

|               |                           |
| ------------- | ------------------------- |
| Request body  | (none)                    |
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

Create a new role. The seeded trio (`guest`, `user`, `admin`) is inserted by the migration — POST is for adding extra tiers (e.g. `pro`, `vip`) on top.

|               |                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | `RoleInput` — `id` (`^[a-z0-9_-]+$`, 1..64), `name` (1..128), `creditLimit` (`number ≥ 0` \| `null`; `null` = unlimited), `windowHours` (1..720, default 24). |
| 201 response  | `RoleRow`                                                                                                                                                     |
| Failure codes | 400 `BAD_REQUEST`, 401, 403                                                                                                                                   |

### `PATCH /api/admin/roles/[id]`

Partial update. Changing `creditLimit` for a role immediately affects every user with that `roleId` — the next LLM call re-reads `role.creditLimit` via `checkCredit`.

|               |                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| Request body  | Any subset of `{ name?, creditLimit?, windowHours? }`. Empty body returns 400 `BAD_REQUEST`. |
| 200 response  | `RoleRow`                                                                                    |
| Failure codes | 400 `BAD_REQUEST`, 401, 403, 404 `NOT_FOUND`                                                 |

### `DELETE /api/admin/roles/[id]`

Hard-delete a role. Refuses with 409 if any user still references it — re-assign users to a different role first (currently a DB-level op; no in-UI affordance).

|               |                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Request body  | (none)                                                                                                      |
| Response      | `204 No Content`                                                                                            |
| Failure codes | 401, 403, 404 `NOT_FOUND`, 409 `ROLE_IN_USE` (body carries `message: "role is referenced by <N> user(s)"`). |

## User management

Admin operations on the `user` table. Backs the admin UI's Users tab — promote / demote between roles, ban / unban, delete. Better Auth's built-in admin plugin was considered and skipped because it adds a parallel `role` text column that conflicts with our `role_id` FK to `role.id`. A boolean `banned` column on our schema (migration `0004`) is half the surface and stays consistent with the `default`-provider / last-admin guards elsewhere.

### `GET /api/admin/users`

List every user with a left-joined `role` snapshot. The admin /admin → Users tab renders this as the table source.

|               |                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body  | (none)                                                                                                                                                                                                                                    |
| 200 response  | `{ users: { id, name, email, emailVerified, roleId, roleName, banned, createdAt, updatedAt }[] }`. `roleName` is `null` if the FK target is missing (defensive — FK prevents it on a healthy DB; a `leftJoin` can still null it on race). |
| Failure codes | 401, 403.                                                                                                                                                                                                                                 |

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

## Secrets handling

API keys stored in `provider.apiKeys[]` are encrypted at rest with **AES-256-GCM** (`lib/auth/encryption.ts`). The encryption is keyed by `LLM_KEY_ENCRYPTION_KEY` (the KEK), read lazily per-operation so a process restart isn't needed for key rotation in principle (though rotation of the KEK itself is out of scope — re-encrypting every row in place is its own project).

Wire shape on every endpoint:

- `encryptedKey` (base64 ciphertext + GCM auth tag, packed) — **never** returned.
- `iv` (base64, 12-byte nonce) — **never** returned.
- `name` (e.g. `"sk-…xyz9"`) — the only persistent identifier exposed to clients, auto-derived from the plaintext first-3 + last-4 chars at create time.
- `baseUrl` (optional) — only included when the client supplied one at create time.

The `PublicProvider` projection in `lib/provider/admin.ts` is applied uniformly before any response is built. There is no admin API that returns the full ciphertext; the decrypt path runs only inside `buildChatModel` when constructing the actual chat model at LLM-call time.

## Provider shape

```ts
type ProviderApiKey = {
  encryptedKey: string; // AES-256-GCM ciphertext+tag, base64
  iv: string; // 12-byte nonce, base64
  name: string; // "sk-…xyz9", auto-derived
};

type ModelConfig = {
  name: string; // "gpt-4o-mini"
  enabled: boolean;
  inputPer1k: number; // credits per 1k input tokens
  outputPer1k: number; // credits per 1k output tokens
};

type Provider = {
  id: string; // "openai" / "anthropic" — PK
  name: string;
  enabled: boolean;
  baseUrl: string; // OpenAI-compatible endpoint (one per provider, not per key)
  apiKeys: ProviderApiKey[]; // jsonb
  models: ModelConfig[]; // jsonb
  createdAt: Date;
  updatedAt: Date;
};
```

The full encrypted shape is server-only (`lib/provider/schema.ts`). The wire shape (`PublicProvider` in `lib/provider/admin.ts`) strips `encryptedKey` / `iv` from every `apiKeys[]` entry.

## Role management

Three roles ship in the migration seed:

| `id`    | `name` | `creditLimit` | `windowHours` |
| ------- | ------ | ------------- | ------------- |
| `guest` | Guest  | 20            | 24            |
| `user`  | User   | 200           | 24            |
| `admin` | Admin  | `null`        | 24            |

- **`creditLimit`**: total credits allowed in the rolling window. `null` = **unlimited** (the admin role). Non-null values are non-negative integers — a value of `0` is technically valid and means "no LLM calls allowed".
- **`windowHours`**: the rolling-window length in hours. Windows are **UTC-aligned**, bucketed at multiples of `windowHours` from the Unix epoch — for `windowHours=24` the boundary is UTC 00:00; for `windowHours=8` the boundaries are UTC 00:00 / 08:00 / 16:00; for any other `N` they're UTC 00:00 / N / 2N / ... Default `24`, max `720` (30 days). See [`docs/CREDIT.md`](./CREDIT.md) § Calendar-aligned rolling-window model for the SQL + display-localization details.
- **DELETE refusal**: 409 `ROLE_IN_USE` is the only way to "delete" a role with active references; the API route counts `user.roleId = <id>` and rejects the delete rather than dropping the FK.

Changing `creditLimit` or `windowHours` takes effect immediately on the next LLM call — there is no caching layer.

## Bootstrap admin

The first admin is bootstrapped by setting `INITIAL_ADMIN_EMAIL` in `.env` / `.env.local`. The Better Auth `databaseHooks.user.create.after` hook (in `lib/auth/config.ts`) checks every signup: if `created.email.toLowerCase() === process.env.INITIAL_ADMIN_EMAIL.toLowerCase()`, the user's `roleId` is set to `"admin"`. The check is idempotent — leaving the env var set forever costs only one short-circuit per signup.

Subsequent admins:

1. Sign up a new account with a different email.
2. Promote via the admin UI's **Users** tab: change the user's `roleId` dropdown from `"user"` to `"admin"` (issues `PATCH /api/admin/users/[id]`).

Direct DB promotion still works as a last resort: `UPDATE "user" SET role_id = 'admin' WHERE email = '<email>';`. The admin UI Roles tab manages the credit caps for the existing roles and creates new tiers (e.g. `pro`, `vip`).

## UI

`/admin` is a server component (`app/admin/page.tsx`) that:

1. Reads the session via `auth.api.getSession`.
2. Redirects to `/login` if no session, to `/` if `roleId !== "admin"`.
3. Loads `provider` + `role` rows in parallel (`Promise.all`) and passes them as props to the client component.

The client component (`app/admin/admin-tabs.tsx`) renders three tabs:

- **Providers** — list of `ProviderCard` rows, each with:
  - A header showing `name`, `id`, enabled/disabled status, and a destructive Delete button. The seeded `default` provider cannot be deleted — both the UI disables the button and the API rejects with 409 `PROTECTED`.
  - **Models** section: a table of `name / enabled / input / output / 1k` rows with a per-row enable toggle (PATCH `enabled`), rename (PATCH `name`), and delete (DELETE). An inline form appends a new model with `name`, `inputPer1k` (default `0.001`), `outputPer1k` (default `0.002`). Renames are in-place array swaps — the URL path stays keyed on the original model name; only the `models[]` row updates.
  - **API keys** section: a table of `name` rows with per-row rotate (PATCH — new plaintext re-derives `name`) and delete (DELETE). The plaintext input uses `type="password"` (see "UI quirks" below). An inline form appends a new key.
- **Roles** — list of role rows with editable `name`, `creditLimit` (blank = unlimited), `windowHours`. Add-role form above. Delete refuses with the API's 409 `ROLE_IN_USE` surfaced via `toast.error`.
- **Users** — list of `user` rows with role dropdown (`PATCH /api/admin/users/[id]` with `roleId`), ban toggle (PATCH `banned`), and delete. The last-admin guard is enforced server-side and surfaced via `toast.error` — demoting / banning / deleting the only remaining admin returns 409 `LAST_ADMIN` and the UI reverts the optimistic change.

After every successful mutation, the UI calls `router.refresh()` so the server component re-fetches the rows. Pending state is managed by `useTransition` per panel; `Button disabled={pending}` blocks double-submits.

### UI quirks

- **API-key plaintext input is `type="password"`** — the browser masks the value as the admin types. This is a UX choice (a screen-shoulder defense); the value is still sent in the request body to the server, where it's encrypted and never echoed.
- **`window.prompt` for rotate** — the rotate action uses a native `prompt()` dialog ("paste the new key value") rather than a custom modal. Keeps the admin-tabs component dependency-free; the entered value is the new plaintext, which becomes the encrypted blob after the PATCH round-trips.
- **`router.refresh()`** is the only state-update mechanism after a successful mutation — the client component doesn't hold its own list state, it relies on the server component to re-render with fresh props. This means the panel can lag behind reality briefly during the refresh, but the data source of truth stays server-side.

## See also

- [`docs/CREDIT.md`](./CREDIT.md) — how the `role.creditLimit` + `role.windowHours` values are enforced at LLM-call time.
- [`docs/AUTH.md`](./AUTH.md) — `INITIAL_ADMIN_EMAIL` bootstrap mechanism + Better Auth `additionalFields.roleId` plumbing.
- [`docs/DB.md`](./DB.md) — `role`, `provider`, `credit_usage_log` schema.
- [`docs/APIS.md`](./APIS.md) — Admin + Credit history endpoint sections.
