# TODOs

Open decisions and follow-ups from previous sessions. Each entry records the
date, the context it came from, what was decided, and what's still pending.
When a TODO is implemented, move it under "Done" with the closing date and
commit hash, or delete the entry if it's not worth tracking.

## 2026-06-20 — `last_message_at` 同步 hook

**Decided**: Add `threads.last_message_at` (NOT NULL DEFAULT now()) so the
sidebar can ORDER BY last activity. Folded into the baseline 0000 migration
(commit `fd6f197`) since there's no production deploy yet.

**Deferred**: When and how to update `last_message_at` when an agent run
ends. Constraints the user set:

- DB triggers on the LangGraph checkpoint\_\* tables are off the table — those
  tables are owned by `PostgresSaver.setup()` and we don't control their
  schema.
- `touchThread` keeps its current semantics (updates only `updatedAt`) —
  renaming or expanding it was rejected.
- No clean LangGraph v1.4 callback exists for "agent node finished" from
  Node side. Frontend `useStreamRuntime` exposes no `onFinish` for
  arbitrary side-effects.

**Open question**: Which sync point actually works?

| Candidate                                            | Trade-off                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Frontend PATCH `/api/threads/[id]` on stream end     | Requires a `useStream` onFinish or wrap; client-side only                     |
| Backend `after_agent` callback in `backend/agent.ts` | Need to confirm LangGraph v1.4 exposes this; callback is per-node not per-run |
| `langgraph-sdk` runs API polling                     | Extra dependency, polling latency                                             |
| Don't sync — keep `last_message_at = created_at`     | Simplest; sidebar just sorts by create time, OK for v0                        |

**Pending follow-up**: Confirm or rule out #1/#2 with a small spike before
shipping the sidebar's "last activity" sort (#87 in the task list, currently
in_progress but blocked on this).

## 2026-06-20 — `touchThread` is unused

**Decided**: Keep `touchThread` as-is (updates only `updatedAt`). No
callers in the codebase today.

**Deferred**: Either wire it into rename/archive/unarchive for a real
purpose, or delete it once we know what it's for. Tracked as #87's adjacent
question — currently the function is only alive in tests.

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

## Done

_Move entries here as they ship, with the closing commit hash._
