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

Note: this template uses `useLangGraphRuntime` from `@assistant-ui/react-langgraph` (LangGraph transport wrapping `@langchain/langgraph-sdk`) rather than `useChatRuntime` (AI SDK transport), and renders a full-page `Thread` rather than a modal.

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
- `ALCHEMY_API_KEY` — server-only, used by `app/api/alchemy/[...path]` to proxy JSON-RPC. Required for the price-card USD valuation (CoinGecko USD prices are converted through Alchemy `eth/usd`).
- `ALCHEMY_DISABLED_NETWORKS` — optional comma-separated Alchemy network slugs the proxy will reject. Default deny-list lives in `lib/alchemy/networks.ts`.
- `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` — Reown projectId, required for WalletConnect-based wallets (Binance, Bitget) to expose their mobile-QR fallback; injected wallets (MetaMask, Coinbase) work without it.
- `NEXT_PUBLIC_CRYPTO_REAL_SWAP` — feature flag for the live Uniswap V3 swap path. Unset/`false` keeps `place_crypto_order` in SIMULATED mode (Mock Coin balance, no signing, no broadcast). Set `true` to enable the real path (currently dormant).
- `USE_SUBGRAPH` — backend graph topology toggle. `true` uses compiled `weatherAgent` / `chatAgent` / `cryptoAgent` subgraphs; unset (default) uses the inlined version that flattens them into the parent graph. The inlined default is a workaround for the `@langchain/core@1.2.1` `EventStreamCallbackHandler` "Run ID not found in run map" bug that LangGraph JS subgraphs trigger — see `memory/langgraph-subgraph-run-map-bug.md`.
- `NEXT_PUBLIC_USE_SUBGRAPH` — frontend mirror of `USE_SUBGRAPH`. Required because Next.js only inlines `NEXT_PUBLIC_*` vars into the browser bundle; the frontend reads this to decide whether to render the interrupt-UI card (`InterruptUI`) or the inline tool-call card.

LangGraph CLI also reads `.env.local` (`langgraph.json` → `env: ".env.local"`) and pins Node 22.

## Architecture

```
backend/
  agent.ts                LangGraph graph — two topologies gated by USE_SUBGRAPH
  state.ts                RouterAgentState (parent) + CommonAgentState (subgraphs)
  model.ts                ChatOpenAI singletons (chatModel + chatModelWithoutThink)
  checkpointer.ts         PostgresSaver (LangGraph Postgres checkpoint tables)
  agent/
    chat-agent.ts         chatAgent compiled subgraph (USE_SUBGRAPH=true path)
    weather-agent.ts      weatherAgent compiled subgraph (USE_SUBGRAPH=true path)
    crypto-agent.ts       cryptoAgent compiled subgraph (USE_SUBGRAPH=true path)
  node/
    call-model-node.ts    "agent" node — calls the model, appends AI reply
    rename-thread-agent-node.ts "renameThreadAgent" node — generates + persists the title
    router-agent-node.ts  "routerAgent" — picks weatherAgent / chatAgent / cryptoAgent per turn
    after-agent-node.ts   "afterAgent" — touches threads.last_message_at
  prompt/system.ts        CHAT_AGENT_PROMPT, WEATHER_AGENT_PROMPT, CRYPTO_AGENT_PROMPT, ROUTER_AGENT_PROMPT, RENAME_THREAD_PROMPT
  tool/                   ask_location, geocode_location, get_weather, searchWeb, fetchUrl
  tool/crypto/            get_crypto_price, get_fx_rate, get_token_balances, connect_wallet, place_crypto_order, get_order_status
langgraph.json            CLI config: graph id, node version, env file
app/                      Next.js App Router
  layout.tsx              Root layout, fonts, TooltipProvider
  page.tsx                Renders <Assistant /> in a full-viewport <main>
  assistant.tsx           Builds useLangGraphRuntime; chooses /api vs direct URL
  web3-providers.tsx      wagmi/RainbowKit QueryClient + WagmiProvider wrappers
  api/[..._path]/route.ts Edge catch-all proxy to LANGGRAPH_API_URL
  api/alchemy/[...path]/route.ts Server-only JSON-RPC proxy to Alchemy (with key + per-network disabled list)
  api/alchemy/status/route.ts Returns Alchemy key health + disabled-network list
  globals.css             Tailwind v4 entry
components/
  assistant-ui/           Chat primitives (thread, attachment, markdown, reasoning, tool-fallback, tool-group, tooltip-icon-button)
  ui/                     shadcn/ui primitives (avatar, button, collapsible, dialog, tooltip) — new-york style, lucide icons
  ui/address-or-hash.tsx  Truncated address/hash with copy-to-clipboard
  tool-ui/ask-location/   Interrupt-driven or addResult-driven location picker card
  tool-ui/weather/        Forecast widget renderer (vendored runtime + container + overlay)
  tool-ui/crypto/         Price, connect-wallet, place-order, order-status cards
lib/utils.ts              cn() = twMerge(clsx(...))
lib/threads/              Threads module (schema, queries, adapter, validators)
lib/wagmi.ts              wagmi/RainbowKit config (chains, connectors, WalletConnect projectId)
lib/alchemy/              networks.ts (slug → Alchemy URL + disabled list) + portfolio.ts (RPC helpers)
lib/prices/coingecko.ts   CoinGecko free-tier price client (60s in-memory cache)
lib/decimal.ts            Decimal-based amount math for crypto (no native float)
```

### Backend graph (`backend/agent.ts`)

The parent graph dispatches a router decision into one of three sub-flows, all ending in `afterAgent`:

- `routerAgent` — calls `chatModel.withStructuredOutput(RouteDecisionSchema, { method: "jsonSchema" })` (tagged `nostream` so partial tokens don't leak into the chat) and returns `{ routerDecision: { next: "weatherAgent" | "chatAgent" | "cryptoAgent" } }` for the conditional edge to read.
- `weatherAgent` / `chatAgent` / `cryptoAgent` — a model → tools loop driven by `toolsCondition`. Exits to `afterAgent` when the model emits no `tool_calls`.
- `afterAgent` — touches `threads.last_message_at` for the current thread; no message-channel writes.
- `renameThreadAgent` — fans out from `START` (parallel to `routerAgent`), generates the thread title on the first turn only, persists it to the `threads` row.

Two topologies share the same router + rename + after nodes and are gated by `USE_SUBGRAPH` (env var, see Environment):

- **Inlined (default).** `weatherModel` / `weatherTools` / `chatModel` / `chatTools` / `cryptoModel` / `cryptoTools` are inlined as plain nodes in the parent graph. The model/tool logic is duplicated from `backend/agent/weather-agent.ts`, `chat-agent.ts`, and `crypto-agent.ts` — keep them in sync. The router's pathMap remaps `"weatherAgent"`/`"chatAgent"`/`"cryptoAgent"` (the router's string enum) to `"weatherModel"`/`"chatModel"`/`"cryptoModel"` (the inlined node names).
- **Subgraph (`USE_SUBGRAPH=true`).** The compiled `weatherAgent`, `chatAgent`, and `cryptoAgent` from `backend/agent/*-agent.ts` are wired as opaque nodes via `addNode("weatherAgent", weatherAgent)`. PathMap is an array of allowed destinations, since the returned string already matches the node name.

Both builders live in `backend/agent.ts` (`buildSubgraph()` and `buildInlined()`). When `USE_SUBGRAPH` flips, no other file needs to change — but if you add a node, prompt, or tool, update both builders.

The chat models in `backend/model.ts` carry `modelKwargs: { reasoning_split: true }` (and `think: false` on the rename variant) — these are minimax-provider-specific, so the graph is wired for that provider via `OPENAI_BASE_URL`, not stock OpenAI. `streaming: true` is set on `chatModel`. Node 22, ESM/TypeScript, executed directly by `langgraphjs dev` via the `backend/agent.ts:graph` export registered in `langgraph.json`.

### `WEATHER_AGENT_PROMPT` enforces one-tool-per-turn

The weather prompt (in `backend/prompt/system.ts`) lists four steps in order — `ask_location` → `geocode_location` → `get_weather` → one-sentence reply — and explicitly forbids batching tools in a single turn. The frontend card (`components/tool-ui/ask-location`) keys off the `ask_location` `ToolMessage`, so any tool run alongside it would race the human input. See `docs/INTERRUPT.md` for the two runtime paths the card can take.

### `CRYPTO_AGENT_PROMPT` enforces one-tool-per-turn + no-investment-advice

Same one-tool-per-turn discipline as weather, applied to the trade flow: `connect_wallet` → `place_crypto_order` → `get_order_status` are HARD checkpoints, each pauses for one user click. `place_crypto_order` is gated by a "no fiat amounts" rule — when the user names a dollar/yuan/euro amount, the agent declines rather than quoting. The prompt also hard-blocks investment advice: no "buy now", no price-direction predictions, no "good entry", no editorializing on token quality; the agent describes only what the user asked and what the card does. The cards render numbers — the prose never repeats them.

### State persistence (dev vs prod)

The checkpointer active for a run is chosen by the runner, not by us:

- `langgraphjs dev` (port 2024) replaces the compiled `PostgresSaver` with its own `InMemorySaver`, flushed to `.langgraph_api/.langgraphjs_api.checkpointer.json` on every write. The Postgres `checkpoints` table stays empty in dev.
- `langgraphjs start` / LangSmith Deployment uses the compiled `PostgresSaver` from `backend/checkpointer.ts` and writes to the `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` tables.

This split is upstream design — see langchain-ai/langgraph#5790, #5360, #5661. There is no `langgraph.json` field that pins the dev server to Postgres (Python's `checkpointer.path` has not been ported to JS as of `@langchain/langgraph-cli@1.3.1`).

Consequences worth knowing:

- `POST /api/threads` calls `langGraphClient.threads.create(...)` to register the new id with the dev server's in-process STORE; in prod the call hits a LangGraph Deployment that knows the id from the compiled `PostgresSaver` directly, so it's effectively a no-op there. Don't remove it without checking dev.
- `last_message_at` is `now()` written by `afterAgentNode`, not a derived value from any checkpoint table.
- `DELETE /api/threads/[id]` removes only the metadata row; the dev JSON file or prod checkpoint tables are cleaned up by the runner's own ops layer (not by us).

### Frontend runtime

`app/assistant.tsx` is a client component. It instantiates the runtime with `useLangGraphRuntime({ stream, create, load })` from `@assistant-ui/react-langgraph` (which wraps `@langchain/langgraph-sdk`'s `Client`). `stream` is built from `unstable_createLangGraphStream`; `apiUrl` is `NEXT_PUBLIC_LANGGRAPH_API_URL` if set, otherwise the same-origin `/api` URL.

`app/api/[..._path]/route.ts` is an edge-runtime catch-all that proxies every method (`GET/POST/PUT/PATCH/DELETE/OPTIONS`) to `${LANGGRAPH_API_URL}/${path}` with `x-api-key: LANGCHAIN_API_KEY`, strips hop-by-hop / content-encoding headers, and adds permissive CORS. The body of mutating requests is forwarded as text.

`components/assistant-ui/thread.tsx` mounts `InterruptUI` (uses `useLangGraphInterruptState` + `useLangGraphSendCommand`) inside the last assistant message. The interrupt-driven render only fires when `NEXT_PUBLIC_USE_SUBGRAPH=true`; in default (inlined) mode, the ask_location card renders in the tool-call slot instead. See `docs/INTERRUPT.md` for the full two-mode flow.

### Web3 providers

`app/layout.tsx` wraps the assistant tree in `<Web3Providers>` (`app/web3-providers.tsx`), which stacks `@tanstack/react-query` `QueryClientProvider`, `WagmiProvider` (configured by `lib/wagmi.ts`), and RainbowKit's `RainbowKitProvider`. Wallet state is global to the browser; the crypto cards read `address` / `chainId` from wagmi hooks directly — they never receive the wallet through tool args. The trade flow is fully SIMULATED regardless of wallet connectivity: `place_crypto_order` auto-funds Mock Coin on the first trade and synthesizes the order on click. Setting `NEXT_PUBLIC_CRYPTO_REAL_SWAP=true` is required to route through any real DEX path (currently dormant — wagmi hooks live in the React tree, so a server-side router alone can't reach them).

### Patches

`patches/` is currently empty. `pnpm-workspace.yaml` retains the `patchedDependencies:` header as a placeholder — when you need to patch a package, add the entry there and drop the `.patch` file under `patches/`. Re-check on every package bump; drop the entry + file when upstream ships the fix.

Previously patched (no longer needed — upstream caught up):

- `@assistant-ui/core@0.2.18` — guards `part.text?.trim()` to tolerate missing text on `text`/`reasoning` parts.
- `@assistant-ui/react-langgraph@0.14.9` — surfaces `__interrupt__` and message updates from subgraph events so the toolkit can render the matching tool-call card.

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

### 5. Comments are short and explain why, not what

Code comments should be sparse, short, and reserved for things that are non-obvious or easy to get wrong. Default to no comment.

Keep a comment only when it records:

- A non-obvious design constraint or invariant the code alone doesn't show (e.g. `// useLangGraphRuntime keeps _mainThreadId on the placeholder until initialize() resolves — see #2577`).
- A workaround for a third-party API quirk the next reader would otherwise re-discover (e.g. `// switchToThread is typed void but returns a Promise at runtime`).
- A subtle race condition or ordering dependency (e.g. `// effect must run before the write effect on first commit`).
- The single sentence of "why" behind a non-trivial algorithm, when the algorithm itself is already short.

Delete a comment that:

- Restates what the code does (`// loop over items` above `for (const item of items)`).
- Narrates a sequence the reader can follow (`// fetch user, then fetch posts, then merge`).
- References "the official example", "the migration plan", or any process-of-writing artifact — code outlives the process that produced it.
- Documents a function name that's already self-explanatory (`Logo`, `MobileSidebar`).

When in doubt, leave it out. A diff that's 80% code and 20% comment is fine; 50/50 is a code smell.

### 6. Tool-call UI components stay flush with their container

Components rendered inside a tool-call part (`components/tool-ui/**`) live inside `ToolFallbackContent`, which already provides `ps-6 pt-1 pb-2` padding and no horizontal margin. Inner cards must not add their own horizontal margin or drop shadow — they would compete with the tool-call chrome and produce a double-bordered look.

Rules for tool-call children:

- No `mx-*` (the container's `ps-6` is the only left margin; do not add a right margin either).
- No `shadow-*` (the container has no shadow; neither should the child).
- Vertical `my-*` is fine when the tool call stacks next to other parts.
- Border + rounded corners are still allowed for visual grouping inside the tool call.

### 7. Never kill or restart a dev server that's already running

Before running `pnpm dev` (or starting any dev server), check whether the relevant port is already bound (`lsof -i :3000` for Next.js, `:2024` for LangGraph). If it is, that is the developer's active dev environment — **do not kill it, do not restart it**. Reuse it via Chrome DevTools MCP for any visual verification.

Killing a running dev server loses unsaved browser state, breaks open browser tabs, and erases hot-reload history. If the dev server appears stale or stuck, surface the observation and ask the developer how they want to proceed; do not act unilaterally.

### 8. Tool-UI buttons are text-only — no icons

Buttons inside `components/tool-ui/**` (and any new card added under that directory) render the label as the action. Do not put a Lucide icon (or any other icon) as a prefix to the label, even with `gap-2` to space them out. No `<MapPinIcon/>`, `<WalletIcon/>`, etc. inside `<Button>` children.

Icon-only controls (`size="icon"` or equivalent) are fine when there is no label to attach the icon to (e.g. the search-submit magnifier in `ask-location-card`). Decorative icons elsewhere in the card — header avatars, status row glyphs, inline spinners — are not affected by this rule.

Rationale: the tool-ui cards are short-lived surfaces with one or two clear actions. Icons + text compete for attention and bloat the layout without adding signal. Text-only buttons stay scannable and match the rest of the assistant-ui primitives.

## Things to know before editing

- The graph id `agent` is referenced in three places: `langgraph.json` (`graphs.agent`), `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` in `.env.example`, and the `unstable_createLangGraphStream({ assistantId })` call. Keep them aligned.
- The proxy hardcodes `runtime = "edge"`; any Node-only API in the route would break the build.
- `modelKwargs.reasoning_split` is provider-specific. If you switch back to stock OpenAI, remove it (or guard it) — OpenAI ignores unknown kwargs but it'll be a lie in the source.
- `components.json` declares a `@assistant-ui` registry at `https://r.assistant-ui.com/{name}.json` for `shadcn`-style component adds.

<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at `specs/001-user-auth/plan.md` (and `spec.md`, `research.md`,
`data-model.md`, `quickstart.md`, `contracts/`).

<!-- SPECKIT END -->
