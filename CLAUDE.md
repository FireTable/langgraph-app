# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

assistant-ui starter for LangGraph. A minimal chat app that streams tokens from a LangGraph `StateGraph` agent into an [assistant-ui](https://github.com/assistant-ui/assistant-ui) React thread.

## assistant-ui

This project uses assistant-ui for chat interfaces.
Documentation: https://www.assistant-ui.com/llms-full.txt
Key patterns:

- Use AssistantRuntimeProvider at the app root
- Thread component for full chat interface
- AssistantModal for floating chat widget
- useChatRuntime hook with AI SDK transport

Note: this template uses `useStreamRuntime` from `@assistant-ui/react-langchain` (LangChain transport) rather than `useChatRuntime` (AI SDK transport), and renders a full-page `Thread` rather than a modal.

## Commands

Package manager is **pnpm** (workspace enabled, see `pnpm-workspace.yaml`).

- `pnpm install` — install deps. Patches under `patches/` are applied automatically (via `pnpm-workspace.yaml` `patchedDependencies`).
- `pnpm dev` — runs `dev:frontend` and `dev:backend` concurrently. Frontend on `:3000`, LangGraph dev server on `:2024`.
- `pnpm dev:frontend` — `next dev --turbopack` only.
- `pnpm dev:backend` — `langgraphjs dev` only (serves the `agent` graph defined in `langgraph.json`).
- `pnpm build` — `next build` (production frontend).
- `pnpm start` — `next start`.
- `pnpm lint` — `oxlint && oxfmt --check`.
- `pnpm lint:fix` — `oxlint --fix && oxfmt`.
- `pnpm format:fix` — `oxfmt` (write). `pnpm format` is `--check` only.
- `pnpm test` — Vitest once. `NODE_ENV=test` reads `.env.test`; the globalSetup applies migrations to `langgraph_app_test`.
- `pnpm test:watch` — Vitest in watch mode.
- `pnpm db:generate` — generate a new SQL migration from the Drizzle schema.
- `pnpm db:migrate` — apply pending migrations to `DATABASE_URL`.
- `pnpm db:studio` — open Drizzle Studio.
- `pnpm db:reset` — drop the database (Drizzle Studio only manages our business tables; LangGraph's checkpoint tables are recreated by `PostgresSaver.setup()` at backend startup).

## Environment

Copy `.env.example` to `.env.local` and fill in:

- `OPENAI_API_KEY` — required for the agent to run.
- `OPENAI_MODEL` — optional, defaults to `gpt-4o-mini`.
- `OPENAI_BASE_URL` — optional, swap to an OpenAI-compatible endpoint.
- `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` — optional tracing.
- `LANGGRAPH_API_URL` — defaults to `http://localhost:2024`. The Next.js `/api/[..._path]` proxy forwards here.
- `LANGCHAIN_API_KEY` — sent as `x-api-key` by the proxy; leave blank for local dev.
- `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` — graph id, must match a key in `langgraph.json` (`agent`).
- `NEXT_PUBLIC_LANGGRAPH_API_URL` — optional. If set, the browser skips the `/api` proxy and talks to LangGraph directly. Leave unset to use the in-app proxy.

LangGraph CLI also reads `.env.local` (`langgraph.json` → `env: ".env.local"`) and pins Node 22.

## Architecture

```
backend/agent.ts          LangGraph graph (StateGraph + single "agent" node)
langgraph.json            CLI config: graph id, node version, env file
app/                      Next.js App Router
  layout.tsx              Root layout, fonts, TooltipProvider
  page.tsx                Renders <Assistant /> in a full-viewport <main>
  assistant.tsx           Builds useStreamRuntime; chooses /api vs direct URL
  api/[..._path]/route.ts Edge catch-all proxy to LANGGRAPH_API_URL
  globals.css             Tailwind v4 entry
components/
  assistant-ui/           Chat primitives (thread, attachment, markdown, reasoning, tool-fallback, tool-group, tooltip-icon-button)
  ui/                     shadcn/ui primitives (avatar, button, collapsible, dialog, tooltip) — new-york style, lucide icons
lib/utils.ts              cn() = twMerge(clsx(...))
```

### Backend graph (`backend/agent.ts`)

A `StateGraph(MessagesAnnotation)` with a single `agent` node that calls `ChatOpenAI` and returns the response message. The model is constructed with `modelKwargs: { reasoning_split: true }` — comment in the file says "only minimax will use this params", so this is wired for the `minimax` provider via `OPENAI_BASE_URL`, not stock OpenAI. `streaming: true` is set. Node 22, ESM/TypeScript, executed directly by `langgraphjs dev` via the `backend/agent.ts:graph` export registered in `langgraph.json`.

### Frontend runtime

`app/assistant.tsx` is a client component. It instantiates the runtime with `useStreamRuntime({ assistantId, apiUrl })` from `@assistant-ui/react-langchain` (which wraps `useStream` from `@langchain/react`). `apiUrl` is `NEXT_PUBLIC_LANGGRAPH_API_URL` if set, otherwise the same-origin `/api` URL.

`app/api/[..._path]/route.ts` is an edge-runtime catch-all that proxies every method (`GET/POST/PUT/PATCH/DELETE/OPTIONS`) to `${LANGGRAPH_API_URL}/${path}` with `x-api-key: LANGCHAIN_API_KEY`, strips hop-by-hop / content-encoding headers, and adds permissive CORS. The body of mutating requests is forwarded as text.

### Patches

`patches/` is non-empty and applied via `pnpm-workspace.yaml`:

- `@assistant-ui/core@0.2.18` — guards `part.text?.trim()` to tolerate missing text on `text`/`reasoning` parts.
- `@assistant-ui/react-langchain@0.0.15` — guards `part.summary?.map(...)` so the converter doesn't crash when `summary` is absent.

When bumping those packages, re-check whether the patches still apply; if not, drop the patch entry from `pnpm-workspace.yaml` and delete the file.

### Styling

Tailwind v4 via `@tailwindcss/postcss` (PostCSS plugin only, no `tailwind.config.js`). `app/globals.css` is the stylesheet entry. `cn()` from `lib/utils.ts` is the only util. Path alias `@/*` → repo root (see `tsconfig.json`).

## Engineering rules

These are non-negotiable. They apply to every change.

### 1. API documentation must stay in sync

Every HTTP endpoint under `app/api/` is documented in `docs/APIS.md`. **Any change to a route — request shape, response shape, status codes, semantics — must update the doc in the same commit.** The doc is the contract for the frontend, future contributors, and any external integrators. A change that drifts from the doc is a bug.

When adding a new endpoint:

1. Add the route handler.
2. Add or update the matching Zod validator (in `lib/<module>/validators.ts`).
3. Add tests in `tests/api/`.
4. **Add a section to `docs/APIS.md`** before committing.

### 2. TDD is mandatory for new code

For every new function, route, or schema:

1. Write the failing test first (`pnpm test` → RED).
2. Write the minimum implementation to pass (`pnpm test` → GREEN).
3. Refactor with the test still green.

Skip TDD only when the code is purely declarative (type-only changes, config files, prose docs). Any code with logic — including pure validation logic, queries, and route handlers — gets tests first.

Coverage targets:

- `lib/<module>/queries.ts` and `validators.ts`: ≥ 90%.
- `app/api/**/route.ts`: every status code path covered, including 400 / 404.

### 3. Best practices over middle-ground solutions

When investigating how to solve a problem, **find the canonical, community-standard approach first**. No "good enough for now" compromises that we'll have to redo.

Examples:

- env loading: use `@next/env`, not a hand-rolled `dotenv.config({ path })` call.
- ORM migrations: use `drizzle-kit`, not a custom script that scans `migrations/`.
- thread list adapter: use `RemoteThreadListAdapter` from `@assistant-ui/react`, not a parallel implementation.

If the canonical approach has friction (e.g. setup overhead), surface the trade-off explicitly and let the user decide — don't quietly substitute a workaround.

### 4. Frontend UI changes must be visually verified

Pure code edits to React components, Tailwind classes, layout primitives, or anything that affects what the user sees in the browser **must be visually verified before claiming done**. "Looks right" is not a substitute for running it.

Acceptable verification methods, in order of preference:

1. **Chrome DevTools MCP** (`mcp__chrome-devtools__*`) — load the page, take a screenshot, compare against the reference. Use this for any visible change in `app/`, `components/`, or styling.
2. **Playwright** — for repeatable end-to-end flows (login, send message, switch thread, etc.). Add a test under `tests/e2e/` and run it.
3. **Manual verification by the user** — only when neither of the above is feasible; the user must explicitly confirm the change matches their expectation.

For backend / database / pure-logic changes, `pnpm test` plus type-checking is enough — no browser required.

## Things to know before editing

- The graph id `agent` is referenced in three places: `langgraph.json` (`graphs.agent`), `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` in `.env.example`, and the `useStreamRuntime({ assistantId })` call. Keep them aligned.
- The proxy hardcodes `runtime = "edge"`; any Node-only API in the route would break the build.
- `modelKwargs.reasoning_split` is provider-specific. If you switch back to stock OpenAI, remove it (or guard it) — OpenAI ignores unknown kwargs but it'll be a lie in the source.
- `components.json` declares a `@assistant-ui` registry at `https://r.assistant-ui.com/{name}.json` for `shadcn`-style component adds.
