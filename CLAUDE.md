# CLAUDE.md

Guidance for Claude Code in this repo. Features, layout, env vars, tech stack → `README.md`. Design notes → `docs/`.

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

API changes update `docs/APIS.md` in the same commit (rule 1). Tool changes update `docs/TOOLS.md` (rule 10).

## Project-specific

- **assistant-ui**: `useLangGraphRuntime` from `@assistant-ui/react-langgraph` (NOT `useChatRuntime`). Full-page `<Thread>`, not `<AssistantModal>`. See `assistant-ui` skill.
- **Env specifics** (full table in `README.md`): chat models in `backend/model.ts` carry `modelKwargs: { reasoning_split: true }` — strip when switching providers. `DENO_DEPLOY_TOKEN` personal tokens (prefix `ddp_`) need `DENO_DEPLOY_ORG`; without it, `execute_code` is unregistered and `write_code` is the fallback.
- **Backend graph**: two compiled graphs — `agent` (`backend/agent.ts`) and `background_agent` (`backend/background-agent.ts`). Adding a sub-agent: update the enum in `state.ts` AND `router-agent-node.ts` AND `agent.ts` routeToSubAgent union (or parsing throws — see [[router-decision-schema-duplicated]]).
- **State persistence**: checkpointer is runner-chosen — `langgraphjs dev` uses `InMemorySaver`, `langgraphjs start` uses `PostgresSaver` (`backend/checkpointer.ts`). `POST /api/threads` calls `langGraphClient.threads.create(...)` to register the new id with the dev server's in-process store (no-op in prod).
- **Web3**: trade flow is fully SIMULATED regardless of wallet connectivity — `place_crypto_order` auto-funds Mock Coin on first trade.
- **Observability**: see `docs/OBSERVABILITY.md`. Gotchas: `parent_message_id` backfill window; `FORBIDDEN` regex in `bulkInsertSpans` (fail-closed); FK cascade from `threads`; retention via `OBSERVABILITY_RETENTION_DAYS` (default 30) + `scripts/cleanup-observability.ts`.
- **Styling**: Tailwind v4 via `@tailwindcss/postcss` (no `tailwind.config.js`). Stylesheet: `app/globals.css`. `cn()` from `lib/utils.ts` is the only util. Path alias `@/*` → repo root.

## Engineering rules

Non-negotiable. Every change.

1. **API docs in sync.** Any change to `app/api/**/route.ts` (request/response/status/semantics) updates `docs/APIS.md` in the same commit.
2. **TDD for new code.** Failing test first → minimal impl → refactor. Skip only for declarative changes (types, config, prose). ≥90% on `lib/<module>/queries.ts` + `validators.ts`; every status code path on `app/api/**/route.ts`.
3. **Best practices over middle-ground.** Use the canonical approach first (`@next/env`, `drizzle-kit`, `RemoteThreadListAdapter` from `@assistant-ui/react`). Surface trade-offs when the canonical has friction; let the user decide.
4. **Visually verify frontend changes.** Order: Chrome DevTools MCP → Playwright (under `tests/e2e/`) → user manual confirmation. Backend/DB/pure-logic: `pnpm test` + typecheck.
5. **Comments explain why, not what.** Sparse, short. Default to no comment. Delete comments that restate code or narrate sequences.
6. **Tool-UI cards stay flush with container.** No `mx-*`, no `shadow-*`. Use `components/tool-ui/primitives/` (`CardShell`, `CardHeader`, `ErrorBanner`, `SuccessBanner`, `JsonBlock`).
7. **Tool-UI buttons are text-only.** No lucide icon prefix even with `gap-2`. `size="icon"` is fine for icon-only controls (e.g. submit magnifier).
8. **Never kill or restart a dev server.** Check ports first (`lsof -i :3000` for Next.js, `:2024` for LangGraph). Reuse via Chrome DevTools MCP. If stale/stuck, surface and ask.
9. **`app/api/**/route.ts`is`withAuth`-wrapped.** From `lib/auth/with-auth.ts`. Exceptions: Better Auth catch-all `app/api/auth/[...all]/route.ts`and`OPTIONS`preflight in proxy routes. Test mock:`next/headers`+`@/lib/auth/config`, default `getSession`to a logged-in user in`beforeEach`; 401 path uses `getSession.mockResolvedValueOnce(null)`. Runtime stays `nodejs`(edge throws on`withAuth` → Postgres).
10. **Third-party-key tools lazy-register.** `StructuredTool | null` gated on `process.env.<KEY>` at module load; spread with `...(tool ? [tool] : [])`. Update `.env.example` and `docs/TOOLS.md` "Tool ↔ API key" table when adding one. `fetch_url` is exempt (r.jina.ai free tier).
11. **Back up DB before out-of-app mutations.** Run `scripts/db-snapshot.sh` (refuses non-localhost; custom-format dump) before any raw `psql`, ad-hoc `tsx` script with `DELETE/TRUNCATE/DROP`, or manual `ALTER TABLE` outside the migration runner. Migration runner (`pnpm db:migrate`) and API routes are exempt.

## Things to know before editing

- Graph id `agent` is in `langgraph.json`, `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID` (`.env.example`), and `unstable_createLangGraphStream({ assistantId })`. Keep aligned.
- `app/api/[..._path]/route.ts` proxy uses `runtime = "nodejs"` (was edge) — `withAuth` needs Node `net` for Postgres session reads.
- `feat/*` branches: `git fetch origin main` and merge if main moved before committing — see [[feature-branch-tracks-main]].
- Issue titles use `[Type]:` prefix matching the `gh` label (`[Bug]:`, `[Feat]:`, `[Docs]:`, `[Chore]:`, `[Perf]:`, `[Refactor]:`, `[Test]:`, `[Question]:`).
- `pnpm-workspace.yaml` keeps a `patchedDependencies:` placeholder. Re-check on every bump; drop when upstream ships the fix.
