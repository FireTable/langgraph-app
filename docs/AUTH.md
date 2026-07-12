# Authentication (Stage 1)

The chat app is gated behind a user account. Registration and sign-in go through [Better Auth](https://better-auth.com) (self-hosted, MIT), backed by the same Postgres instance as the app data. Verification emails are sent through [Resend](https://resend.com) on the free tier (100 emails/day). Sessions last 7 days and persist across browser restarts.

## Routes

| Path                               | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/login`                           | Auth UI (sign-in by default; sub-paths `/login/sign-up`, `/login/forgot-password`, `/login/verify-email` render the corresponding views). Rendered by `app/login/[[...path]]`.                                                                                                                                                                                                                         |
| `/login/verified`                  | Post-verification success page. Better Auth consumes the token at `/api/auth/verify-email` and 302s here (the default `callbackURL="/"` is rewritten to `/login/verified` in `lib/auth/config.ts`). `autoSignInAfterVerification: true` is on — a verified user lands here with a real session and the CTA goes straight to `/chat`. Direct visits without a session redirect to `/login` immediately. |
| `/api/auth/verify-email?token=...` | The verification email links here — Better Auth consumes the token at the API level and 302s to the configured `callbackURL` (rewritten to `/login/verified`).                                                                                                                                                                                                                                         |
| `/chat`                            | The actual chat UI. Server component checks the session and redirects unauthenticated requests to `/login`.                                                                                                                                                                                                                                                                                            |
| `/api/auth/*`                      | Better Auth's catch-all — see `docs/APIS.md` for the endpoint list.                                                                                                                                                                                                                                                                                                                                    |

## Local dev setup

1. **Copy** `.env.example` to `.env.local`.
2. **Generate a secret**:
   ```bash
   openssl rand -hex 32
   ```
   Paste the output into `BETTER_AUTH_SECRET=`.
3. **Sign up at [resend.com](https://resend.com)** and copy the API key into `RESEND_API_KEY`. The free tier ships with a default sender `onboarding@resend.dev` — leave `RESEND_FROM_EMAIL` as-is for dev. In production you must verify a sending domain and set `RESEND_FROM_EMAIL` to an address on that domain.
4. **Run migrations** (creates the `user`, `session`, `account`, `verification` tables and adds the `userId` FK on `threads`):
   ```bash
   pnpm db:migrate
   ```
5. **Start**:
   ```bash
   pnpm dev
   ```
6. Open <http://localhost:3000> — you'll be bounced to `/login`. Register a new account, check your inbox, click the verification link, and you're in.

## OAuth providers (optional)

Email / password works without any OAuth configuration. To enable GitHub or Google:

### GitHub

1. Go to <https://github.com/settings/developers> → **New OAuth App**.
2. **Homepage URL**: `http://localhost:3000`
3. **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`
4. Copy the Client ID into `GITHUB_CLIENT_ID` and generate a client secret into `GITHUB_CLIENT_SECRET`.
5. Restart `pnpm dev`.

### Google

1. Go to <https://console.cloud.google.com/apis/credentials> → **Create OAuth client ID** → **Web application**.
2. **Authorized JavaScript origins**: `http://localhost:3000`
3. **Authorized redirect URIs**: `http://localhost:3000/api/auth/callback/google`
4. Copy the Client ID into `GOOGLE_CLIENT_ID` and the client secret into `GOOGLE_CLIENT_SECRET`.
5. Restart `pnpm dev`.

If only one provider is configured, the other button still renders but Better Auth will return an `OAUTH_FAILED` error.

## Data isolation

Every `/api/threads/*` route requires a session cookie and filters by `session.user.id`. Cross-user access returns 404 (not 403) to avoid leaking the existence of other users' threads. Deleting a user cascades through `ON DELETE CASCADE` and removes their threads (FR-021).

## Roles

Every user has a `roleId` FK pointing at the `role` table (`lib/auth/schema.ts`). The role controls the **credit cap** — the rolling-window limit on LLM usage enforced at call time (see [`docs/CREDIT.md`](./CREDIT.md)). Three roles ship in the migration seed:

| `id`    | `name` | `creditLimit` | `windowHours` |
| ------- | ------ | ------------- | ------------- |
| `guest` | Guest  | 20            | 24            |
| `user`  | User   | 200           | 24            |
| `admin` | Admin  | `null`        | 24            |

`admin` has `creditLimit = null` (= unlimited). The default for new signups is `"user"`. The admin UI ([`docs/ADMIN.md`](./ADMIN.md)) lets an existing admin edit `creditLimit` / `windowHours` per role and create new tiers (`pro`, `vip`, ...).

### How `roleId` reaches the session

Better Auth's `additionalFields` config (`lib/auth/config.ts`) exposes `roleId` on the session payload:

```ts
user: {
  additionalFields: {
    roleId: {
      type: "string",
      defaultValue: "user",
      input: false, // client signup / update payloads can't set it — promotion
                    // goes through the INITIAL_ADMIN_EMAIL hook, not the wire
    },
  },
}
```

`input: false` is the safety belt: even if a malicious client crafts a sign-up body with `roleId: "admin"`, Better Auth rejects it. Promotion only happens server-side via the bootstrap hook.

### `withAuth` role gate

`lib/auth/with-auth.ts` exposes two overloads:

```ts
// No role check — any signed-in user passes.
export const GET = withAuth(async (req, { user }) => { ... });

// Role check — only listed roles pass; everyone else gets 403.
export const GET = withAuth({ role: "admin" }, async (req, { user }) => { ... });
export const GET = withAuth({ role: ["admin", "user"] }, async (req, { user }) => { ... });
```

Behavior:

- **No session** → `401 UNAUTHORIZED` (no role check runs).
- **Session but `roleId` doesn't match** → `403 FORBIDDEN`. The match is **exact** — `admin` does NOT imply `user`. Today every admin route guards on the literal string `"admin"`; if `pro` / `vip` tiers ever need to inherit `user`-class privileges, switch to a precedence table instead of implicit hierarchy.
- **`roleId` is unparseable** → runtime Zod-validates via `roleIdSchema`; any value not in `["guest","user","admin"]` falls back to `"user"` so an admin route rejects a session whose FK is corrupt.

Every route under `/api/admin/**` is `withAuth({ role: "admin" }, ...)`. The pattern is identical across providers / roles / users — only the resource shape changes; the auth contract doesn't (see [`docs/APIS.md`](./APIS.md) for the per-endpoint status codes). CLAUDE.md rule #9 makes this a hard rule for every new route under `app/api/`.

### Bootstrap admin

The first admin is bootstrapped by `INITIAL_ADMIN_EMAIL` (see the env table below for full mechanics). In short: sign up a user whose email matches the env var, and the `databaseHooks.user.create.after` hook promotes them to `admin`. Subsequent signups by the same email stay `"user"` (Better Auth's uniqueness constraint on `user.email` makes that a non-event anyway, but the hook short-circuits the UPDATE either way).

To add a second admin later: sign them up with a different email, then promote them via the admin UI's **Users** tab (role dropdown → `admin`, issues `PATCH /api/admin/users/[id]`). The last-admin guard refuses to demote or ban the only remaining admin — see [`docs/ADMIN.md`](./ADMIN.md) § User management. Direct DB promotion still works as a last resort: `UPDATE "user" SET role_id = 'admin' WHERE email = '<email>';`.

### Removed env knobs

`INITIAL_ADMIN_EMAIL` replaces an earlier env-knob for per-user credit (the pre-roles prototype had per-user `creditLimit` env values). The migration to the `role` table is the only place this is configured today.

## Environment variables

See `.env.example` for the full list. Required for auth:

| Variable                                    | Required                                       | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                        | Yes                                            | 32-byte hex string (`openssl rand -hex 32`). Used to sign session cookies.                                                                                                                                                                                                                                                                                                  |
| `BETTER_AUTH_URL`                           | Yes (defaults to `http://localhost:3000`)      | Base URL of the Next.js app. Used for OAuth callback construction.                                                                                                                                                                                                                                                                                                          |
| `RESEND_API_KEY`                            | Yes                                            | From <https://resend.com/api-keys>.                                                                                                                                                                                                                                                                                                                                         |
| `RESEND_FROM_EMAIL`                         | Optional (defaults to `onboarding@resend.dev`) | Must be a verified domain in production.                                                                                                                                                                                                                                                                                                                                    |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional                                       | Enable the GitHub button.                                                                                                                                                                                                                                                                                                                                                   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional                                       | Enable the Google button.                                                                                                                                                                                                                                                                                                                                                   |
| `LLM_KEY_ENCRYPTION_KEY`                    | Yes                                            | 32-byte hex string (`openssl rand -hex 32`). AES-256-GCM KEK that wraps every entry in `provider.apiKeys[]`. Required to start the server — the admin UI returns 503 on first request if this is missing or malformed (no silent "no encryption" fallback). Rotating it is out of scope (would need a one-shot re-encryption script over every row in `provider.api_keys`). |
| `INITIAL_ADMIN_EMAIL`                       | Optional                                       | Bootstrap the first admin. On signup, if `user.email.toLowerCase() === INITIAL_ADMIN_EMAIL.toLowerCase()`, the user's `role_id` is set to `'admin'`. Idempotent — leave set forever; only the FIRST signup with this email is promoted. To add a second admin later, use the admin UI role management tab or a direct DB update.                                            |

## Troubleshooting

| Symptom                                      | Likely cause                                                    | Fix                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "BETTER_AUTH_SECRET is required"             | Missing env var                                                 | Generate with `openssl rand -hex 32` and add to `.env.local`                               |
| 500 on `/api/auth/sign-up/email` with no log | Better Auth's sendVerificationEmail threw (e.g. Resend failure) | Check `RESEND_API_KEY` is set; check Resend dashboard for delivery errors                  |
| 429 on sign-up                               | Resend free-tier rate limit exceeded (100/day)                  | Wait for the next day, or verify a custom domain to lift the limit                         |
| OAuth button → `OAUTH_FAILED`                | Client ID/secret mismatch, or callback URL not whitelisted      | Check the provider's app settings match `BETTER_AUTH_URL`                                  |
| Login page redirects back to itself          | `BETTER_AUTH_URL` doesn't match the host the browser is hitting | Set it to the URL the user actually visits (e.g. `http://localhost:3000`)                  |
| Old threads lost after a migration           | Expected — the schema reset drops the `threads` table           | See `specs/001-user-auth/quickstart.md` scenario 7 for the new ownership flow              |
| Tests fail with "relation does not exist"    | Migrations not applied to `langgraph_app_test`                  | Re-run `pnpm test` (its global setup applies `db/migrations/*.sql` to `DATABASE_URL_TEST`) |

## Stage 2 roadmap (not implemented)

- Password reset (forgot password flow with email link)
- Multi-factor auth (TOTP)
- Account deletion UI (the FK cascade already removes threads; we just need a button)
- Team / organization support
- Session management UI (list active sessions, sign out everywhere)
- Rate limiting beyond Better Auth's defaults (would require Upstash or similar)
