# TODOs

Open decisions and follow-ups from previous sessions. Each entry records the
date, the context it came from, what was decided, and what's still pending.
Delete entries once they're resolved — git history has the rest.

## 2026-06-20 — Production deployment kit

**Decided scope** (from task list, no code yet):

- `#42` docker-compose.yml for Postgres + Next + LangGraph dev server
- `#43` multi-stage Dockerfile
- `#44` Caddyfile (Cloudflare Origin Cert)
- `#45` `.env.example` + `.env.production` templates
- `#46` `scripts/backup.sh` + cron entry
- `#47` `scripts/deploy.sh`
- `#48` README deployment docs

**Deferred**: User picked the `last_message_at` track first. Pick this up
when there's a target host (Cloudflare Tunnel? a VPS?).

## 2026-06-20 — Attachments + Redis + BullMQ

**Decided scope** (from task list, no code yet):

- `#49` `attachments` table + R2 upload abstraction
- `#50` Redis service + `lib/redis.ts` (rate limiting, sessions, queue infra)
- `#51` BullMQ file-cleanup queue (placeholder until uploads land)

**Deferred**: Same as deployment kit — parked for after the current data
model is settled. R2 access keys are not yet in `.env.example`.

## 2026-06-20 — Dev hygiene

**Open**: `#75` prevent multiple dev servers from running simultaneously.
Pattern: write a PID file under `.next/` or a tempdir, refuse to start if
it's stale-and-alive. Not urgent — manual `pkill -f next dev` works for now.

## 2026-06-23 — Stage 1 auth follow-ups

Tracked as PR #1 review-comment follow-ups; none are blocking merge.

- **Replace `public/email/collage-image-1.png`** — placeholder used in the
  verification-email template; needs a real branded image before sending
  to real recipients.
- **Defer redirectTo param** (auth-shell.tsx): thread a `?redirectTo=`
  through the unauthenticated redirect so users return to the page they
  were on after sign-in. Affects `app/auth-shell.tsx` + the RSC redirect
  in `app/chat/page.tsx`. Stage 2 scope.
- **Defer ownership query split** (lib/threads/queries.ts): the
  `*ForUser` queries own the API path; LangGraph backend reuse would need
  a separate admin query layer. Not a current requirement.
- **Land `app/page.tsx` landing**: the `/` route just redirects — should
  render a marketing surface for unauthenticated visitors.
- **Extract rename-thread prompt** (backend/node/rename-thread-node.ts):
  inline `SystemMessage` content belongs in a dedicated eval / config
  file alongside other model prompts.

## 2026-06-23 — Observability (in-app spans)

**Decided scope**:

1. Frontend entry — add an Aperture icon button to the right of the Share
   button in `app/assistant.tsx` Header. Click opens
   `<ObservabilityPanel>` (already scaffolded at
   `components/assistant-ui/observability-panel.tsx`). Icon pulses red
   while `s.thread.isRunning`. Panel is `dynamic({ ssr: false })`
   because react-o11y reads browser state.
2. Span backend — self-contained, no LangSmith / no third-party tracer.
   - Wrap the LangGraph nodes (`call-model-node`, `rename-thread-node`)
     with start/end timing.
   - Emit spans via `config.writer()` so they reach the frontend as
     custom events (LangGraph routes these to
     `useLangGraphRuntime`'s `onCustomEvent`).
   - Persist spans per thread in Postgres: new `spans` table + drizzle
     schema, so a page refresh restores history.
   - `app/api/observability/[threadId]/route.ts` fetches stored spans
     for the panel.
   - Sync `docs/APIS.md` when the route lands (CLAUDE.md rule 1).

**Dependency**: `@assistant-ui/react-o11y@0.0.24` already installed
(uncommitted). Pin a patch in `patches/` once the public API stops
moving (it's `0.0.x`, experimental).

## 2026-06-26 — Crypto agent v2: currency + wallet UI

Follow-up to the 2026-06-25 crypto agent. Two new requirements:

1. **Wallet selection UI**. "Order 按钮点击下去, 是唤醒钱包, 能够选择钱包". User pointed out the existing card had a tiny "Connect wallet (optional)" link; they want the order button to *open a wallet picker*. wagmi is headless (no built-in UI); RainbowKit is the canonical answer but its 2.x line is pinned to wagmi 2.x and we're on 3.6.20. Skipped RainbowKit, built a Radix-Dialog-based connector picker using the existing `injected` connector. `components/tool-ui/crypto/connect-wallet-dialog.tsx`. Order button is now `"Connect & buy BTC"` when no wallet is connected, `"Confirm buy BTC"` once connected. Resume is queued in component state and flushed when `isConnected` flips. No new deps.

2. **Currency detection**. "现在好像说的是买 100 RMB 的加密货币, 会被认为是 USD". Old schema was `amount_usd: number` — the LLM was passing 100 as `amount_usd` regardless of the user's actual currency. New flow:
   - `ask_crypto_intent` schema gains `currency` (3-char ISO) and `amount` (optional pre-fill) so the LLM signals what the user meant.
   - LLM detects from message: 元/RMB/CNY/¥ → CNY, $/USD → USD, €/EUR, £/GBP, ¥/JPY (ambiguous — only JPY if user wrote JPY/日元/日本円 alongside it, else default to CNY). Rules live in `CRYPTO_AGENT_PROMPT`.
   - Card shows the detected currency in the Amount label ("AMOUNT (CNY)") and pre-fills the amount. No UI selector — the LLM is the source of truth.
   - New `get_fx_rate` tool backed by `frankfurter.app` (free, no key, ECB). Cached 60s.
   - After the card resumes, the LLM calls `get_fx_rate(currency, USD)` and converts before `confirm_crypto_order`. USD is a fast path (skip the FX lookup).

**Tasks** (tracked in TaskList #12–#17): all completed. 177/177 tests pass, lint clean, Chrome DevTools verified both USD and CNY flows.

**Skipped**:

- **Real DEX swap**. User said "保持 simulated 的 ui" — keep simulated, just improve UX. Real on-chain would need a contract + `useWriteContract` + testnet ETH; out of scope.
- **wagmi 3.x migration of deprecated hooks** (`useAccount`/`useConnect` → `useConnection`/`useConnections`). Punted — the picker uses the old API which still works in 3.x. Do this when wagmi 3.x removes the old hooks or the warning goes red.
- **Adding `@coinbase/wallet-sdk`** for a real Coinbase connector. Optional peer of `@wagmi/connectors`; not needed for the demo since the user has no MetaMask anyway and the picker falls back to "no wallet providers detected" gracefully.

## 2026-06-25 — Crypto agent (in progress)

Branched off `feat-crypto`. Reuses weather agent's human-in-the-loop
pattern: `ask_crypto_intent` (interrupt) → `get_crypto_price` →
`confirm_crypto_order`. Price source: CoinGecko public API, no key.
"Orders" are **simulated** — wagmi is used for wallet display only,
not for signing. Upgrade path to real DEX swap is out of scope.

**Tasks** (tracked in TaskList):

1. TDD `askCryptoIntentTool` — interrupt-based, mirrors askLocationTool.
2. TDD `getCryptoPriceTool` — CoinGecko `/coins/markets`, 4xx/5xx → `{success:false, error}`.
3. TDD `confirmCryptoOrderTool` — generates simulated order id + qty.
4. Wire `CRYPTO_TOOLS` into `backend/tool/index.ts`.
5. Update `RouterAgentState` + `CRYPTO_AGENT_PROMPT` + `ROUTER_AGENT_PROMPT`.
6. TDD `cryptoAgent` subgraph + extend `agent-topologies.test.ts`.
7. Wire `cryptoAgent` into both `buildSubgraph()` and `buildInlined()`.
8. Add `wagmi` + `viem` + `@tanstack/react-query`, `WagmiProvider` in layout.
9. Build `components/tool-ui/crypto/{price-card,ask-crypto-intent-card,order-receipt-card,index}.tsx`.
10. Register `cryptoToolkit`, run `pnpm test` + `pnpm lint`, Chrome DevTools MCP visual verify.

**Constraints** (re-confirmed before starting):

- File layout: `backend/tool/crypto/*` (mirrors `components/tool-ui/crypto/*`).
- All crypto tools use `crypto_` prefix (`ask_crypto_intent`, `get_crypto_price`, `confirm_crypto_order`).
- Subgraph name `cryptoAgent`, inlined node names `cryptoModel` / `cryptoTools`.
- TDD mandatory per CLAUDE.md rule 2; backend tool coverage ≥ 90%.
- Visual verify per CLAUDE.md rule 4 (Chrome DevTools MCP).
