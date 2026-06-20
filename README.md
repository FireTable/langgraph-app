# langgraph-app

A self-hostable chat app that streams tokens from a [LangGraph](https://langchain-ai.github.io/langgraphjs/) `StateGraph` agent into an [assistant-ui](https://github.com/assistant-ui/assistant-ui) React thread, with persistent threads and checkpointed conversations stored in Postgres.

## Features

- **Streaming chat UI** powered by assistant-ui's `Thread` component.
- **LangGraph backend** with a single-node `MessagesAnnotation` graph and `ChatOpenAI` model.
- **Persistent threads and checkpoints** in Postgres — closing the tab doesn't lose context.
- **Self-hosted**: runs on a single VPS with Docker Compose, no SaaS lock-in.
- **Type-safe DB layer**: Drizzle ORM + Zod validators, derived from the same schema source.
- **TDD-tested**: Vitest with a separate test database.

## Tech stack

| Layer          | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Agent runtime  | LangGraph.js (`StateGraph`)                                            |
| LLM client     | `@langchain/openai` (OpenAI-compatible)                                |
| UI             | assistant-ui (`useStreamRuntime`) + Tailwind v4 + shadcn/ui primitives |
| App framework  | Next.js 16 (App Router, Turbopack)                                     |
| ORM            | Drizzle ORM + postgres-js                                              |
| API validation | Zod (schemas derived from Drizzle via `drizzle-zod`)                   |
| Database       | Postgres 16                                                            |
| Tests          | Vitest (real Postgres test database)                                   |

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
  assistant.tsx               Builds useStreamRuntime
  api/[..._path]/route.ts     Edge catch-all proxy to LANGGRAPH_API_URL

backend/
  agent.ts                    LangGraph graph (StateGraph + "agent" node)

components/
  assistant-ui/               Chat primitives (thread, markdown, reasoning, …)
  ui/                         shadcn/ui primitives

lib/
  utils.ts                    cn() = twMerge(clsx(...))

db/                           Database root
  schema.ts                   Aggregate re-export of all module schemas
  client.ts                   Singleton Drizzle client (postgres-js pool)
  migrations/                 Drizzle-kit generated (committed)

lib/threads/                  Threads module (one feature at a time)
  schema.ts                   Drizzle table + drizzle-zod derived Zod schemas
  queries.ts                  Server-only CRUD (8 functions)
  validators.ts               Zod API body schemas

tests/
  setup.ts                    Vitest globalSetup: applies migrations to test db
  shims/server-only.ts        No-op stub for the server-only package
  threads/
    queries.test.ts           15 cases against real Postgres
    validators.test.ts        16 cases on Zod schemas

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
| `title`                     | `TEXT NOT NULL DEFAULT 'New chat'`               | editable from the UI                                     |
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

| Var                                  | Used by                   | Required?                                  |
| ------------------------------------ | ------------------------- | ------------------------------------------ |
| `OPENAI_API_KEY`                     | backend agent             | yes                                        |
| `OPENAI_MODEL`                       | backend agent             | optional (default `gpt-4o-mini`)           |
| `OPENAI_BASE_URL`                    | backend agent             | optional (OpenAI-compatible gateway)       |
| `LANGGRAPH_API_URL`                  | Next.js proxy             | optional (default `http://localhost:2024`) |
| `LANGCHAIN_API_KEY`                  | Next.js proxy → LangGraph | optional (leave blank locally)             |
| `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` | browser runtime           | optional (default `agent`)                 |
| `NEXT_PUBLIC_LANGGRAPH_API_URL`      | browser runtime           | optional (uses proxy if unset)             |
| `DATABASE_URL`                       | drizzle-kit + backend     | yes                                        |
| `DATABASE_URL_TEST`                  | vitest                    | yes                                        |
| `LANGSMITH_*`                        | tracing                   | optional                                   |

## Patches

`patches/` contains pnpm-patchedDependencies for two upstream assistant-ui packages. See `pnpm-workspace.yaml` for the registration.

## Documentation

- [`docs/APIS.md`](docs/APIS.md) — HTTP endpoint reference. Update whenever a route under `app/api/` changes.

## Engineering rules

See `CLAUDE.md` for the project's hard rules:

- API documentation stays in sync with the code (per-commit).
- Test-driven development for every new function, route, or schema.
- Prefer canonical / community-standard solutions over ad-hoc workarounds.
