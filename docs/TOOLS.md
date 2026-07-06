# Tools

Inventory of every LangGraph tool the agent can call, and the matching
frontend card (if any). Backend definitions live under `backend/tool/`; the
single source of truth that wires them into the graph is `backend/tool/index.ts`.
Frontend registrations live in `components/tool-ui/toolkit.tsx`.

Update this file when adding, removing, renaming, or re-routing a tool or its
card — same rule as `docs/APIS.md`.

## Tool groups

| Group   | Backend path           | Card path                                                                         |
| ------- | ---------------------- | --------------------------------------------------------------------------------- |
| Weather | `backend/tool/` (root) | `components/tool-ui/weather/`                                                     |
| Crypto  | `backend/tool/crypto/` | `components/tool-ui/crypto/`                                                      |
| Code    | `backend/tool/code/`   | `components/tool-ui/code/`                                                        |
| Web     | `backend/tool/` (root) | — (plain tool messages)                                                           |
| Memory  | `backend/tool/memory/` | `components/tool-ui/memory/` (SaveMemoryCard diff + the settings/memory-view tab) |

## Weather

| Tool               | Backend file       | Frontend card           | Notes                                                                      |
| ------------------ | ------------------ | ----------------------- | -------------------------------------------------------------------------- |
| `ask_location`     | `ask-location.ts`  | `ask-location-card.tsx` | Interrupt-driven. User clicks / types → `addResult` resumes the agent.     |
| `geocode_location` | `geocode.ts`       | —                       | Plain `ToolMessage`. Frontend just shows the tool-call part with the args. |
| `get_weather`      | `fetch-weather.ts` | `weather-card.tsx`      | Vendored widget re-renders on `IntersectionObserver` re-entry.             |

`WEATHER_AGENT_PROMPT` enforces one-tool-per-turn across this chain so the
ask-location card isn't raced by a parallel tool call. See
`docs/INTERRUPT.md` for the two runtime paths the ask-location card can take.

## Crypto

| Tool                 | Backend file                   | Frontend card                        | Notes                                                                                      |
| -------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `get_crypto_price`   | `crypto/get-crypto-price.ts`   | `crypto/price-card.tsx`              | One card per coin in `ids[]`. Result `{ success, prices[] }`.                              |
| `get_fx_rate`        | `crypto/get-fx-rate.ts`        | —                                    | Frankfurter, 60s in-memory cache. Plain `ToolMessage`.                                     |
| `connect_wallet`     | `crypto/connect-wallet.ts`     | `crypto/connect-wallet-card.tsx`     | Interrupt-driven. Reads wallet from wagmi; resumes with `{ address }`.                     |
| `place_crypto_order` | `crypto/place-crypto-order.ts` | `crypto/place-crypto-order-card.tsx` | Interrupt-driven. Simulated swap; resumes with `SimulatedOrder` or `cancelled`.            |
| `get_order_status`   | `crypto/get-order-status.ts`   | `crypto/order-status-card.tsx`       | Interrupt-driven. Synthesizes a status (simulated-swap demo); resumes with status payload. |
| `get_token_balances` | `crypto/get-token-balances.ts` | —                                    | Defined but not wired into `ALL_TOOLS` yet — dormant.                                      |
| `get_NFT_holdings`   | `crypto/get-nft-holdings.ts`   | `crypto/nft-gallery-card.tsx`        | Read-only. Lists NFTs across 5 chains; filters spam by name regex. Renders a gallery grid. |

Trade flow is split into three atomic interrupt tools (connect → place → check)
so each is its own user decision point and `ToolMessage` the LLM can reason
about independently.

## Code

| Tool           | Backend file           | Frontend card                  | Notes                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_code`   | `code/write-code.ts`   | `code/write-code-card.tsx`     | Interrupt-driven. Pauses for the user to review/edit, then click Run. Resumes with `{action:'run',code,language}` or `{action:'cancel'}`.                                                                                                                               |
| `execute_code` | `code/execute-code.ts` | `code/execute-code-result.tsx` | Lazy-registered: only in the tool list when `DENO_DEPLOY_TOKEN` is set. Runs TS/JS via Deno `eval`, or Python via `python3 -c`, in a Deno Deploy Sandbox (Firecracker microVM). The `denoRun` helper lives at `code/deno-run.ts`; `code/index.ts` re-exports all three. |

`CODE_AGENT_PROMPT` defaults to TypeScript; JavaScript goes through the
same Deno `eval` path. Python routes to `python3 -c` against the
sandbox's preinstalled CPython 3.13 (standard library only — no pip
installs). Both runtimes expose `fetch`, the file system, and `env`
inside the VM (only the host is isolated) — no need to special-case them.
One-tool-per-turn and a 3-attempt budget per problem are enforced the same
way as before. When `DENO_DEPLOY_TOKEN` is unset, `execute_code` is not
registered — the model will surface a graceful
fallback (inline compute or "I can't execute right now") after a Run
instead of silently failing.

## Memory

| Tool          | Backend file                 | Frontend card                 | Notes                                                                                                                                                                                                               |
| ------------- | ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_memory` | `memory/save-memory-tool.ts` | `memory/save-memory-card.tsx` | RFC 6902 patches against the user's profile at `[userId, "memory"] main`. Diff card reads the matching `ToolMessage`. Wired into every sub-agent's tool list (no separate group — always-on). See `docs/MEMORY.md`. |

`save_memory` operates on the **merged view** (store + auth overlay),
not just the store, so `replace /name "X"` succeeds when the model is
reacting to a name field that came from OAuth. Path regex
`^\/[A-Za-z_][A-Za-z0-9_-]*$` rejects array indices; `replace` /
`remove` on a path not in the merged view throws `MemoryPatchError`
(`code: "PATCH_FAILED"`) instead of silently no-op'ing. The size
guard runs before the store write (`MEMORY_PROFILE_MAX_BYTES`,
default 8192); exceeding it throws `MemorySizeError` with
`attemptedBytes` + `maxBytes` so the model can retry with a smaller
patch.

No `forget_memory` tool — the Memory settings tab is the only path
to deletion. Tool result carries a `before` / `after` / `patches[]`
payload the `SaveMemoryCard` renders as a per-row diff.

## Web

| Tool         | Backend file    | Frontend card | Notes                                                      |
| ------------ | --------------- | ------------- | ---------------------------------------------------------- |
| `search_web` | `web-search.ts` | —             | Jina `s.jina.ai`, key-pool auth via `lib/jina.ts`.         |
| `fetch_url`  | `web-fetch.ts`  | —             | Jina `r.jina.ai`, returns `{ title, content, url }` as MD. |

## Frontend wiring

`components/tool-ui/toolkit.tsx` is the only place that maps tool names to
`render` components (assistant-ui's `defineToolkit`). Each entry there is a
one-line registration; the actual card is a separate import. When you add a
tool:

1. Drop the backend file under `backend/tool/` (or `backend/tool/crypto/`).
2. Export the tool from `backend/tool/index.ts` and add it to the relevant
   `*_TOOLS` array (and `ALL_TOOLS` if the graph should see it).
3. If the tool has a card, drop it under `components/tool-ui/<group>/` and
   register the name → component in `toolkit.tsx`.
4. Add a row to the matching table above.
5. If the tool calls a third-party API that needs a key, follow the
   "Lazy registration" pattern below.

## Lazy registration (env-var-gated tools)

Some tools need a server-side key to be useful:

- `search_web` → `JINA_API_KEYS` (s.jina.ai requires auth)
- `get_NFT_holdings` → `ALCHEMY_API_KEY`
- `execute_code` → `DENO_DEPLOY_TOKEN` (+ optional `DENO_DEPLOY_ORG` for
  personal tokens)
- `/api/alchemy/[...path]` proxy → `ALCHEMY_API_KEY`

When the key is missing, the tool **must not be registered** in the
agent's tool list — otherwise the model sees a tool that 401s on every
call and the user gets a runtime error instead of a graceful fallback.
`backend/tool/index.ts` then `...`-spreads the conditional in:

```ts
export const getNftHoldingsTool: StructuredTool | null = process.env.ALCHEMY_API_KEY
  ? tool(impl, { name: "get_NFT_holdings", ... })
  : null;

// in ALL_TOOLS:
...(getNftHoldingsTool ? [getNftHoldingsTool] : []),
```

`fetch_url` is the one exception — r.jina.ai accepts unauthenticated
requests on the free tier, so it's always registered. `lib/jina.ts`
falls through to a no-Auth fetch when the pool is empty.

When you add a new tool that needs a key:

- Define it as `StructuredTool | null`, gated on the env var.
- Add a `...(tool ? [tool] : [])` entry in the matching `*_TOOLS` array.
- Document the key in `.env.example` and in the table below.

## Tool ↔ API key

| Tool / handler           | Env var                        | Notes                                                                      |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------- |
| `search_web`             | `JINA_API_KEYS` (required)     | Comma-separated; key pool rotates + fails over.                            |
| `fetch_url`              | `JINA_API_KEYS` (optional)     | r.jina.ai free tier works without a key. With a key, higher rate limit.    |
| `get_crypto_price`       | (none)                         | CoinGecko free tier.                                                       |
| `get_fx_rate`            | (none)                         | Frankfurter, free.                                                         |
| `ask_location`           | (none)                         | Browser geolocation API.                                                   |
| `geocode_location`       | (none)                         | Open-Meteo geocoding, free.                                                |
| `get_weather`            | (none)                         | Open-Meteo, free.                                                          |
| `get_NFT_holdings`       | `ALCHEMY_API_KEY` (required)   | Also powers `/api/alchemy/[...path]` proxy.                                |
| `place_crypto_order`     | (none)                         | SIMULATED swap (no real DEX).                                              |
| `get_order_status`       | (none)                         | Simulated.                                                                 |
| `connect_wallet`         | (none)                         | wagmi/RainbowKit; wallet state is browser-side.                            |
| `write_code`             | (none)                         | Pure UI — just `interrupt()`.                                              |
| `execute_code`           | `DENO_DEPLOY_TOKEN` (required) | Deno Deploy Sandbox. Use `DENO_DEPLOY_ORG` with personal tokens (`ddp_*`). |
| `/api/alchemy/[...path]` | `ALCHEMY_API_KEY` (required)   | Server-only JSON-RPC proxy.                                                |
| `OPENAI_API_KEY`         | n/a (model layer, not a tool)  | Required for every model call.                                             |
| `RESEND_API_KEY`         | n/a (auth/email, not a tool)   | Verification emails only.                                                  |
| `LANGCHAIN_API_KEY`      | n/a (proxy auth)               | Required in prod for the LangGraph proxy.                                  |

## Tool-call UI rules

Components rendered inside a tool-call part live inside `ToolFallbackContent`,
which already provides `ps-6 pt-1 pb-2` padding. See CLAUDE.md rules #6
(spacing) and #8 (buttons are text-only — no Lucide icon prefix).

## Shared UI primitives (`components/tool-ui/primitives/`)

Every tool-ui card repeats the same chrome — rounded border, max-w-2xl
shell, icon-circle header, success / error banner. To keep these
consistent and prevent the same fix from being applied in 8 places, four
primitives live under `components/tool-ui/primitives/`:

- **`CardShell`** — `border-border/60 bg-card ... overflow-hidden rounded-xl border`
  outer wrapper, plus a `flex flex-col gap-3 p-4` inner. Accepts
  `data-slot`, `maxWidthClass` (default `max-w-2xl`, e.g. `max-w-md` for
  the connect-wallet modal), and a passthrough `className`.
- **`CardHeader`** — icon circle (`bg-primary/10 text-primary` by default;
  override via `iconClassName`), `title`, optional `subtitle`, and an
  optional `trailing` slot for right-aligned content.
- **`ErrorBanner`** — destructive surface for tool failures. Accepts a
  `message`, optional `icon` override, and a `monospace` flag for
  code/stack-trace content (switches to `font-mono text-[11px] leading-relaxed
whitespace-pre-wrap break-all`). The `break-all` is what stops long
  error lines (no spaces, e.g. Deno stack frames like
  `file:///home/app/$deno$eval.mts:1:7`) from overflowing the card —
  `whitespace-pre-wrap` alone doesn't help when there's nothing to break
  on.
- **`SuccessBanner`** — neutral muted surface for resolved states
  (coords confirmation, "Run requested", "Cancelled"). Title + optional
  subtitle, optional icon override.

All four primitives are `<div>`-based with `overflow-hidden` and the
inner content uses `min-w-0 flex-1` so the flex child can't grow past
its parent. When you add a new card, use these instead of re-typing the
chrome. The icons inside the icon circle should be a flat lucide
component at `size-4` (no variant like `CheckCircle2Icon` — the circle
wraps them, and a circle inside a circle looks small; see rule #8).

## Sanitizing subprocess output

`backend/tool/code/deno-run.ts` strips CSI ANSI escapes
(`\x1b[...m`, `\x1b[...H`, etc.) from `stdout` and `stderr` before they
land in the tool result. Deno's default output is colored, which renders
fine in a terminal but shows up as literal garbage (`[@1m[31m...`) in
HTML/JS. The regex lives next to the `stripAnsi` helper at the top of
the file. **Any new tool that captures subprocess output should pass
it through `stripAnsi` before storing it in the result** — the
pattern matches the CSI form (`ESC [` then params + final byte);
CARET form (`\x1b]…\x07`) is rare in Deno/Python output so we ignore
it for now.
