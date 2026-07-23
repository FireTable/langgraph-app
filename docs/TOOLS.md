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
| Credit  | — (no backend tool)    | `components/tool-ui/credit/credit-card.tsx` (proxy-injected tool_call)            |

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
| `get_token_balances` | `crypto/get-token-balances.ts` | —                                    | Defined but not wired into `CHAT_TOOLS` yet — dormant.                                     |
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

## Credit

| Tool               | Backend file | Frontend card            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show_credit_card` | —            | `credit/credit-card.tsx` | **Client-only render — no backend tool.** The `/api/[..._path]` proxy synthesizes a tiny SSE stream carrying an AI message with a single `show_credit_card` tool_call when `checkCredit()` rejects the turn (UTC-aligned rolling-window cap reached). The card renders inline in the thread, displays `used / limit / windowHours / resetAt`, and updates the user-button dropdown slot on next refresh. Args ride on the tool_call itself — no ToolMessage is emitted. See `docs/CREDIT.md` § Where the cap is enforced. |

## Knowledge base (issue #13 v3)

Two tools for the user's personal KB. `search_KB` is gated on the
Postgres `vector` extension; `list_documents` is unconditional.

| Tool             | Backend file | Frontend card                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_KB`      | `kb.ts`      | `components/tool-ui/kb/search-kb-card.tsx`      | Hybrid RRF (k=60) over three legs: BM25 (`tsv` GIN), pgvector cosine (`embedding` HNSW), and entity-tag overlap (`entities` GIN). Optional `folderId` / `documentId` filters add `WHERE` clauses inside the same SQL. Empty `rewriteQuery` falls back to ordinal-sorted chunks for the filtered scope (lets the LLM "summarize @doc.pdf" without a keyword); the dump cap is `KB_HYBRID_TOPK_DEFAULT` (8), not the previous 1000 — long-scope "summarize @doc" requests return at most 8 chunks, so doc-level summaries may be incomplete. When a Reranker model is registered, the candidate pool is widened to `max(50, topK * 5)` and the Reranker rescores; results below `KB_RERANK_MIN_SCORE` are filtered out before the final `topK` trim. **Partial Rerank caveat**: if the Reranker only returns scores for a subset of candidates, the unscored ones are discarded (no merge back with RRF scores), so a request for `topK` can return fewer than `topK`. Returns structured JSON: `{ content, documents[], empty }`. `content` embeds `[1] [2] [3]` markers; `documents[]` carries `chunkId`/`docId`/`rrfScore`/`legsHit` for UI. |
| `list_documents` | `kb.ts`      | `components/tool-ui/kb/list-documents-card.tsx` | Paginated list of the user's KB docs. Filters: `folderId`, `status` (default `success`), `titleQuery` (ILIKE), `page` (default 1), `pageSize` (default 20, max 100). Strict filtering — no soft warnings. Each `documents[]` entry carries the same indexing counts the Settings → KB badges render (`totalPages` / `successPages` / `failedPages` / `parsingPages` / `pendingPages` + `totalChunks` / `successChunks` / `embeddingPendingChunks` / `failedChunks` / `pendingChunks` / `parsingChunks` + `entityCount` / `relationshipCount`) — single source of truth for the chat card and the Settings table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### ToolMessage shape

`search_KB` returns a JSON string with two top-level keys:

- `content` — the LLM-facing string with `[1]`, `[2]`, ... markers baked
  in. The model emits inline citations by copying these markers. **No
  numeric scores** appear in this string (community consensus: scores
  are ranking metadata only).
- `documents[]` — structured payload for the UI hover-cards:
  `{ chunkId, documentId, docTitle, pageNumbers, content, rrfScore, legsHit }`.

`list_documents` returns `{ content, folders, total, page, pageSize, empty }`:

- `content` — terse LLM-facing summary listing folder names + doc titles +
  statuses + error tails. No page/chunk counts (the model doesn't need
  them to decide what to do next).
- `folders[]` — folder-grouped structured payload for the chat card. Each
  `documents[]` entry mirrors the Settings → KB badge fields:
  `{ id, title, status, errorMessage, createdAt, totalPages, successPages,
failedPages, parsingPages, pendingPages, totalChunks, successChunks,
embeddingPendingChunks, failedChunks, pendingChunks, parsingChunks,
entityCount, relationshipCount }`.

### Lazy registration

`search_KB` is always registered with the agent so the tool surface is
stable, but the implementation throws a clear error when `SELECT 1 FROM
pg_extension WHERE extname='vector'` returns empty. This is a small
departure from the `... (tool ? [tool] : [])` pattern used elsewhere
— the alternative (null-spread) caused the tool to disappear when
pgvector flipped states, which is worse for the LLM than a stable tool
that errors on call.

### Backward compat: `search_kb` → `search_KB`

The tool was renamed `search_kb` → `search_KB` (capital `KB`) for
consistency with the surrounding `search_web` / `search_KB` /
`fetch_url` casing. The LLM-facing schema, the system prompt's
`[KNOWLEDGE BASE]` clause, and `components/tool-ui/toolkit.tsx`'s
renderer key all use the new name. **Persisted threads that contain
completed tool calls under the old `search_kb` key will not render via
`KbSearchToolUI` on this version** — they fall through to the
unknown-tool fallback. The ToolMessage content is still readable in
the thread text, but the inline card is missing. New threads started
after deploy use `search_KB` and render normally. No migration is
planned (old threads age out naturally).

### Knobs

See `lib/kb/env.ts`. Defaults match the community survey in `.claude/13-kb-v3.md`:

- `KB_HYBRID_TOPK_DEFAULT=8` — fused topK for `search_KB`.
- `KB_HYBRID_TOPK_MAX=20` — upper bound.
- `KB_CHUNK_MAX_CHARS=2000` — per-chunk truncation before stuffing into the LLM prompt (~512 tokens).
- `KB_RERANK_MIN_SCORE=0.4` — minimum Reranker relevance score for `search_KB` to keep a candidate. Candidates below this are dropped after Reranker scoring, before the final `topK` trim. Set to `0` to disable the threshold (always keep everything the Reranker ranked).
- `KB_MENTION_TOPK_DEFAULT=5` — chunks per single `@`-mention (used by the resolver, not the tool).
- `KB_MENTION_TOPK_MAX=20`.
- `KB_MENTION_TOKEN_BUDGET=8192` — total token cap across multi-mention turns.

The Reranker model itself (Cohere / Jina / etc.) is configured per-tenant in the Admin → Providers table — see [`docs/ADMIN.md`](./ADMIN.md). When no Reranker is registered, the tool skips the second-stage entirely and slices the RRF-sorted list directly.

## Frontend wiring

`components/tool-ui/toolkit.tsx` is the only place that maps tool names to
`render` components (assistant-ui's `defineToolkit`). Each entry there is a
one-line registration; the actual card is a separate import. When you add a
tool:

1. Drop the backend file under `backend/tool/` (or `backend/tool/crypto/`).
2. Export the tool from `backend/tool/index.ts` and add it to the relevant
   `*_TOOLS` array (and `CHAT_TOOLS` if the graph should see it).
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

// in CHAT_TOOLS:
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
