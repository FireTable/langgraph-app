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
- **Knowledge Base & Hybrid Search**: ingestion across seven source kinds (PDF, image, plain text, markdown, DOCX, XLSX, PPTX) plus pasted URLs — PDF / image go through vision OCR, Office formats are parsed structurally by `officeparser` with embedded images extracted to R2, text and markdown skip straight to chunking — followed by text chunking, embedding, entity / relationship / theme extraction, and pgvector-backed three-leg RRF (Keyword, Vector, Tag) hybrid search combined with semantic Reranking (Cohere/Jina), `@` mention resolution (with automatic fallback to full markdown when chunks are not ready), dynamic budget scaling, and iterative search. See [docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md).
- **Per-LLM-call credit quota**: every successful call is metered against a UTC-aligned rolling-window cap read from `role.creditLimit` / `role.windowHours`. Enforcement lives at the `/api/[..._path]` proxy — when the cap is hit, the proxy synthesizes a `show_credit_card` SSE stream and the chat UI renders the credit-limit-reached card inline. The call log backs a per-user history (Settings → Credits) and an admin-managed rate config. See [docs/CREDIT.md](docs/CREDIT.md).
- **Admin console**: a single `/admin` page with three tabs — Providers (registry + encrypted API keys + per-model rates), Roles (credit caps + window length), Users (role assignment, ban with immediate session revoke, delete). The first admin is bootstrapped via `INITIAL_ADMIN_EMAIL`. See [docs/ADMIN.md](docs/ADMIN.md).

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

## Experience

- **Live demo**: <https://ai.firetable.tech> — a hosted instance running this repo. Sign up with any email; the first account matching `INITIAL_ADMIN_EMAIL` is promoted to admin (set that env var on your own deployment if you want the same).
- **Repo**: <https://github.com/FireTable/langgraph-app>

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
    [..._path]/route.ts       Node catch-all proxy to LANGGRAPH_API_URL (withAuth-gated, per-turn credit cap)
    threads/                  Thread metadata CRUD + observability sub-routes
    memory/                   Profile + thread-summaries delete endpoints
    credit/                   status + history endpoints (user-facing)
    admin/                    Providers / Roles / Users CRUD (admin-only)
    alchemy/                  Alchemy JSON-RPC proxy + key-status endpoint

backend/
  agent.ts                    Chat graph (router + sub-agents + triggerBackgroundAgent)
  background-agent.ts         Background graph (touchLastMessage + summarize)
  state.ts                    RouterAgentState + CommonAgentState
  model.ts                    getChatModel() — DB-backed ChatOpenAI factory + env fallback
  checkpointer.ts             PostgresSaver (LangGraph Postgres checkpoint tables)
  store.ts                    Shared PostgresStore for memory + thread summaries
  callbacks.ts                Singleton handlers shared by both compiled graphs (capturingHandler + creditTrackingHandler)
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
  tool-ui/                    Tool-call cards (weather / crypto / code / memory / credit)
  ui/                         shadcn/ui primitives
  settings/                   Memory + Credits settings tabs
  credit/                     CreditProgress + CreditHeader + CreditSummaryCard (shared chrome)
  auth/                       Auth-shell + user-button + sign-in UI

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
  credit/                     Credit quota module
    schema.ts                 Drizzle table (credit_usage_log) + call_status enum
    check.ts                  checkCredit(userId) — SUM + UTC-anchored window + admin unlimited short-circuit
    charge.ts                 recordLlmCall + computeCredits (pure math)
    callback.ts               CreditTrackingHandler — BaseCallbackHandler that writes the log
    build-model.ts            findProviderId / getModelRate — callback-side helpers
    status.ts                 Shared client-side /api/credit/status reader (1s TTL + in-flight collapse)
    invoke.ts                 creditExceededReply — unused helper (kept for future hookup)
    errors.ts                 CreditExceededError class — defined but never thrown today
    zod.ts                    Zod schemas for roleId / callStatus / providerApiKey / modelConfig + provider/role input+patch
  provider/                   LLM provider registry module
    schema.ts                 Drizzle table (provider) + ProviderApiKey / ModelConfig types
    admin.ts                  PublicProvider projection + stripProviderSecrets + encryptApiKey helper
    model-registry.ts         getChatModelFromDB / invalidateModelCache (LRU + 60s TTL)
  auth/                       Better Auth + RBAC
    schema.ts                 user / session / account / verification / role tables
    config.ts                 Better Auth instance + INITIAL_ADMIN_EMAIL hook + ban-session gate
    encryption.ts             AES-256-GCM helpers (loadKek / aesGcmEncrypt / aesGcmDecrypt / deriveKeyName)
    with-auth.ts              withAuth({ role }, handler) — session + role gate wrapper
    role-queries.ts           getUserWithRole — JOIN through role

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
  lib/                        Library-module tests (credit, provider, auth, observability, memory)

drizzle.config.ts             Drizzle-kit config (uses @next/env to load .env)
vitest.config.ts              Vitest config (NODE_ENV=test → reads .env.test)
langgraph.json                LangGraph CLI config (registers BOTH graphs: agent + background_agent)
.env.example                  Template (committed)
.env.local                    Local dev secrets (gitignored)
.env.test                     Test secrets (gitignored)
```

## Database

Three persistence layers, all in Postgres:

### 1. App tables

Owned by `lib/<module>/schema.ts` (re-exported from `db/schema.ts`). See [`docs/DB.md`](docs/DB.md) for the full column-by-column source of truth.

- **`user`, `session`, `account`, `verification`** — Better Auth tables (managed by `lib/auth/schema.ts`).
- **`threads`** — chat threads; one row per assistant-ui thread. Indexed `(status, updated_at DESC)` for the sidebar.
- **`attachments`** — R2-backed file metadata (no FK to `threads`; see [`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md)).
- **`role`** — per-tier credit cap (`credit_limit`, `window_hours`). Seeded with `guest`, `user`, `admin` (migration `0003`).
- **`provider`** — LLM registry (encrypted API keys + per-model rates). Seeded with `default` (migration `0003`).
- **`credit_usage_log`** — append-only per-LLM-call log. Source of truth for the cap check + the user-facing history. Composite index `(user_id, created_at)` covers both workloads.

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

| Var                                 | Used by                      | Required?                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`                    | backend agent                | optional — read only when the `provider` table is empty (first-boot env fallback). After the seed migration lands, the admin UI manages encrypted keys per provider.                                                                                                                                               |
| `OPENAI_MODEL`                      | backend agent                | optional (default `gpt-4o-mini`); seeds the `default` provider's first model at migration time                                                                                                                                                                                                                     |
| `OPENAI_BASE_URL`                   | backend agent                | optional (OpenAI-compatible gateway); seeds the `default` provider's `base_url` at migration time                                                                                                                                                                                                                  |
| `JINA_API_KEYS`                     | web-search + web-fetch       | yes (comma-separated; one per Jina account)                                                                                                                                                                                                                                                                        |
| `ALCHEMY_API_KEY`                   | NFT gallery + portfolio      | yes (server-only; powers `get_NFT_holdings`)                                                                                                                                                                                                                                                                       |
| `LANGGRAPH_API_URL`                 | Next.js proxy                | optional (default `http://localhost:2024`)                                                                                                                                                                                                                                                                         |
| `LANGCHAIN_API_KEY`                 | Next.js proxy → LangGraph    | optional (leave blank locally)                                                                                                                                                                                                                                                                                     |
| `LANGGRAPH_ASSISTANT_ID`            | browser runtime              | optional (default `agent`)                                                                                                                                                                                                                                                                                         |
| `LANGGRAPH_PUBLIC_URL`              | browser runtime              | optional (uses proxy if unset)                                                                                                                                                                                                                                                                                     |
| `DATABASE_URL`                      | drizzle-kit + backend        | yes                                                                                                                                                                                                                                                                                                                |
| `DATABASE_URL_TEST`                 | vitest                       | yes                                                                                                                                                                                                                                                                                                                |
| `BETTER_AUTH_SECRET`                | session cookie signing       | yes (see [docs/AUTH.md](docs/AUTH.md))                                                                                                                                                                                                                                                                             |
| `BETTER_AUTH_URL`                   | OAuth callback base          | yes (default `http://localhost:3000`)                                                                                                                                                                                                                                                                              |
| `LLM_KEY_ENCRYPTION_KEY`            | API-key KEK                  | yes — 32-byte hex (`openssl rand -hex 32`). AES-256-GCM key that wraps every `provider.apiKeys[]` row. The admin UI returns 503 on first request if this is missing (no silent fallback). Rotating it is out of scope.                                                                                             |
| `INITIAL_ADMIN_EMAIL`               | bootstrap admin              | optional — the first signup matching this email (case-insensitive) is promoted to `roleId: "admin"` via the Better Auth `databaseHooks.user.create.after` hook. Idempotent — only the FIRST match is promoted.                                                                                                     |
| `RESEND_API_KEY`                    | verification emails          | yes                                                                                                                                                                                                                                                                                                                |
| `RESEND_FROM_EMAIL`                 | verification email sender    | optional (`onboarding@resend.dev` default)                                                                                                                                                                                                                                                                         |
| `GITHUB_CLIENT_ID` / `_SECRET`      | GitHub OAuth                 | optional                                                                                                                                                                                                                                                                                                           |
| `GOOGLE_CLIENT_ID` / `_SECRET`      | Google OAuth                 | optional                                                                                                                                                                                                                                                                                                           |
| `LANGSMITH_*`                       | tracing                      | optional                                                                                                                                                                                                                                                                                                           |
| `OBSERVABILITY_RETENTION_DAYS`      | observability spans          | optional (default `30`; must be a positive integer)                                                                                                                                                                                                                                                                |
| `MEMORY_THREAD_SUMMARY_KEEP_RECENT` | thread summarization         | optional (default `10`; trigger cadence + recent floor for `threadSummarizeNode`)                                                                                                                                                                                                                                  |
| `MEMORY_PROFILE_MAX_BYTES`          | `save_memory` size guard     | optional (default `8192`; profile-doc size cap before store write)                                                                                                                                                                                                                                                 |
| `R2_ACCOUNT_ID`                     | chat attachments             | yes (server-only; Cloudflare account id from the R2 dashboard URL)                                                                                                                                                                                                                                                 |
| `R2_ACCESS_KEY_ID` / `_SECRET`      | chat attachments             | yes (server-only; R2 API token, Object Read & Write scoped to the bucket)                                                                                                                                                                                                                                          |
| `R2_BUCKET`                         | chat attachments             | yes (server-only; bucket name, e.g. `langgraph-app`)                                                                                                                                                                                                                                                               |
| `R2_PUBLIC_BASE_URL`                | chat attachments             | yes (e.g. `https://file.ai.firetable.tech`; no trailing slash)                                                                                                                                                                                                                                                     |
| `R2_MAX_BYTES`                      | chat attachments             | optional (default `10485760` / 10 MiB)                                                                                                                                                                                                                                                                             |
| `R2_ALLOWED_CONTENT_TYPES`          | chat attachments + KB ingest | optional (default `image/png,image/jpeg,image/webp`; expand to include `application/pdf` + `text/markdown` + `text/plain` + Office Open XML mimes for KB ingestion — see [docs/ATTACHMENTS.md § Scope today](docs/ATTACHMENTS.md#scope-today-images-only); read by both server validator and composer file-picker) |
| `ATTACHMENTS_ENABLED`               | chat attachments             | optional (default `false`; flip to `"true"` once `R2_*` is set — gates the composer attachment button)                                                                                                                                                                                                             |
| `KB_MENTION_TOPK_DEFAULT`           | KB mention resolver          | optional (default `5`; chunks per single `@`-mention)                                                                                                                                                                                                                                                              |
| `KB_MENTION_TOPK_MAX`               | KB mention resolver          | optional (default `20`; per-mention upper bound when the user overrides topK)                                                                                                                                                                                                                                      |
| `KB_MENTION_TOKEN_BUDGET`           | KB mention resolver          | optional (default `8192`; total token cap across multi-mention turns, per-mention topK is rebudgeted as `ceil(BUDGET / (KB_CHUNK_MAX_CHARS/4 * mentions))`)                                                                                                                                                        |
| `KB_HYBRID_TOPK_DEFAULT`            | `search_kb` tool             | optional (default `8`; fused topK for hybrid search)                                                                                                                                                                                                                                                               |
| `KB_HYBRID_TOPK_MAX`                | `search_kb` tool             | optional (default `20`; fused topK upper bound)                                                                                                                                                                                                                                                                    |
| `KB_CHUNK_MAX_CHARS`                | KB chunker                   | optional (default `2000`; per-chunk truncation before LLM stuffing; ~512 tokens at 4 chars/token)                                                                                                                                                                                                                  |
| `KB_RERANK_MIN_SCORE`               | KB reranker                  | optional (default `0.4`; minimum rerank relevance for filtering candidates)                                                                                                                                                                                                                                        |

## Patches

`patches/` contains a pnpm `patchedDependencies` entry for `@assistant-ui/core@0.2.18` (guards `part.text?.trim()` to tolerate missing text on `text`/`reasoning` parts). See `pnpm-workspace.yaml` for the registration.

## Documentation

- [`docs/APIS.md`](docs/APIS.md) — HTTP endpoint reference. Update whenever a route under `app/api/` changes.
- [`docs/LANDING.md`](docs/LANDING.md) — marketing landing at `/`: per-section file map, asset inventory, motion keyframes, route-group naming rule, frontend test layout.
- [`docs/MEMORY.md`](docs/MEMORY.md) — memory + thread-summarize design: dual-graph topology, `<memory>` + `<threads>` recall, `save_memory` RFC 6902 patches, store-anchored trigger window math, Memory tab UI, security stance.
- [`docs/KNOWLEDGE_BASE.md`](docs/KNOWLEDGE_BASE.md) — knowledge base design: ingestion pipeline, three-leg RRF hybrid search (Keyword, Vector, Tag), semantic Reranking and score filtering, `@` mention resolution (Meta vs Full Markdown mode), mention budgeting, and iterative search.
- [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — observability panel design: callback handler wiring, `observability_spans` schema, server-side transform + aggregate, lazy-loaded row detail, security/redaction, retention config, and curl examples.
- [`docs/TOOLS.md`](docs/TOOLS.md) — LangGraph tool inventory and frontend card wiring. Update whenever a tool or card is added/removed/rerouted.
- [`docs/INTERRUPT.md`](docs/INTERRUPT.md) — interrupt-driven tool flows (ask_location, connect_wallet, place_crypto_order, get_order_status) — the two runtime paths the cards can take.
- [`docs/AUTH.md`](docs/AUTH.md) — operator guide for the auth layer: env vars, OAuth app setup, Resend, role mechanism, `INITIAL_ADMIN_EMAIL` bootstrap, troubleshooting.
- [`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md) — chat attachments backed by Cloudflare R2: direct-upload architecture, key convention, lazy-register on missing env, `Content-Disposition` XSS guard, `messageId`-deferred decision.
- [`docs/DB.md`](docs/DB.md) — database schema (Better Auth + `threads` + `attachments` + `role` + `provider` + `credit_usage_log`), ownership model, indexes. Source of truth: `db/migrations/0000_*.sql`.
- [`docs/CREDIT.md`](docs/CREDIT.md) — per-LLM-call credit cap: UTC-aligned rolling window, proxy-level enforcement, callback-level recording, `show_credit_card` UI affordance, `credit_usage_log` audit trail.
- [`docs/ADMIN.md`](docs/ADMIN.md) — admin console: `/admin` Providers / Roles / Users tabs, AES-256-GCM API-key encryption, last-admin + default-provider guards, secrets handling.
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — DB-backed chat-model registry: `getChatModel` / `getChatModelFromDB` / `invalidateModelCache`, LRU + 60s cross-process TTL tradeoff, seeded `default` row, env fallback.
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
