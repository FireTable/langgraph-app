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

## Alchemy RPC

Server-side proxy so the Alchemy API key never reaches the browser. Implementation: `app/api/alchemy/[...path]/route.ts` + `app/api/alchemy/status/route.ts`. Allowlist source of truth: `lib/alchemy/networks.ts` (static catalog of every Alchemy-supported network). `ALCHEMY_DISABLED_NETWORKS` is an optional turn-off filter on top of the catalog.

| Endpoint                         | Purpose                                                                                                                                                                                | Response                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/alchemy/status`        | Reports whether `ALCHEMY_API_KEY` is set on the server. The actual key value is never included in the response — it only returns `{ configured: boolean }`.                            | `{ configured: true \| false }`                         |
| `POST /api/alchemy/<network>`    | Forwards a JSON-RPC body to `https://<network>.g.alchemy.com/v2/<ALCHEMY_API_KEY>`. The `<network>` slug must be in the catalog AND not in `ALCHEMY_DISABLED_NETWORKS`, otherwise 400. | Forwards upstream status + body. CORS headers attached. |
| `GET /api/alchemy/<network>`     | Same proxy path, used for Alchemy endpoints that take query params (e.g. `eth_getBlockByNumber` over GET). Same allowlist rules.                                                       | Forwards upstream status + body.                        |
| `OPTIONS /api/alchemy/<network>` | CORS preflight.                                                                                                                                                                        | 204 with `Access-Control-Allow-*` headers.              |

### Error responses (stable)

- `400 { error }` — network slug missing, not in the static catalog, or listed in `ALCHEMY_DISABLED_NETWORKS`.
- `500 { error }` — `ALCHEMY_API_KEY` is not configured on the server, or the upstream call threw.
- Upstream statuses (401 / 429 / 5xx) are passed through to the caller as-is, with the upstream body and `Retry-After` header preserved.

### Env contract

- `ALCHEMY_API_KEY` — server-only. The proxy reads it. Never reachable from the browser bundle.
- `ALCHEMY_DISABLED_NETWORKS` — server-only, optional, comma-separated Alchemy slugs the proxy will REJECT. Empty = every catalog network is enabled. The admin page (`/alchemy`) always shows the full catalog; a disabled network's Test button returns 400 so you can see at a glance what's turned off.

### Admin UI

`/alchemy` renders the full catalog grouped by L1 / L2 / testnets, with a status badge from `/api/alchemy/status` and a per-network **Test** button that runs `eth_blockNumber` through the proxy.

## Graph tools

The LangGraph `agent` graph exposes the following tools to the chat model. Both are read-only and run unconditionally — there is no per-call human approval prompt. Write tools added later should hang off their own node and pass `interruptBefore: ["<that-node>"]` to `compile()` so only the write path pauses for approval.

Implementation: `backend/tool/{web-fetch,web-search}.ts`. Shared key pool: `lib/jina.ts`.

### `search_web(query)`

Keyword / natural-language web search via Jina Search (`s.jina.ai`).

|               |                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ query: string }` — non-empty                                                                                                   |
| Output        | `{ query, results: Array<{ title, url, description }> }` (JSON string)                                                            |
| Auth          | Uses one key from `JINA_API_KEYS` (comma-separated in `.env.example`)                                                             |
| Failure modes | `500` from upstream → tool throws and the model reports the error; all keys exhausted → tool throws `"All N Jina keys exhausted"` |

### `fetch_url(url)`

Read a public web page and return it as markdown via Jina Reader (`r.jina.ai`).

|               |                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Input         | `{ url: string }` — must be a valid absolute URL with scheme                                                       |
| Output        | `{ title, content, url }` (JSON string; `content` is markdown)                                                     |
| Auth          | Same `JINA_API_KEYS` pool as `search_web`                                                                          |
| Failure modes | Non-2xx from upstream → tool throws with status code; URL validation failure → schema rejection before the request |

### Key pool semantics

`JINA_API_KEYS` is parsed once at module load into an in-memory pool. Each request picks a key at random. On `401` or `403`, the key is removed from the pool and the request retries with another random key. Up to N retries are attempted where N is the pool size at call start; once every key has rejected the same request, the tool throws. The pool is process-local and resets on LangGraph dev-server restart.

## Crypto tools

The crypto sub-agent (`CRYPTO_AGENT_PROMPT` in `backend/prompt/system.ts`) drives the swap flow. The wallet is only used to identify the user — `place_crypto_order` does **not** read on-chain balances. The simulated flow auto-funds every user with 10,000 Mock Coin (MC, pegged 1:1 to USD) on the first trade, and the receive-side token is priced via live CoinGecko USD. There is no real signing and no on-chain broadcast in the current default path.

### `get_crypto_price(ids, vs_currency?)`

Read-only price lookup via CoinGecko's public `/coins/markets`. Used to render the price card. Has a 60s in-memory cache to stay under the free-tier rate limit.

|               |                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ ids: string[], vs_currency?: string }` — CoinGecko coin ids (e.g. `["bitcoin", "ethereum"]`); defaults to `"usd"` |
| Output        | `{ success: true, coins: [...] }` (JSON string) — normalized list with price, 24h change, 7d sparkline, market cap   |
| Auth          | None (CoinGecko public endpoint)                                                                                     |
| Failure modes | Non-2xx → `{ success: false, error }` carrying the upstream status. No retries.                                      |

### `get_fx_rate(from, to)`

Read-only FX lookup via frankfurter.app (ECB-sourced). Has a 60s in-memory cache. Currently unused by the wallet-token flow (fiat amounts are rejected) but kept for the chat agent's general knowledge lookups.

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Input         | `{ from: string, to: string }` — 3-letter ISO codes, case-insensitive |
| Output        | `{ success: true, from, to, rate, date }`                             |
| Failure modes | Non-2xx → `{ success: false, error }` with the upstream status.       |

### `get_token_balances(chainId, address)`

**Not currently exposed to the LLM.** Listed here for reference only — the file and tests are kept in `backend/tool/crypto/get-token-balances.ts` for direct programmatic use, but `CRYPTO_TOOLS` does not register it. The wallet's address is not in the LLM's context (it lives in wagmi/RainbowKit on the frontend), so the agent has no way to call this tool without inventing an address. The simulated `place_crypto_order` flow does not consult on-chain balances — every user is auto-funded with Mock Coin. If you want to re-enable this tool, register it in `backend/tool/index.ts` and update `CRYPTO_AGENT_PROMPT` step 2.

### `get_NFT_holdings(address)`

Read-only. Lists the NFT holdings of an EVM wallet across Ethereum, Arbitrum, Optimism, Base, and Polygon. Calls Alchemy's Portfolio API `nfts/by-address` directly from the server (uses `ALCHEMY_API_KEY`).

|               |                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `{ address: string }` — 0x-prefixed 40-hex chars. Case-insensitive. The LLM pulls this from the user's message or the most recent `connect_wallet` ToolMessage — never invents.                                                  |
| Output        | `{ success: true, address, totalCount, nfts: Array<{ contractAddress, contractName, collectionName, collectionSlug, contractImageUrl, network, tokenId, tokenType, name, thumbnailUrl, cachedUrl, contentType, balance, totalSupply, floorPriceEth }> }` (JSON string). |
| Auth          | None from the LLM's perspective. Server reads `ALCHEMY_API_KEY`.                                                                                                                                                                  |
| Failure modes | Missing / malformed address → zod-style rejection. Missing `ALCHEMY_API_KEY` → `{ success: false, error }`. Alchemy 4xx/5xx → `{ success: false, error: "alchemy N: ..." }`. Empty list → `{ success: true, nfts: [] }`, not an error. |

The tool always sends `excludeSpam: true` plus an in-house name filter (`claim | airdrop | visit | gift | giveaway | voucher | reward | drop | bonus`) — Alchemy's own spam classifier leaves a lot of airdrop-bait through, and this regex catches the obvious patterns (yield-eth.net, USDC vouchers, etc.). Items whose contract name OR per-token name matches the regex are dropped from the response. Pagination via `pageKey` is handled internally (capped at 20 pages so a pathological wallet can't spin).

### `connect_wallet(message?)`

Wallet-authorization interrupt. Pauses via `interrupt()`; the frontend card opens RainbowKit, then resumes with `{address, chainId}` from wagmi. That becomes the ToolMessage content the LLM reads. Subsequent tools (`place_crypto_order`, `get_order_status`) auto-infer the address from wagmi state — the LLM does not need to thread an address through the schema.

|               |                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input         | `message?` (string) — short prompt shown above the Connect button. Defaults to `"Connect your wallet to continue."` if omitted.                        |
| Output        | `{ address: 0x...string, chainId: number }` (success) or `{ error: string }` (user cancelled / wallet not installed). Becomes the ToolMessage content. |
| Failure modes | User closes RainbowKit modal without connecting → no resume → turn does not progress. The card stays in the "Connect" state until the user reconnects. |

### `place_crypto_order(side, source_coin_id?, amount?, target_coin_id?)`

Simulated swap interrupt. Pauses via `interrupt()`; the frontend card reads the wallet from wagmi (auto-inferred from the most recent `connect_wallet` ToolMessage — never pass an address), spends from the auto-funded Mock Coin balance (10,000 MC, pegged 1:1 to USD), prices the receive-side token via live CoinGecko USD (with a hardcoded fallback table in `lib/prices/coingecko.ts` when CoinGecko is unreachable), polls the price every 30s with a visible countdown, lets the user pick slippage + simulated gas tier (gas is converted to MC at the live ETH/USD price the quote already loaded), and exposes one Place simulated order button. On click, the card synthesizes an order — no real signing, no real DEX POST. The closing ToolMessage is what the LLM uses to write the final sentence.

|                |                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input          | `side` (required, `"buy"` or `"sell"`) — `"sell my X"` / `"swap X for Y"` → sell; `"buy Y with X"` → buy. `source_coin_id?` (CoinGecko id) when the user named a source. `amount?` (positive number) when the user named a quantity. `target_coin_id?` when the user named what to receive. |
| Output         | `{ status: "simulated_filled", order: { id, coin, symbol, side, amount_human, qty, status, timestamp, note, slippage_bps } }` (success) or `{ status: "cancelled" }` (Cancel clicked) or `{ status: "error", error: string }` (price fetch failed and no fallback matched).               |
| Failure modes  | Malformed CoinGecko id → zod rejection. Id not in `lib/tokens/catalog.ts` → zod rejection. Non-positive or NaN `amount` → zod rejection. CoinGecko 4xx/5xx surfaces inside the card as a fallback-priced quote; the user can still click Cancel.                                                |
| Missing source | The LLM does not pass a source — the card always spends from Mock Coin regardless of what the user names. The LLM does not need to verify wallet holdings before calling.                                                                                                                  |

### `get_order_status(order_uid, chain_id)`

Order-status interrupt. Pauses via `interrupt()`; the frontend card shows the order uid + chain and exposes one Check button. This is a simulated-order demo — the synthetic uid from `place_crypto_order` isn't a real on-chain order, so on click the card synthesizes a status (`filled` for the demo path) and returns it via the resume.

|               |                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input         | `order_uid` (required, non-empty string) — the order uid returned by `place_crypto_order`. `chain_id` (required, integer) — EVM chain id where the order was placed: 1, 42161, 8453, or 11155111. |
| Output        | `{ status: "filled" \| "open" \| "partially_filled" \| "cancelled" \| "expired" \| "not_found", order_uid, chain_id, filled_buy_amount?, executed_at? }`.                                         |
| Failure modes | Empty `order_uid` or non-numeric `chain_id` → zod rejection.                                                                                                                                      |
