# LangGraph App

A self-hostable chat app (this repo: `langgraph-app`) that streams tokens from a [LangGraph](https://langchain-ai.github.io/langgraphjs/) `StateGraph` agent into an [assistant-ui](https://github.com/assistant-ui/assistant-ui) React thread, with persistent threads and checkpointed conversations stored in Postgres.

## Features

- **Streaming chat UI** powered by assistant-ui's `Thread` component.
- **LangGraph backend** with a parallel `MessagesAnnotation` graph (`agent` + `renameThread` fanned out from `START`) and `ChatOpenAI` model. Title is generated once on the first turn and persisted to Postgres.
- **Persistent threads and checkpoints** in Postgres — closing the tab doesn't lose context.
- **Self-hosted**: runs on a single VPS with Docker Compose, no SaaS lock-in.
- **Type-safe DB layer**: Drizzle ORM + Zod validators, derived from the same schema source.
- **TDD-tested**: Vitest with a separate test database.
- **User accounts**: email + password (with email verification), GitHub and Google sign-in, 7-day persistent sessions, and per-user thread isolation. See [docs/AUTH.md](docs/AUTH.md) for the operator guide.
- **Tool-using agent**: the `agent` node is bound to `search_web` (Jina Search) and `fetch_url` (Jina Reader) — the model can research topics and read pages mid-conversation. Tools run unconditionally; write-side tools added later will hang their own `interruptBefore` hook. See [docs/APIS.md](docs/APIS.md) for the contract.
- **Crypto sub-agent**: price, NFT holdings (5-chain gallery via Alchemy Portfolio), and a simulated swap flow against an auto-funded Mock Coin balance — see [docs/TOOLS.md](docs/TOOLS.md) and [docs/INTERRUPT.md](docs/INTERRUPT.md) for the per-card contract.

## Tech stack

| Layer          | Choice                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| Agent runtime  | LangGraph.js (`StateGraph`)                                               |
| LLM client     | `@langchain/openai` (OpenAI-compatible)                                   |
| UI             | assistant-ui (`useLangGraphRuntime`) + Tailwind v4 + shadcn/ui primitives |
| App framework  | Next.js 16 (App Router, Turbopack)                                        |
| ORM            | Drizzle ORM + postgres-js                                                 |
| API validation | Zod (schemas derived from Drizzle via `drizzle-zod`)                      |
| Database       | Postgres 16                                                               |
| Tests          | Vitest (real Postgres test database)                                      |

## Quick start

### Prerequisites

- Node.js 22 (pinned by `langgraph.json`)
- pnpm 10+
- Postgres 16 (local install or Docker)

### 1. Install Postgres and create databases

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16

createdb langgraph_app
createdb langgraph_app_test
```

Or with Docker:

```bash
docker run -d --name pg-dev -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
createdb -h localhost -U postgres langgraph_app
createdb -h localhost -U postgres langgraph_app_test
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```bash
# OpenAI-compatible provider (the agent reads these unconditionally)
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # or your gateway

# Jina pool — used by web-search and web-fetch tools. Free keys at jina.ai/reader.
# Comma-separated; the pool rotates and blacklists 401/403 responses.
JINA_API_KEYS=jina_abc,jina_def

# Local Postgres
DATABASE_URL=postgresql://FireTable@localhost:5432/langgraph_app
```

`.env.test` (used by Vitest under `NODE_ENV=test`):

```bash
DATABASE_URL_TEST=postgresql://FireTable@localhost:5432/langgraph_app_test
```

### 3. Install dependencies and run migrations

```bash
pnpm install
pnpm db:migrate
```

`pnpm db:migrate` runs `drizzle-kit migrate` against `DATABASE_URL`. The first migration creates the `threads` table; LangGraph's `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables are created automatically by `PostgresSaver.setup()` at backend startup.

### 4. Start the dev servers

```bash
pnpm dev
```

- `localhost:2024` — LangGraph dev server
- `localhost:3000` — Next.js app (proxies `/api/*` to LangGraph)

Open `http://localhost:3000` and send a message.

## Project layout

```
app/                          Next.js App Router
  page.tsx                    Full-viewport entry, renders <Assistant />
  assistant.tsx               useLangGraphRuntime + thread list adapter wiring
  api/                        HTTP routes (see docs/APIS.md)
    [..._path]/route.ts       Edge catch-all proxy to LANGGRAPH_API_URL
    threads/                  Thread metadata CRUD

backend/
  agent.ts                    LangGraph graph (parallel agent + renameThread + tools loop)
  model.ts                    ChatOpenAI singletons (with / without thinking)
  checkpointer.ts             PostgresSaver (Postgres checkpoint tables)
  tool/                       LangChain tools bound to the agent
    web-search.ts             search_web — Jina Search (s.jina.ai/{query})
    web-fetch.ts              fetch_url — Jina Reader (r.jina.ai/{url})
  node/
    call-model-node.ts        "agent" node — appends AI reply
    rename-thread-node.ts     "renameThread" node — generates + persists title
    after-agent-node.ts       "afterAgent" node — bumps last_message_at

components/
  assistant-ui/               Chat primitives (thread, markdown, reasoning, …)
  ui/                         shadcn/ui primitives

lib/
  utils.ts                    cn() = twMerge(clsx(...))
  constants.ts                App-wide constants (APP_NAME, DEFAULT_THREAD_TITLE, localStorage keys)
  jina.ts                     In-memory Jina API key pool + jinaFetch wrapper (401/403 failover)
  threads/                    Threads module
    schema.ts                 Drizzle table + drizzle-zod derived Zod schemas
    queries.ts                CRUD (rename, archive, unarchive, delete, fetch, list)
    adapter.ts                RemoteThreadListAdapter for assistant-ui
    validators.ts             Zod API body schemas

db/                           Database root
  schema.ts                   Aggregate re-export of all module schemas
  client.ts                   Singleton Drizzle client (postgres-js pool)
  migrations/                 Drizzle-kit generated (committed)

tests/                        Vitest (NODE_ENV=test → reads .env.test)
  setup.ts                    globalSetup: applies migrations to test db
  api/                        Route handler tests
  backend/                    Graph + node tests
  db/                         Migration sanity tests
  threads/                    queries + adapter + validators tests

drizzle.config.ts             Drizzle-kit config (uses @next/env to load .env)
vitest.config.ts              Vitest config (NODE_ENV=test → reads .env.test)
langgraph.json                LangGraph CLI config
.env.example                  Template (committed)
.env.local                    Local dev secrets (gitignored)
.env.test                     Test secrets (gitignored)
```

## Database

Two persistence layers, both in Postgres:

### 1. Threads metadata (`threads` table)

Managed by Drizzle. Owned by the `lib/threads` module.

| Column                      | Type                                             | Notes                                                    |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `id`                        | `TEXT PRIMARY KEY`                               | nanoid, 12 chars, also used as the LangGraph `thread_id` |
| `title`                     | `TEXT NOT NULL DEFAULT 'New Chat'`               | editable from the UI                                     |
| `status`                    | `TEXT NOT NULL CHECK IN ('regular', 'archived')` | sidebar filter                                           |
| `user_id`                   | `TEXT NULL`                                      | reserved for future multi-user                           |
| `custom`                    | `JSONB NOT NULL DEFAULT '{}'`                    | free-form metadata                                       |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()`             |                                                          |

Index: `(status, updated_at DESC)` for sidebar queries.

### 2. LangGraph checkpoints

Created automatically by `PostgresSaver.setup()` at backend startup. Tables: `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, plus the `__drizzle_migrations` journal table.

## Development

| Command             | Effect                                     |
| ------------------- | ------------------------------------------ |
| `pnpm dev`          | Run Next.js and LangGraph concurrently     |
| `pnpm dev:frontend` | Next.js only (port 3000)                   |
| `pnpm dev:backend`  | LangGraph only (port 2024)                 |
| `pnpm build`        | Production frontend build                  |
| `pnpm start`        | Run the production build                   |
| `pnpm lint`         | oxlint + oxfmt `--check`                   |
| `pnpm format:fix`   | oxfmt (write)                              |
| `pnpm test`         | Vitest once                                |
| `pnpm test:watch`   | Vitest in watch mode                       |
| `pnpm db:generate`  | Generate a migration from Drizzle schema   |
| `pnpm db:migrate`   | Apply pending migrations to `DATABASE_URL` |
| `pnpm db:studio`    | Open Drizzle Studio                        |

## Testing

`pnpm test` sets `NODE_ENV=test` so `@next/env` reads `.env.test` (not `.env.local`). The `tests/setup.ts` globalSetup applies all migrations to the test database before any tests run. Each test file truncates the relevant tables in `beforeEach`.

Test database stays isolated from dev — never put production-like data in `langgraph_app_test`.

## Environment variables

| Var                                  | Used by                   | Required?                                    |
| ------------------------------------ | ------------------------- | -------------------------------------------- |
| `OPENAI_API_KEY`                     | backend agent             | yes                                          |
| `OPENAI_MODEL`                       | backend agent             | optional (default `gpt-4o-mini`)             |
| `OPENAI_BASE_URL`                    | backend agent             | optional (OpenAI-compatible gateway)         |
| `JINA_API_KEYS`                      | web-search + web-fetch    | yes (comma-separated; one per Jina account)  |
| `ALCHEMY_API_KEY`                    | NFT gallery + portfolio   | yes (server-only; powers `get_NFT_holdings`) |
| `LANGGRAPH_API_URL`                  | Next.js proxy             | optional (default `http://localhost:2024`)   |
| `LANGCHAIN_API_KEY`                  | Next.js proxy → LangGraph | optional (leave blank locally)               |
| `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` | browser runtime           | optional (default `agent`)                   |
| `NEXT_PUBLIC_LANGGRAPH_API_URL`      | browser runtime           | optional (uses proxy if unset)               |
| `DATABASE_URL`                       | drizzle-kit + backend     | yes                                          |
| `DATABASE_URL_TEST`                  | vitest                    | yes                                          |
| `BETTER_AUTH_SECRET`                 | session cookie signing    | yes (see [docs/AUTH.md](docs/AUTH.md))       |
| `BETTER_AUTH_URL`                    | OAuth callback base       | yes (default `http://localhost:3000`)        |
| `RESEND_API_KEY`                     | verification emails       | yes                                          |
| `RESEND_FROM_EMAIL`                  | verification email sender | optional (`onboarding@resend.dev` default)   |
| `GITHUB_CLIENT_ID` / `_SECRET`       | GitHub OAuth              | optional                                     |
| `GOOGLE_CLIENT_ID` / `_SECRET`       | Google OAuth              | optional                                     |
| `LANGSMITH_*`                        | tracing                   | optional                                     |

## Patches

`patches/` contains a pnpm `patchedDependencies` entry for `@assistant-ui/core@0.2.18` (guards `part.text?.trim()` to tolerate missing text on `text`/`reasoning` parts). See `pnpm-workspace.yaml` for the registration.

## Documentation

- [`docs/APIS.md`](docs/APIS.md) — HTTP endpoint reference. Update whenever a route under `app/api/` changes.
- [`docs/TOOLS.md`](docs/TOOLS.md) — LangGraph tool inventory and frontend card wiring. Update whenever a tool or card is added/removed/rerouted.
- [`docs/INTERRUPT.md`](docs/INTERRUPT.md) — interrupt-driven tool flows (ask_location, connect_wallet, place_crypto_order, get_order_status) — the two runtime paths the cards can take.
- [`docs/AUTH.md`](docs/AUTH.md) — operator guide for the auth layer: env vars, OAuth app setup, Resend, troubleshooting.
- [`docs/DB.md`](docs/DB.md) — database schema (Better Auth + `threads`), ownership model, indexes. Source of truth: `db/migrations/0000_*.sql`.

## Engineering rules

See `CLAUDE.md` for the project's hard rules:

- API documentation stays in sync with the code (per-commit).
- Test-driven development for every new function, route, or schema.
- Prefer canonical / community-standard solutions over ad-hoc workarounds.
