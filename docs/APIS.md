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

## Proxy

| Endpoint             | Purpose                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANY /api/[...path]` | Edge catch-all that forwards to `LANGGRAPH_API_URL` (the LangGraph dev server / production endpoint). Strips hop-by-hop headers, adds CORS, optionally sends `x-api-key`. |

## Graph tools

The LangGraph `agent` graph exposes the following tools to the chat model. Both are read-only and run unconditionally — there is no per-call human approval prompt. Write tools added later should hang off their own node and pass `interruptBefore: ["<that-node>"]` to `compile()` so only the write path pauses for approval.

Implementation: `backend/tool/{web-fetch,web-search}.ts`. Shared key pool: `lib/jina.ts`.

### `searchWeb(query)`

Keyword / natural-language web search via Jina Search (`s.jina.ai`).

|               |                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ query: string }` — non-empty                                                                                                   |
| Output        | `{ query, results: Array<{ title, url, description }> }` (JSON string)                                                            |
| Auth          | Uses one key from `JINA_API_KEYS` (comma-separated in `.env.example`)                                                             |
| Failure modes | `500` from upstream → tool throws and the model reports the error; all keys exhausted → tool throws `"All N Jina keys exhausted"` |

### `fetchUrl(url)`

Read a public web page and return it as markdown via Jina Reader (`r.jina.ai`).

|               |                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Input         | `{ url: string }` — must be a valid absolute URL with scheme                                                       |
| Output        | `{ title, content, url }` (JSON string; `content` is markdown)                                                     |
| Auth          | Same `JINA_API_KEYS` pool as `searchWeb`                                                                           |
| Failure modes | Non-2xx from upstream → tool throws with status code; URL validation failure → schema rejection before the request |

### Key pool semantics

`JINA_API_KEYS` is parsed once at module load into an in-memory pool. Each request picks a key at random. On `401` or `403`, the key is removed from the pool and the request retries with another random key. Up to N retries are attempted where N is the pool size at call start; once every key has rejected the same request, the tool throws. The pool is process-local and resets on LangGraph dev-server restart.
