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

## 2026-06-28 — RAG follow-up

Reference if/when RAG lands: <https://docs.langchain.com/oss/javascript/langgraph/agentic-rag>
