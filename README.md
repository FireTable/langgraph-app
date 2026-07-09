# LangGraph App

A self-hostable chat app (this repo: `langgraph-app`) that streams tokens from a [LangGraph](https://langchain-ai.github.io/langgraphjs/) `StateGraph` agent into an [assistant-ui](https://github.com/assistant-ui/assistant-ui) React thread, with persistent threads and checkpointed conversations stored in Postgres.

## Features

- **Streaming chat UI** powered by assistant-ui's `Thread` component.
- **LangGraph backend** running **two compiled graphs** side-by-side: a chat graph (`agent` — router + sub-agents + `triggerBackgroundAgent`) and a turn-end side-effect graph (`background_agent` — `touchLastMessage` + `summarize`). The chat stream doesn't block on background work; `triggerBackgroundAgentNode` HTTP-dispatches via the SDK and returns immediately.
- **Persistent threads and checkpoints** in Postgres — closing the tab doesn't lose context.
- **Cross-conversation memory**: the model calls `save_memory` to persist durable user facts (RFC 6902 patches against `[userId, "memory"] main`); a recall middleware prepends `<memory>` (profile + auth overlay) and `<threads>` (compressed Q&A history) blocks to the SystemMessage on every invoke. Long threads stay readable via a store-anchored `threadSummarizeNode` trigger that compresses K-turn windows into `SummaryEntry` rows. The Memory settings tab lets users review and delete. See [docs/MEMORY.md](docs/MEMORY.md).
- **Self-hosted**: runs on a single VPS with Docker Compose, no SaaS lock-in.
- **Type-safe DB layer**: Drizzle ORM + Zod validators, derived from the same schema source.
- **TDD-tested**: Vitest with a separate test database.
- **User accounts**: email + password (with email verification), GitHub and Google sign-in, 7-day persistent sessions, and per-user thread isolation. See [docs/AUTH.md](docs/AUTH.md) for the operator guide.
- **Tool-using agent**: every sub-agent is bound to `search_web` (Jina Search), `fetch_url` (Jina Reader), `save_memory`, and the domain-specific tools (weather / crypto / code). See [docs/TOOLS.md](docs/TOOLS.md) and [docs/INTERRUPT.md](docs/INTERRUPT.md) for the per-card contract.
- **Crypto sub-agent**: price, NFT holdings (5-chain gallery via Alchemy Portfolio), and a simulated swap flow against an auto-funded Mock Coin balance.
- **Observability panel**: every LLM / Tool / Chain / Node span is captured by a `BaseCallbackHandler` and persisted to a `observability_spans` Postgres table. Each assistant message shows an icon button that opens a per-turn waterfall — duration, token usage, nested parent/child spans. The list endpoint is server-transformed (panel never carries the raw collector payload); per-row click lazy-loads the full span via a dedicated detail endpoint. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).
- **Chat attachments**: assistant-ui's `AttachmentAdapter` plus a presigned PUT to Cloudflare R2 — the browser uploads bytes directly to R2, nothing traverses Next.js. Lazy-register on missing env (mirrors DENO / ALCHEMY). See [docs/ATTACHMENTS.md](docs/ATTACHMENTS.md) for the key convention, messageId-deferred decision, and Content-Disposition XSS guard.

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
    [..._path]/route.ts       Node catch-all proxy to LANGGRAPH_API_URL (withAuth-gated)
    threads/                  Thread metadata CRUD + observability sub-routes
    memory/                   Profile + thread-summaries delete endpoints
    alchemy/                  Alchemy JSON-RPC proxy + key-status endpoint

backend/
  agent.ts                    Chat graph (router + sub-agents + triggerBackgroundAgent)
  background-agent.ts         Background graph (touchLastMessage + summarize)
  state.ts                    RouterAgentState + CommonAgentState
  model.ts                    ChatOpenAI singletons (with / without thinking)
  checkpointer.ts             PostgresSaver (LangGraph Postgres checkpoint tables)
  store.ts                    Shared PostgresStore for memory + thread summaries
  callbacks.ts                Singleton CapturingHandler shared by both compiled graphs
  agent/
    chat-agent.ts             chatAgent compiled subgraph (model ↔ tools loop)
    weather-agent.ts          weatherAgent compiled subgraph
    crypto-agent.ts           cryptoAgent compiled subgraph
    code-agent.ts             codeAgent compiled subgraph
  node/
    call-model-node.ts        "agent" node — calls the model, appends AI reply
    rename-thread-agent-node.ts "renameThreadAgent" — generates + persists the title
    router-agent-node.ts      "routerAgent" — picks weatherAgent / chatAgent / cryptoAgent / codeAgent
    trigger-background-agent-node.ts "triggerBackgroundAgent" — SDK runs.create to background_agent
    thread-summarize-node.ts  "summarize" — compresses K-turn window into a SummaryEntry
  tool/                       LangChain tools bound to the agent
    web-search.ts             search_web — Jina Search (s.jina.ai/{query})
    web-fetch.ts              fetch_url — Jina Reader (r.jina.ai/{url})
    memory/save-memory-tool.ts save_memory — RFC 6902 patches against the user profile
  memory/
    recall.ts                 loadMemory / getCachedMemory (LRU max 1000, 60s TTL); extractUserId / extractThreadId
    template.ts               buildSystemMessageWithMemory (mustache <memory> + <threads>) + trimMessagesForInvoke
    profile-size.ts           assertProfileSize — guard before the store write (NFR-003)
  observability/
    callback-collector.ts     CapturingHandler — buffers spans per runId, persists on End hook

components/
  assistant-ui/               Chat primitives (thread, markdown, reasoning, …)
  observability/              Observability UI (button, sheet, sheet-context, panel, llm-messages renderer)
  tool-ui/                    Tool-call cards (weather / crypto / code / memory)
  ui/                         shadcn/ui primitives
  settings/                   Memory settings tab (memory-view)

lib/
  utils.ts                    cn() = twMerge(clsx(...))
  constants.ts                App-wide constants (APP_NAME, DEFAULT_THREAD_TITLE, localStorage keys)
  jina.ts                     In-memory Jina API key pool + jinaFetch wrapper (401/403 failover)
  threads/                    Threads module
    schema.ts                 Drizzle table + drizzle-zod derived Zod schemas
    queries.ts                CRUD (rename, archive, unarchive, delete, fetch, list, getThreadTitlesForUser)
    adapter.ts                RemoteThreadListAdapter for assistant-ui
    validators.ts             Zod API body schemas
  memory/                     Memory module — queries (getMemoryDoc / putMemoryDoc / getAuthInfo / writeSummary / getThreadSummaries / getRecentThreadSummaries / deleteThreadSummaries) + validators (RFC 6902 patches, SummaryEntry) + merge (mergeMemory + getStoreKeys) + constants + format
  observability/              Observability module
    schema.ts                 Drizzle table (observability_spans)
    queries.ts                bulkInsertSpans / getSpansByThreadId / markRunningAsFailed / deleteSpansByThreadId
    transform.ts              CapturedSpan → SpanData (for @assistant-ui/react-o11y); buildStepIdToRawSpanId
    aggregate.ts              aggregateRoot — pre-compute stat-card row server-side
    config.ts                 getRetentionDays() — reads OBSERVABILITY_RETENTION_DAYS
    validators.ts             Zod schemas for list / detail / DELETE responses + AggregateDTO

db/                           Database root
  schema.ts                   Aggregate re-export of all module schemas
  client.ts                   Singleton Drizzle client (postgres-js pool)
  migrations/                 Drizzle-kit generated (committed)

tests/                        Vitest (NODE_ENV=test → reads .env.test)
  setup.ts                    globalSetup: applies migrations to test db
  api/                        Route handler tests
  backend/                    Graph + node tests
  db/                         Migration sanity tests
  frontend/                   Component tests (Memory tab, observability sheet, …)
  threads/                    queries + adapter + validators tests

drizzle.config.ts             Drizzle-kit config (uses @next/env to load .env)
vitest.config.ts              Vitest config (NODE_ENV=test → reads .env.test)
langgraph.json                LangGraph CLI config (registers BOTH graphs: agent + background_agent)
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

| Var                                    | Used by                   | Required?                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                       | backend agent             | yes                                                                                                                                                                                                                                                     |
| `OPENAI_MODEL`                         | backend agent             | optional (default `gpt-4o-mini`)                                                                                                                                                                                                                        |
| `OPENAI_BASE_URL`                      | backend agent             | optional (OpenAI-compatible gateway)                                                                                                                                                                                                                    |
| `JINA_API_KEYS`                        | web-search + web-fetch    | yes (comma-separated; one per Jina account)                                                                                                                                                                                                             |
| `ALCHEMY_API_KEY`                      | NFT gallery + portfolio   | yes (server-only; powers `get_NFT_holdings`)                                                                                                                                                                                                            |
| `LANGGRAPH_API_URL`                    | Next.js proxy             | optional (default `http://localhost:2024`)                                                                                                                                                                                                              |
| `LANGCHAIN_API_KEY`                    | Next.js proxy → LangGraph | optional (leave blank locally)                                                                                                                                                                                                                          |
| `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID`   | browser runtime           | optional (default `agent`)                                                                                                                                                                                                                              |
| `NEXT_PUBLIC_LANGGRAPH_API_URL`        | browser runtime           | optional (uses proxy if unset)                                                                                                                                                                                                                          |
| `DATABASE_URL`                         | drizzle-kit + backend     | yes                                                                                                                                                                                                                                                     |
| `DATABASE_URL_TEST`                    | vitest                    | yes                                                                                                                                                                                                                                                     |
| `BETTER_AUTH_SECRET`                   | session cookie signing    | yes (see [docs/AUTH.md](docs/AUTH.md))                                                                                                                                                                                                                  |
| `BETTER_AUTH_URL`                      | OAuth callback base       | yes (default `http://localhost:3000`)                                                                                                                                                                                                                   |
| `RESEND_API_KEY`                       | verification emails       | yes                                                                                                                                                                                                                                                     |
| `RESEND_FROM_EMAIL`                    | verification email sender | optional (`onboarding@resend.dev` default)                                                                                                                                                                                                              |
| `GITHUB_CLIENT_ID` / `_SECRET`         | GitHub OAuth              | optional                                                                                                                                                                                                                                                |
| `GOOGLE_CLIENT_ID` / `_SECRET`         | Google OAuth              | optional                                                                                                                                                                                                                                                |
| `LANGSMITH_*`                          | tracing                   | optional                                                                                                                                                                                                                                                |
| `OBSERVABILITY_RETENTION_DAYS`         | observability spans       | optional (default `30`; must be a positive integer)                                                                                                                                                                                                     |
| `MEMORY_THREAD_SUMMARY_KEEP_RECENT`    | thread summarization      | optional (default `10`; trigger cadence + recent floor for `threadSummarizeNode`)                                                                                                                                                                       |
| `MEMORY_PROFILE_MAX_BYTES`             | `save_memory` size guard  | optional (default `8192`; profile-doc size cap before store write)                                                                                                                                                                                      |
| `R2_ACCOUNT_ID`                        | chat attachments          | yes (server-only; Cloudflare account id from the R2 dashboard URL)                                                                                                                                                                                      |
| `R2_ACCESS_KEY_ID` / `_SECRET`         | chat attachments          | yes (server-only; R2 API token, Object Read & Write scoped to the bucket)                                                                                                                                                                               |
| `R2_BUCKET`                            | chat attachments          | yes (server-only; bucket name, e.g. `langgraph-app`)                                                                                                                                                                                                    |
| `R2_PUBLIC_BASE_URL`                   | chat attachments          | yes (e.g. `https://file.ai.firetable.tech`; no trailing slash)                                                                                                                                                                                          |
| `R2_MAX_BYTES`                         | chat attachments          | optional (default `10485760` / 10 MiB)                                                                                                                                                                                                                  |
| `NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES` | chat attachments          | optional (default `image/png,image/jpeg,image/webp`; PDF deliberately excluded until the KB agent lands — see [docs/ATTACHMENTS.md § Scope today](docs/ATTACHMENTS.md#scope-today-images-only); read by both server validator and composer file-picker) |
| `NEXT_PUBLIC_ATTACHMENTS_ENABLED`      | chat attachments          | optional (default `false`; flip to `"true"` once `R2_*` is set — gates the composer attachment button)                                                                                                                                                  |

## Patches

`patches/` contains a pnpm `patchedDependencies` entry for `@assistant-ui/core@0.2.18` (guards `part.text?.trim()` to tolerate missing text on `text`/`reasoning` parts). See `pnpm-workspace.yaml` for the registration.

## Documentation

- [`docs/APIS.md`](docs/APIS.md) — HTTP endpoint reference. Update whenever a route under `app/api/` changes.
- [`docs/LANDING.md`](docs/LANDING.md) — marketing landing at `/`: per-section file map, asset inventory, motion keyframes, route-group naming rule, frontend test layout.
- [`docs/MEMORY.md`](docs/MEMORY.md) — memory + thread-summarize design: dual-graph topology, `<memory>` + `<threads>` recall, `save_memory` RFC 6902 patches, store-anchored trigger window math, Memory tab UI, security stance.
- [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — observability panel design: callback handler wiring, `observability_spans` schema, server-side transform + aggregate, lazy-loaded row detail, security/redaction, retention config, and curl examples.
- [`docs/TOOLS.md`](docs/TOOLS.md) — LangGraph tool inventory and frontend card wiring. Update whenever a tool or card is added/removed/rerouted.
- [`docs/INTERRUPT.md`](docs/INTERRUPT.md) — interrupt-driven tool flows (ask_location, connect_wallet, place_crypto_order, get_order_status) — the two runtime paths the cards can take.
- [`docs/AUTH.md`](docs/AUTH.md) — operator guide for the auth layer: env vars, OAuth app setup, Resend, troubleshooting.
- [`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md) — chat attachments backed by Cloudflare R2: direct-upload architecture, key convention, lazy-register on missing env, `Content-Disposition` XSS guard, `messageId`-deferred decision.
- [`docs/DB.md`](docs/DB.md) — database schema (Better Auth + `threads` + `attachments`), ownership model, indexes. Source of truth: `db/migrations/0000_*.sql`.
- [`docs/CI.md`](docs/CI.md) — CI/CD layout, base-image runtime requirements, local verification commands.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — self-hosting guide: pull the image, configure env, first-start Postgres fix, reverse proxy + TLS, backups. **Read this if you're deploying.**

### Issues

Issue titles use a `[Type]:` prefix so the queue scans cleanly. Common types: `[Bug]:`, `[Feat]:`, `[Docs]:`, `[Chore]:`, `[Perf]:`, `[Refactor]:`, `[Test]:`, `[Question]:`. Match the same name as the `gh` label you apply (`bug`, `enhancement`, `documentation`, …).

## Skills

`skills/` holds **Claude Code skill files** — self-contained, agent-loadable instructions for specific operations. A skill is just a `.md` file with a `name` + `description` frontmatter; agents that read the file's description can auto-invoke it when the user's request matches.

### Available skills

- [`skills/langgraph-app-maintain.md`](skills/langgraph-app-maintain.md) — Deploy and maintain `langgraph-app` on a VPS. Covers first-time cold start, push-to-CD deploys, rollback to a previous image, DB reset, OS / Docker / base image / Node upgrades, backup and restore. **The agent walks the developer through every step**, with explicit "user does X" vs "agent does Y" boundaries (the agent never pretends to click external dashboards on the user's behalf). Reads as: who pulls the keys, who writes `.env.vps`, who configures GitHub secrets, who opens the Cloudflare Origin Certificate, etc. End with a red-line list of actions the agent must NOT take (apply for keys, generate random secrets, pay for anything, etc.).

### How to use

To invoke a skill, point the agent at the file. Example prompts that should trigger `langgraph-app-maintain`:

- "Deploy this to my VPS"
- "Upgrade the base image"
- "Roll back to yesterday's deploy"
- "Reset the database on the VPS"
- "How do I rotate `BETTER_AUTH_SECRET`?"

The agent will read `skills/langgraph-app-maintain.md`, ask the user for the key anchors (VPS host, GitHub owner, public domain, etc.), and run through the steps. Before each external action (apply for a key, configure a GH secret, generate a Cloudflare cert), the skill explicitly stops and hands the task back to the user.

### Adding a new skill

Create a new `.md` file in `skills/` with frontmatter:

```markdown
---
name: <short-kebab-case>
description: <one-line summary, include trigger keywords so the agent knows when to load it>
---

<the skill body — assume the agent has no other context, write self-contained>
```

A skill should be self-contained (no references to `/tmp/...` or other transient paths), free of real secrets (use `<placeholder>` or external links), and explicit about which steps are user actions vs agent actions.

## Engineering rules

See `CLAUDE.md` for the project's hard rules:

- API documentation stays in sync with the code (per-commit).
- Test-driven development for every new function, route, or schema.
- Prefer canonical / community-standard solutions over ad-hoc workarounds.
