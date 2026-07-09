# CLAUDE.md

Guidance for Claude Code in this repo. For features, quick-start, project
layout, env vars, and tech stack → `README.md`. For design notes → `docs/`.

## Docs index

| Topic                                           | File                    |
| ----------------------------------------------- | ----------------------- |
| Features, quick-start, layout, env vars, deps   | `README.md`             |
| Marketing landing page sections + assets        | `docs/LANDING.md`       |
| Every HTTP endpoint under `app/api/`            | `docs/APIS.md`          |
| Memory + thread-summarize design                | `docs/MEMORY.md`        |
| Observability panel design + retention          | `docs/OBSERVABILITY.md` |
| LangGraph tool inventory + frontend card wiring | `docs/TOOLS.md`         |
| Interrupt-driven tool flow contract             | `docs/INTERRUPT.md`     |
| Attachments backing (R2 + presign) design       | `docs/ATTACHMENTS.md`   |
| Auth setup, OAuth, troubleshooting              | `docs/AUTH.md`          |
| DB schema, ownership, indexes                   | `docs/DB.md`            |
| CI/CD, Docker, deploys                          | `docs/CI.md`            |
| Open follow-ups / parked decisions              | `docs/TODOS.md`         |

**API changes update `docs/APIS.md` in the same commit (rule #1).**
**Tool changes update `docs/TOOLS.md` (rule #10).**

## assistant-ui

Uses `useLangGraphRuntime` from `@assistant-ui/react-langgraph` (LangGraph
transport wrapping `@langchain/langgraph-sdk`), NOT `useChatRuntime`.
Renders full-page `<Thread>`, not `<AssistantModal>`. See the `assistant-ui`
skill for details.

## Commands

Package manager: **pnpm** (workspace enabled, `pnpm-workspace.yaml`).

- `pnpm dev` — frontend + LangGraph dev server (`:3000` + `:2024`).
- `pnpm test` — Vitest once. `NODE_ENV=test` reads `.env.test`;
  `tests/setup.ts` applies migrations to the test DB.
- `pnpm lint` / `lint:fix` / `format` / `format:fix`.
- `pnpm db:generate` / `db:migrate` / `db:studio` / `db:reset` (reset
  drops `public` schema; LangGraph checkpoint tables are recreated by
  `PostgresSaver.setup()` at backend startup).

Full table: `README.md § Development`.

## Environment

Full table: `README.md § Environment variables`. Notable specifics:

- `OPENAI_API_KEY` required. `OPENAI_BASE_URL` swaps to an
  OpenAI-compatible endpoint.
- Chat models in `backend/model.ts` carry
  `modelKwargs: { reasoning_split: true }` — provider-specific, NOT stock
  OpenAI. Strip it if you switch providers.
- `DENO_DEPLOY_TOKEN` + optional `DENO_DEPLOY_ORG` — for `execute_code`
  via Deno Deploy Sandbox (TS/JS via `deno eval`, Python via
  `python3 -c`, sandbox ships CPython 3.13 stdlib). Personal tokens
  (prefix `ddp_`) also need `DENO_DEPLOY_ORG` (the org slug from the
  console URL). When unset, `execute_code` is not registered (rule #10)
  — `write_code` still works and the model surfaces a graceful fallback.
  Token at <https://console.deno.com/> → Sandbox tab.

## Backend graph

Two compiled graphs, both registered in `langgraph.json`:

- **`agent`** (`backend/agent.ts`, `name: "mainAgent"`) — chat graph.
  - `START → routerAgent → (sub-agent) → triggerBackgroundAgent → END`
  - `START → renameThreadAgent` (parallel leaf; skipped once
    `threads.title !== DEFAULT_THREAD_TITLE` via `shouldRenameRouter`)
- **`background_agent`** (`backend/background-agent.ts`,
  `name: "backgroundAgent"`) — turn-end side-effects. Linear:
  `START → touchLastMessage → summarize → END`.

`triggerBackgroundAgentNode` HTTP-dispatches via SDK `runs.create` (NOT
in-process `graph.invoke` — that would share the chat run's
`AbortSignal` and die the moment the stream ends). Stamps
`metadata.parent_message_id` so the observability per-turn GET can
scope `runs.list(threadId, …)`.

Both graphs share the singleton `capturingHandler` from
`backend/callbacks.ts`, so bg-agent spans land in the same per-turn
waterfall as the chat run.

Sub-agents in `backend/agent/*-agent.ts` (`weatherAgent`, `chatAgent`,
`cryptoAgent`, `codeAgent`) are compiled `StateGraph`s wired as opaque
nodes. The conditional edge reads `state.routerDecision.next` — the
returned string already matches the node name. **Adding a sub-agent
means updating the enum in BOTH `state.ts` AND `router-agent-node.ts`
AND `agent.ts` routeToSubAgent union** (or parsing throws — see
[[router-decision-schema-duplicated]]).

Sub-agent prompts (in `backend/prompt/system.ts`) enforce
one-tool-per-turn (weather + crypto) and no-investment-advice (crypto).
The chat cards (`components/tool-ui/ask-location`, crypto cards) key
off the matching `ToolMessage`, so any tool run alongside them would
race the human input. See `docs/INTERRUPT.md` for the resume contract.

When you add a node, prompt, or tool, update `backend/agent.ts` plus
the matching `backend/agent/*-agent.ts` subgraph.

## State persistence (dev vs prod)

Checkpointer is chosen by the runner, not by us:

- `langgraphjs dev` (`:2024`) uses an `InMemorySaver` flushed to
  `.langgraph_api/.langgraphjs_api.checkpointer.json`. The Postgres
  `checkpoints` table stays empty in dev.
- `langgraphjs start` / LangSmith Deployment uses the compiled
  `PostgresSaver` from `backend/checkpointer.ts`.

There is no `langgraph.json` field that pins dev to Postgres
(`@langchain/langgraph-cli@1.3.1` hasn't ported Python's
`checkpointer.path`).

Consequences:

- `POST /api/threads` calls `langGraphClient.threads.create(...)` to
  register the new id with the dev server's in-process store; in prod
  it's a no-op. Don't remove it without checking dev.
- `last_message_at` is `now()` written by `touchLastMessageNode` on
  the background graph, NOT derived from any checkpoint table.
- `DELETE /api/threads/[id]` removes only the metadata row; the
  runner cleans up its own checkpoint tables.

## Frontend runtime

`app/assistant.tsx` is a client component using
`useLangGraphRuntime({ stream, create, load })`. `stream` comes from
`unstable_createLangGraphStream`. `apiUrl` is
`NEXT_PUBLIC_LANGGRAPH_API_URL` if set (browser → LangGraph direct),
otherwise the same-origin `/api` URL (proxied).

`app/api/[..._path]/route.ts` is a node-runtime catch-all wrapped in
`withAuth` (rule #9) that proxies to `${LANGGRAPH_API_URL}/${path}`
with `x-api-key: LANGCHAIN_API_KEY`. Strips hop-by-hop /
content-encoding headers, adds permissive CORS, forwards body as text.

## Web3 providers

`app/layout.tsx` wraps the tree in `<Web3Providers>`
(`app/web3-providers.tsx`): `QueryClientProvider` → `WagmiProvider`
(`lib/wagmi.ts`) → `RainbowKitProvider`. Wallet state is global;
crypto cards read `address` / `chainId` from wagmi hooks directly —
never through tool args. Trade flow is fully SIMULATED regardless of
wallet connectivity (`place_crypto_order` auto-funds Mock Coin on
first trade).

## Observability

Full design: `docs/OBSERVABILITY.md`. Gotchas worth keeping in mind:

- `parent_message_id` column is nullable + indexed under
  `(thread_id, parent_message_id, started_at)`. Backfilled from
  `meta.parent_message_id` in `bulkInsertSpans`; pre-backfill /
  interrupt-resume rows keep NULL and intentionally 404 against the
  per-turn detail endpoint.
- `FORBIDDEN` regex in `bulkInsertSpans` rejects any row whose
  `JSON.stringify` matches
  `api[_-]?key | _password | ^password$ | _secret$ | ^secret$ | baseURL | organization | bearer <token>`.
  Fail-closed — adding a provider argument that trips the regex stops
  the write until it's whitelisted.
- `observability_spans` FK → `threads(id) ON DELETE CASCADE`. Delete
  the thread row, spans drop with it.
- Retention: env `OBSERVABILITY_RETENTION_DAYS` (default 30, positive
  int). Physical delete via
  `pnpm exec tsx scripts/cleanup-observability.ts`. System cron is
  the operator's responsibility.
- `collectRootChains` keys by `run_id` (not `parent_span_id`) to drop
  the duplicate `streamSubgraphs: true` inner wrapper that shares the
  outer `meta.run_id` — see [[langgraph-subgraph-run-map-bug]].

## Styling

Tailwind v4 via `@tailwindcss/postcss` (no `tailwind.config.js`).
`app/globals.css` is the stylesheet entry. `cn()` from `lib/utils.ts`
is the only util. Path alias `@/*` → repo root (`tsconfig.json`).

## Engineering rules

Non-negotiable. Every change.

### 1. API documentation must stay in sync

Every route under `app/api/` is documented in `docs/APIS.md`. **Any
change — request shape, response shape, status codes, semantics —
updates the doc in the same commit.** Drift is a bug.

When adding a new endpoint:

1. Route handler.
2. Zod validator in `lib/<module>/validators.ts`.
3. Tests in `tests/api/`.
4. **Section in `docs/APIS.md` before committing.**

### 2. TDD is mandatory for new code

For every new function, route, or schema:

1. Failing test first (`pnpm test` → RED).
2. Minimum impl to pass (GREEN).
3. Refactor with the test still green.

Skip TDD only for declarative changes (types, config, prose).
Coverage:

- `lib/<module>/queries.ts` + `validators.ts`: ≥ 90%.
- `app/api/**/route.ts`: every status code path covered, including
  400/404.

### 3. Best practices over middle-ground solutions

Find the canonical, community-standard approach first. No "good
enough for now" we'll redo. Examples:

- env loading: `@next/env`, not hand-rolled `dotenv.config({ path })`.
- ORM migrations: `drizzle-kit`, not a custom script.
- thread list: `RemoteThreadListAdapter` from `@assistant-ui/react`.

If the canonical has friction, surface the trade-off and let the user
decide.

### 4. Frontend UI changes must be visually verified

Pure code edits to React, Tailwind, layout — anything visible —
**must be visually verified before claiming done**. "Looks right" is
not a substitute for running it.

In order of preference:

1. **Chrome DevTools MCP** — load the page, screenshot, compare.
2. **Playwright** — for repeatable flows. Add a test under
   `tests/e2e/`.
3. **User manual confirmation** — only when neither is feasible;
   user explicitly confirms.

Backend / DB / pure-logic: `pnpm test` + typecheck is enough.

### 5. Comments are short and explain why, not what

Sparse, short. Default to no comment.

Keep only when it records:

- Non-obvious design constraint or invariant.
- Workaround for a third-party API quirk.
- Subtle race condition or ordering dependency.
- Single sentence of "why" behind a non-trivial algorithm.

Delete comments that restate code, narrate a sequence, reference the
writing process, or document a self-explanatory function name. When
in doubt, leave it out.

### 6. Tool-call UI components stay flush with their container

`ToolFallbackContent` provides `ps-6 pt-1 pb-2` with no horizontal
margin. Inner cards (`components/tool-ui/**`):

- No `mx-*`.
- No `shadow-*`.
- Vertical `my-*` is fine for stacking.
- Border + rounded corners are OK for grouping.

### 7. Never kill or restart a running dev server

Before `pnpm dev`, check the port (`lsof -i :3000` for Next.js,
`:2024` for LangGraph). If bound, that's the developer's active
environment — **do not kill it, do not restart it**. Reuse via
Chrome DevTools MCP for visual verification.

If stale or stuck, surface the observation and ask. Don't act
unilaterally.

### 8. Tool-UI buttons are text-only — no icons

`<Button>` children inside `components/tool-ui/**` render the label.
No lucide icon prefix, even with `gap-2`. Icon-only controls
(`size="icon"`) are fine when there's no label to attach (e.g.
search-submit magnifier).

### 9. Every `app/api/**/route.ts` is wrapped in `withAuth`

From `lib/auth/with-auth.ts`. No anonymous traffic. Exceptions: Better
Auth catch-all `app/api/auth/[...all]/route.ts` (login endpoint
itself) and `OPTIONS` preflight in proxy routes.

Why: prior builds left the LangGraph + Alchemy catch-all proxies
unauthenticated — any site could create/list/delete threads or burn
the Alchemy CU quota.

```ts
import { withAuth } from "@/lib/auth/with-auth";
export const GET = withAuth(async (_req, { user }) => NextResponse.json({ ... }));
export const GET = withAuth<{ id: string }>(async (req, { user, params }) => { ... });
```

Runtime: leave default `nodejs`. `withAuth` reads the session row
from Postgres through `drizzle/postgres-js`, which needs Node `net`.
Edge throws `Failed to get session`.

Test mock: mock `next/headers` + `@/lib/auth/config`, default
`getSession` to a logged-in user in `beforeEach`; 401 path uses
`getSession.mockResolvedValueOnce(null)`. See
`tests/api/alchemy/status.test.ts` for the env pattern.

### 10. Tools that need a third-party key MUST be lazy-registered

A tool that calls a third-party API with a server-side key
(`search_web` → `JINA_API_KEYS`, `get_NFT_holdings` → `ALCHEMY_API_KEY`,
`execute_code` → `DENO_DEPLOY_TOKEN`) must:

1. Be `StructuredTool | null`, gated on `process.env.<KEY>` at module
   load.
2. Be spread into `ALL_TOOLS` with `...(tool ? [tool] : [])` —
   missing key drops it; model never sees a tool that would 401 on
   every call.
3. Be documented in `docs/TOOLS.md` under "Tool ↔ API key".

```ts
export const getNftHoldingsTool: StructuredTool | null = process.env.ALCHEMY_API_KEY
  ? tool(impl, { name: "get_NFT_holdings", ... })
  : null;
```

`fetch_url` is the exception — r.jina.ai accepts unauthenticated
requests on the free tier, so `lib/jina.ts` falls through to no-Auth
`fetch` when the pool is empty.

When adding a key-needing tool: update `.env.example` + the
"Tool ↔ API key" table in `docs/TOOLS.md`.

### 11. Use `components/tool-ui/primitives/` for card chrome

Three primitives today: `CardShell` + `CardHeader` (`card.tsx`),
`ErrorBanner` + `SuccessBanner` (`banners.tsx`), `JsonBlock`
(`json-block.tsx`). Start new cards from `<CardShell>` + `<CardHeader>`.
Inline a one-off only when none of these fit.

When you add a primitive, drop it next to the existing three and add
a row to "Shared UI primitives" in `docs/TOOLS.md`.

Two non-obvious details baked in:

- Error `<span>` is `min-w-0 flex-1 break-all` in monospace mode —
  long stack-trace lines (e.g.
  `file:///…/$deno$eval.mts:1:7`) overflow without it.
- Icon inside the circle is a flat lucide at `size-4`, not
  `CheckCircle2Icon` / `AlertCircleIcon` (the circle is already drawn
  by the wrapper; a circle inside a circle looks small).

### 12. Back up the DB before any out-of-app data operation

Any direct DB mutation that **does not go through the app's API or
migration runner** (raw `psql`, one-off `tsx` scripts, ORM
`db.execute(sql\`DELETE/TRUNCATE/DROP …\`)`) is destructive in a way
the app's safety nets don't cover — no schema version gate, no auth
check, no audit row. Treat every such command as recoverable-or-it-
didn't-happen:

1. **Snapshot first.** `pg_dump -Fc "$DATABASE_URL" -f
~/.local/db-snapshots/langgraph_app-$(date +%Y%m%d-%H%M%S).dump` —
   the `-Fc` (custom) format compresses well and `pg_restore` reads
   it back losslessly. The dev DB on `localhost:5432` is the obvious
   target; the test DB on the same host but a different db name is
   the same story.
2. **Verify the URL points where you think it does** before any
   destructive keyword (`DROP`, `TRUNCATE`, `DELETE`, `ALTER … DROP
COLUMN`). The DB name in the URL is the only safety net — print
   the URL (or `current_database()`) and confirm it's the dev DB,
   not prod, not test.
3. **Prefer the smallest scope.** `DELETE FROM attachments WHERE
status='pending' AND created_at < now() - interval '1 day'` over
   `TRUNCATE attachments`. `DROP COLUMN` after `pg_dump` over `DROP
TABLE`. Never `DROP SCHEMA public CASCADE` against any DB unless
   the user explicitly said "wipe everything, I have a backup".
4. **If a destructive op fails partway, stop and surface the state**
   rather than trying a second fix. A failed migration is debuggable;
   a half-migrated DB that's been re-dropped is not.

The migration runner (`scripts/db-migrate.ts`, `pnpm db:migrate`) and
the API routes are exempt — they have their own idempotency and
versioning. The rule is for **one-off** mutations an AI agent (or a
human chasing a bug) might reach for.

A helper script lives at `scripts/db-snapshot.sh` (one-liner around
`pg_dump` above) — call it before any DELETE/TRUNCATE/DROP unless the
user has just told you the data is throwaway.

## Things to know before editing

- Graph id `agent` is referenced in three places: `langgraph.json`
  (`graphs.agent`), `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` in
  `.env.example`, and `unstable_createLangGraphStream({ assistantId })`.
  Keep aligned.
- The proxy used to hardcode `runtime = "edge"`; changed to `nodejs`
  so `withAuth` can hit Postgres. If you need edge back, route session
  through a header (set in middleware) — see rule #9 for why.
- `components.json` declares a `@assistant-ui` registry at
  `https://r.assistant-ui.com/{name}.json` for `shadcn`-style
  component adds.
- `pnpm-workspace.yaml` keeps a `patchedDependencies:` header as a
  placeholder. When you patch a package, add the entry there and drop
  the `.patch` under `patches/`. Re-check on every bump; drop when
  upstream ships the fix. Previously patched (upstream caught up):
  `@assistant-ui/core@0.2.18`, `@assistant-ui/react-langgraph@0.14.9`.
- On `feat/*` branches, `git fetch origin main` and merge if main
  moved before committing — see [[feature-branch-tracks-main]].
- Issue titles use a `[Type]:` prefix (`[Bug]:`, `[Feat]:`, `[Docs]:`,
  `[Chore]:`, `[Perf]:`, `[Refactor]:`, `[Test]:`, `[Question]:`) so
  the queue scans cleanly. Match the same name as the `gh` label
  applied to the issue.
