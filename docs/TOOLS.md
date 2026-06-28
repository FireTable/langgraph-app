# Tools

Inventory of every LangGraph tool the agent can call, and the matching
frontend card (if any). Backend definitions live under `backend/tool/`; the
single source of truth that wires them into the graph is `backend/tool/index.ts`.
Frontend registrations live in `components/tool-ui/toolkit.tsx`.

Update this file when adding, removing, renaming, or re-routing a tool or its
card — same rule as `docs/APIS.md`.

## Tool groups

| Group   | Backend path                  | Card path                          |
| ------- | ----------------------------- | ---------------------------------- |
| Weather | `backend/tool/` (root)        | `components/tool-ui/weather/`      |
| Crypto  | `backend/tool/crypto/`        | `components/tool-ui/crypto/`       |
| Web     | `backend/tool/` (root)        | — (plain tool messages)            |

## Weather

| Tool              | Backend file             | Frontend card             | Notes                                                                     |
| ----------------- | ------------------------ | ------------------------- | ------------------------------------------------------------------------- |
| `ask_location`    | `ask-location.ts`        | `ask-location-card.tsx`   | Interrupt-driven. User clicks / types → `addResult` resumes the agent.    |
| `geocode_location`| `geocode.ts`             | —                         | Plain `ToolMessage`. Frontend just shows the tool-call part with the args. |
| `get_weather`     | `fetch-weather.ts`       | `weather-card.tsx`        | Vendored widget re-renders on `IntersectionObserver` re-entry.            |

`WEATHER_AGENT_PROMPT` enforces one-tool-per-turn across this chain so the
ask-location card isn't raced by a parallel tool call. See
`docs/INTERRUPT.md` for the two runtime paths the ask-location card can take.

## Crypto

| Tool                | Backend file                    | Frontend card                  | Notes                                                                       |
| ------------------- | ------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `get_crypto_price`  | `crypto/get-crypto-price.ts`    | `crypto/price-card.tsx`        | One card per coin in `ids[]`. Result `{ success, prices[] }`.                |
| `get_fx_rate`       | `crypto/get-fx-rate.ts`         | —                              | Frankfurter, 60s in-memory cache. Plain `ToolMessage`.                       |
| `connect_wallet`    | `crypto/connect-wallet.ts`      | `crypto/connect-wallet-card.tsx`| Interrupt-driven. Reads wallet from wagmi; resumes with `{ address }`.        |
| `place_crypto_order`| `crypto/place-crypto-order.ts`  | `crypto/place-crypto-order-card.tsx`| Interrupt-driven. Simulated swap; resumes with `SimulatedOrder` or `cancelled`. |
| `get_order_status`  | `crypto/get-order-status.ts`    | `crypto/order-status-card.tsx` | Interrupt-driven. Synthesizes a status (simulated-swap demo); resumes with status payload. |
| `get_token_balances`| `crypto/get-token-balances.ts`  | —                              | Defined but not wired into `ALL_TOOLS` yet — dormant.                        |
| `get_NFT_holdings`   | `crypto/get-nft-holdings.ts`    | `crypto/nft-gallery-card.tsx` | Read-only. Lists NFTs across 5 chains; filters spam by name regex. Renders a gallery grid. |

Trade flow is split into three atomic interrupt tools (connect → place → check)
so each is its own user decision point and `ToolMessage` the LLM can reason
about independently.

## Web

| Tool        | Backend file         | Frontend card | Notes                                                       |
| ----------- | -------------------- | ------------- | ----------------------------------------------------------- |
| `search_web` | `web-search.ts`      | —             | Jina `s.jina.ai`, key-pool auth via `lib/jina.ts`.          |
| `fetch_url`  | `web-fetch.ts`       | —             | Jina `r.jina.ai`, returns `{ title, content, url }` as MD.  |

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

## Tool-call UI rules

Components rendered inside a tool-call part live inside `ToolFallbackContent`,
which already provides `ps-6 pt-1 pb-2` padding. See CLAUDE.md rules #6
(spacing) and #8 (buttons are text-only — no Lucide icon prefix).