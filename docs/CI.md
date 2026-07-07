# CI/CD

## Layout

```
.github/workflows/CI.yml         lint + typecheck + build + test (parallel jobs)
.github/workflows/CD.yml         tag-aware image build + push to GHCR
.github/ISSUE_TEMPLATE/          bug_report.yml, feature_request.yml, config.yml
Dockerfile                       single image, role-dispatched entrypoint
docker-compose.yml               app + postgres (single host, self-host)
scripts/start.sh                 entrypoint: ROLE=all|frontend|backend
.nvmrc                           pins Node 22 (matches langgraph.json node_version)
```

## Single image, role-dispatched (`scripts/start.sh`)

`docker-compose.yml` sets `ROLE=all` so the container runs both processes
under `concurrently`:

- Next.js on `:3000`
- LangGraph API server on `:2024`

The `frontend` / `backend` roles exist so the image can be reused for
independent scaling if a deploy target ever needs it. Override via env
when launching:

```bash
docker run -e ROLE=frontend -p 3000:3000 langgraph-app
docker run -e ROLE=backend  -p 2024:2024 langgraph-app
```

Code-level separation lives in `scripts/start.sh` — each role is a
discrete function, easy to read and audit.

The base image is `langchain/langgraphjs-api:22` — the official LangGraph
prod runtime (Python uvicorn + Go core). It runs the compiled graphs
with `LANGGRAPH_RUNTIME_EDITION=postgres`, which honors
`backend/checkpointer.ts`'s `PostgresSaver`. Thread state persists
across container restarts.

Two runtime requirements the base image enforces:

- **Redis on `$REDIS_URI`** — required at startup (`FF_USE_REDIS_QUEUE=false`
  doesn't bypass the connection check). The compose stack includes a
  `redis:7-alpine` service.
- **DB migrations** — langgraph-api runs ~29 migrations on first start,
  including `CREATE INDEX CONCURRENTLY ... store_prefix_idx`. Upstream
  `langgraph-api` 0.10.x wraps this in a transaction, which Postgres
  rejects for `CONCURRENTLY` indexes. Until upstream fixes it, run the
  migration manually once before the first start:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx
    ON store USING btree (prefix text_pattern_ops);
  ```
  Then start the container; subsequent restarts skip already-applied
  migrations.

## CI (`CI.yml`)

Triggers: push + PR to `main` and `dev`. Four parallel jobs:

1. **lint** — `pnpm lint` (oxlint + oxfmt --check).
2. **typecheck** — `pnpm typecheck` (`tsc --noEmit`).
3. **build** — `pnpm build` (Next.js production build). Needs a
   reachable Postgres on `localhost:5432` — Better Auth runs DB
   migrations at module load, which Next.js triggers when it
   statically evaluates App Router routes. The job exposes a
   `postgres:16-alpine` service for this.
4. **test** — `pnpm test` (Vitest, node + frontend projects). Postgres
   service container exposes `localhost:5432`; `globalSetup` applies
   Drizzle migrations from `db/migrations/*.sql` before tests run.

Why parallel: faster feedback (lint fails in 30s, doesn't wait for build).
Why each job installs deps separately: cheap, and isolates failures —
a flaky network step in `test` doesn't poison `lint`.

Concurrency: `cancel-in-progress` per ref — re-pushing a branch cancels
the previous in-flight run for that same ref. Different refs run in
parallel.

Secrets / env: none. Test env values are hard-coded — they match
`.env.test`, which is committed. `BETTER_AUTH_SECRET` here is a fake
string; the auth tests mock `getSession()` directly, so the real secret
isn't needed.

Skipped (add when needed):

- **Playwright e2e** — needs Next + LangGraph + Postgres + a browser.
  ~5-10 min extra, brittle on first run. Run locally via `pnpm test:e2e`
  until you actually need the gate.
- **Action SHA pinning** — using `@v4` etc. for now. Pin by commit SHA
  (`actions/checkout@<sha>`) when supply-chain risk warrants it;
  Renovate / Dependabot can keep the SHAs current.
- **Coverage upload** — local `coverage/` is fine until a dashboard
  exists.

## CD (`CD.yml`)

Triggers: push to `main` / `dev`, PR to `main` / `dev` (build only),
`workflow_dispatch` (manual override).

### Tag strategy

| trigger              | tag                                | channel     | pushes?                      |
| -------------------- | ---------------------------------- | ----------- | ---------------------------- |
| push to `main`       | `latest`                           | stable      | yes                          |
| push to `dev`        | `beta-<sha>`                       | beta        | yes                          |
| push to other branch | `<branch>-<sha>`                   | branch      | yes                          |
| PR (any branch)      | (resolved tag)                     | —           | no (build-only sanity check) |
| `workflow_dispatch`  | `image_tag` input or branch-driven | manual/auto | yes                          |

Same image, different tags. `docker pull ghcr.io/<owner>/langgraph-app:beta`
gives you the latest dev build; `:latest` gives you main.

The `resolve` job isolates the tag logic from the build job — easy to
audit and easy to add new channels later (e.g. `release-<version>`).

PR builds don't push (and don't even attempt GHCR login — `GITHUB_TOKEN`
isn't available to fork PRs). The build still runs so the PR page shows
a real Docker build status.

OCI image labels are set on every build (`org.opencontainers.image.source`,
`.revision`, `.version`, `.title`) — `docker inspect` exposes them.

`provenance: true` is set when pushing — enables SLSA-style build
provenance attestation via the GHCR UI.

### GitHub Release + tarball asset

A separate `release` job (after `build` succeeds) runs on stable + beta
channels:

1. Pulls the just-built image from GHCR.
2. Saves it to `langgraph-app-<tag>.tar.gz`.
3. Creates / updates a GitHub Release via `softprops/action-gh-release@v2`,
   attaching the tarball.

- **Stable (main)** — one accumulating "Latest" release, tarball
  overwritten each push. Tag = `latest`.
- **Beta (dev)** — new release per push, tag = `beta-<sha>`, marked
  prerelease.
- **Other branches** — skipped.

Why both GHCR + GitHub Release? GHCR is the canonical registry but
needs `docker login` to pull. The release tarball lets you fetch + load
an image with just `curl` + `docker load` — useful for self-hosted
deploys without GHCR credentials, and for air-gapped environments.

Concurrency: split by `event_name`. PR runs use
`cancel-in-progress: true` (separate group via `event_name` in the key)
— they're Docker sanity checks only, no push, no release, no
side-effects to clean up. `push` events (main/dev) keep
`cancel-in-progress: false` — an in-flight image push or GitHub
Release should finish rather than leave a half-published artifact.

### What CD does **not** do (yet)

- **Deploy step.** Pull the image onto the host and restart, or wire up
  `appleboy/ssh-action`, `kubernetes/kubectl-action`, `superfly/flyctl-actions`,
  etc. depending on the target.
- **DB migration.** If `db:migrate` needs to run as part of a release,
  add it as a step before the restart (e.g. run `pnpm db:migrate`
  inside the container against the prod DB).
- **Environment protection rules.** GitHub Environments (`production`,
  `beta`) give you manual approval gates + per-env secrets — set them up
  under Settings → Environments when the deploy step is wired in.

## Issue templates

`.github/ISSUE_TEMPLATE/`:

- `bug_report.yml` — structured bug intake with severity dropdown,
  repro steps, self-checks.
- `feature_request.yml` — problem-first framing, scope + risk
  dropdowns, self-checks.
- `config.yml` — `blank_issues_enabled: true` + contact links to
  Discussions and `docs/` so questions redirect away from Issues.

## Local verification

With Docker / OrbStack:

```bash
docker compose config --quiet   # validates compose + env interpolation
docker compose build app        # builds the image; needs a reachable Postgres
                                # at localhost:5432 — Better Auth runs DB
                                # migrations during `next build`. On Mac,
                                # start one in another terminal first:
docker run -d --name build-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=langgraph_app \
  postgres:16-alpine
docker compose build app
docker rm -f build-pg
```

Why the Postgres dance? `next build` statically evaluates App Router
routes; Better Auth's `runStoreMigrations` runs at module load against
`DATABASE_URL`. The CI/CD build jobs expose a `postgres` service so
this works automatically. Locally, spin one up as above. The clean
long-term fix is making Better Auth init lazy — out of scope for this
PR.

With `act` (GitHub Actions runner locally):

```bash
brew install act                # if not installed
act -j lint                     # cheapest job (~30s)
act -j build                    # ~1 min
# build + test jobs need services; act handles them via docker, but
# a local postgres is faster:
pnpm test
```

## Updating

- **Bump Node** — bump `.nvmrc`, `langgraph.json` `node_version`, and
  the `langchain/langgraphjs-api` base tag in the `Dockerfile`.
- **Add a CI job** — append a new entry under `jobs:` in `CI.yml`.
- **Add a CD channel** — extend the `resolve` job's branch logic; the
  build job picks the tag up automatically.
- **Change deploy target** — extend `CD.yml` after the `build` job.
  Don't remove the GHCR push — it's the artifact store that any deploy
  step pulls from.

## Dependency caching

Both CI and CD cache `pnpm install` output, keyed on the lockfile:

- **CI** — `actions/setup-node` with `cache: pnpm` caches the
  `~/.local/share/pnpm/store` directory to the GitHub Actions cache.
  Each job restores it before `pnpm install --frozen-lockfile`, so only
  the link step runs.
- **CD** — the Dockerfile's `pnpm install` step uses a BuildKit
  `--mount=type=cache` for the same store path. The `build-push-action`
  writes the cache to GHA (`cache-to: type=gha,mode=max`) and restores
  it on the next run (`cache-from: type=gha`). The Docker layer that
  contains `node_modules` is also cached as a regular layer.

When `pnpm-lock.yaml` doesn't change between runs, both cache paths
hit and `pnpm install` skips downloading entirely. When it does
change, only the diff is fetched — the rest stays warm.

Cold-start (no cache, fresh runner): ~60s for `pnpm install`. Warm
cache: ~5s.
