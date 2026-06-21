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
