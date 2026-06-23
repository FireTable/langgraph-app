# Authentication (Stage 1)

The chat app is gated behind a user account. Registration and sign-in go through [Better Auth](https://better-auth.com) (self-hosted, MIT), backed by the same Postgres instance as the app data. Verification emails are sent through [Resend](https://resend.com) on the free tier (100 emails/day). Sessions last 7 days and persist across browser restarts.

## Routes

| Path                               | What it does                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                           | Auth UI (sign-in by default; sub-paths `/login/sign-up`, `/login/forgot-password` render the corresponding views). Rendered by `app/login/[[...path]]` from `@daveyplate/better-auth-ui`. |
| `/api/auth/verify-email?token=...` | The verification email links here — Better Auth consumes the token at the API level and 302s to the configured `callbackURL` (default `/`).                                               |
| `/chat`                            | The actual chat UI. Server component checks the session and redirects unauthenticated requests to `/login`.                                                                               |
| `/api/auth/*`                      | Better Auth's catch-all — see `docs/APIS.md` for the endpoint list.                                                                                                                       |

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

## Environment variables

See `.env.example` for the full list. Required for auth:

| Variable                                    | Required                                       | Notes                                                                      |
| ------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                        | Yes                                            | 32-byte hex string (`openssl rand -hex 32`). Used to sign session cookies. |
| `BETTER_AUTH_URL`                           | Yes (defaults to `http://localhost:3000`)      | Base URL of the Next.js app. Used for OAuth callback construction.         |
| `RESEND_API_KEY`                            | Yes                                            | From <https://resend.com/api-keys>.                                        |
| `RESEND_FROM_EMAIL`                         | Optional (defaults to `onboarding@resend.dev`) | Must be a verified domain in production.                                   |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional                                       | Enable the GitHub button.                                                  |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional                                       | Enable the Google button.                                                  |

## Troubleshooting

| Symptom                                      | Likely cause                                                    | Fix                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "BETTER_AUTH_SECRET is required"             | Missing env var                                                 | Generate with `openssl rand -hex 32` and add to `.env.local`                               |
| 500 on `/api/auth/sign-up/email` with no log | Better Auth's sendVerificationEmail threw (e.g. Resend failure) | Check `RESEND_API_KEY` is set; check Resend dashboard for delivery errors                  |
| 429 on sign-up                               | Resend free-tier quota exceeded (100/day)                       | Wait for the next day, or verify a custom domain to lift the limit                         |
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
