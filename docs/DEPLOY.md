# Deploy

Self-host `langgraph-app` on a single Linux VPS (or any Docker-capable host).
This doc covers pulling a prebuilt image and bringing the stack up — it
assumes the image you want is already in GHCR (built by `CD.yml` on `main`
or `dev`).

If you want to build the image yourself instead, see [`docs/CI.md`](CI.md#local-verification)
for the local build commands. Everything else here applies identically.

## Prerequisites

- Linux x86_64 host (Ubuntu 22.04+, Debian 12+, or any modern distro)
- Docker Engine 24+ with the Compose plugin (`docker compose version` ≥ v2)
- A reachable Postgres 16 (you can use the one in this compose stack, or an
  external RDS / managed instance — see [External Postgres](#external-postgres-optional))
- An OpenAI-compatible API key (`OPENAI_API_KEY`)
- A long random string for `BETTER_AUTH_SECRET` — `openssl rand -hex 32`
- A long random string for `LLM_KEY_ENCRYPTION_KEY` — `openssl rand -hex 32`
  (AES-256-GCM KEK that wraps every API key in the provider registry; the
  admin UI returns 503 without it — no silent fallback to "no encryption")
- The email you'll sign up with as the first admin (`INITIAL_ADMIN_EMAIL`)

Ports the stack exposes:

- `80` / `443` — **only public surface**; Caddy terminates TLS and
  reverse-proxies to the app. Open these on the firewall.
- `3000` — Next.js. Bound to `127.0.0.1` only; Caddy reaches it on the
  docker network. Don't open on the firewall.
- `2024` — LangGraph API. Bound to `127.0.0.1` only; the Next.js
  catch-all proxy talks to it on the docker network. Don't open on
  the firewall.
- `5432` — Postgres. Bound to `127.0.0.1` only, for backups / debugging.
- `6379` — Redis. Not exposed at all (only the `app` service talks to it,
  on the docker network — required by the langgraph-api runtime).

## Pick an image tag

The `CD` workflow publishes images to GHCR under
`ghcr.io/<owner>/langgraph-app:<tag>` with these tags:

| Branch    | Tag                    | Notes                                |
| --------- | ---------------------- | ------------------------------------ |
| `main`    | `latest`               | Stable, overwritten on each merge.   |
| `dev`     | `beta-<short-sha>`     | One immutable tag per dev push.      |
| any other | `<branch>-<short-sha>` | Build is sanity-only; no tag pushed. |

Pull a specific version, or just `latest` for stable:

```bash
docker pull ghcr.io/<owner>/langgraph-app:latest
```

> `<owner>` is your GitHub org or user. The image is public if your
> repository is public; private repos need a `docker login ghcr.io` first.

To browse published tags:

- GHCR packages page: `https://github.com/orgs/<owner>/packages/container/langgraph-app`
- GitHub Releases: `https://github.com/<owner>/langgraph-app/releases` (stable
  - beta channels also ship a `langgraph-app-<tag>.tar.gz` asset for
    air-gapped installs — see [Air-gapped install](#air-gapped-install-optional))

## Configure environment

Create a deploy directory (anywhere; `/opt/langgraph-app` is fine):

```bash
sudo mkdir -p /opt/langgraph-app && sudo chown $USER /opt/langgraph-app
cd /opt/langgraph-app
```

Write `.env` (do **not** commit this file):

```bash
cat > .env <<EOF
# Image
IMAGE=ghcr.io/<owner>/langgraph-app:latest

# Public domain Caddy should serve. Becomes the `{$CADDY_DOMAIN}` host
# in the Caddyfile below; Caddy substitutes it at startup.
CADDY_DOMAIN=chat.example.com

# Postgres (used by the postgres service below, and by the app)
POSTGRES_USER=langgraph
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=langgraph_app

# App
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
BETTER_AUTH_URL=https://chat.example.com      # public URL of the app
OPENAI_API_KEY=sk-...                         # required (env fallback; the DB registry
                                              #  takes over once migration 0003 seeds
                                              #  the 'default' provider)
OPENAI_BASE_URL=                              # leave empty for stock OpenAI
OPENAI_MODEL=                                 # leave empty for provider default

# Provider encryption KEK — AES-256-GCM key that wraps every apiKey in the
# provider registry (admin UI's Providers tab). REQUIRED for the admin UI
# to start: every /api/admin/providers/** request hits loadKek() lazily and
# returns 503 if the KEK is missing or malformed (no silent fallback to
# "no encryption" mode). 32 bytes hex.
# Generate once, set-and-forget; rotating it is out of scope.
LLM_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Bootstrap admin — the first signup matching this email (case-insensitive)
# is promoted to roleId: "admin" via the Better Auth user.create.after hook.
# Idempotent — leave set forever; only the FIRST match is promoted. To add
# a second admin later, use the admin UI Users tab (PATCH /api/admin/users/[id])
# or a direct DB update. Optional — without it, no admin is bootstrapped
# and you have to promote someone via DB before /admin is reachable.
INITIAL_ADMIN_EMAIL=you@example.com

# RainbowKit / WalletConnect — required for the crypto sub-agent's wallet UI.
# Get one at https://cloud.walletconnect.com
WALLET_CONNECT_PROJECT_ID=your_walletconnect_project_id

# Assistant graph id (don't change unless you renamed the graph in
# langgraph.json — see CLAUDE.md "Things to know before editing")
LANGGRAPH_ASSISTANT_ID=agent
EOF
chmod 600 .env
```

Then write `docker-compose.yml` (this is the **deploy** compose — it pulls
the image instead of building from source):

```yaml
name: langgraph-app

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    # Bind to localhost only — don't expose Postgres publicly.
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 3s
      retries: 10

  # LangGraph's Python runtime requires Redis at startup (pub/sub + queue
  # init). Keep it in the stack.
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  app:
    image: ${IMAGE}
    restart: unless-stopped
    # 3000 is only for Caddy (and ad-hoc debugging from the host).
    # 2024 stays on localhost — the Next.js proxy in `app/api/[..._path]/route.ts`
    # talks to it on the docker network, never publicly.
    expose:
      - "3000"
      - "2024"
    ports:
      - "127.0.0.1:3000:3000"
      - "127.0.0.1:2024:2024"
    # ponytail: env_file replaces the per-var `environment:` block.
    # Every value in `.env` (CLAUDE.md rule #12) flows through here.
    # Hardcoded service-to-service URLs stay in `environment:` below.
    env_file: .env
    environment:
      ROLE: all
      NODE_ENV: production
      # App + LangGraph share the same DB; pass both env vars so each
      # process picks up its preferred key (DATABASE_URL for the Next.js
      # auth/checkpointer modules, POSTGRES_URI for langgraph-api).
      DATABASE_URL: postgresql://::5432/
      POSTGRES_URI: postgresql://::5432/
      REDIS_URI: redis://redis:6379
      LANGGRAPH_API_URL: http://localhost:2024
      LANGGRAPH_RUNTIME_EDITION: postgres
      PORT: "2024"
      LANGGRAPH_SERVER_HOST: 0.0.0.0
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  # Reverse proxy + automatic TLS via Let's Encrypt. The only public surface.
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    # CADDY_DOMAIN is substituted into the Caddyfile's `{$CADDY_DOMAIN}`
    # placeholder at Caddy's startup. Required — compose errors out if
    # it's missing, which is what you want (a missing domain = silently
    # broken proxy otherwise).
    environment:
      CADDY_DOMAIN: ${CADDY_DOMAIN:?set CADDY_DOMAIN in .env}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

volumes:
  postgres-data:
  caddy_data:
  caddy_config:
```

And `Caddyfile` (same directory as `docker-compose.yml`):

```caddyfile
# Domain comes from $CADDY_DOMAIN (set in .env, passed to this container
# via compose). Caddy substitutes {$VAR} placeholders at startup; missing
# the env var makes Caddy exit with a clear error.
{$CADDY_DOMAIN} {
    reverse_proxy app:3000
}
```

## First-time Postgres setup

DB migrations run automatically inside the app container on every start
(via `scripts/start.sh` → `pnpm db:migrate`, idempotent — `CREATE TABLE IF
NOT EXISTS` everywhere). Compose gates on `depends_on: service_healthy`,
so Postgres is reachable by the time migrations run.

You don't need to invoke `pnpm db:migrate` manually. Just `docker compose
up -d` — the first start applies all three migration sources in order:

1. **Drizzle** (Better Auth tables + `observability_spans`) — SQL files in
   `db/migrations/*.sql`.
2. **langgraph PostgresStore** (memory doc tables) — via `scripts/db-migrate.ts`.
3. **langgraph PostgresSaver** (checkpointer tables) — same script; the
   langgraph-api Python runtime also runs these at uvicorn startup, so
   it's idempotent against the Python run.

Subsequent `docker compose restart app` runs are safe to skip — all three
sources are idempotent and bail on existing objects.

To migrate **before** pulling a new image (zero-downtime deploys), run
`pnpm db:migrate` against the DB from any host that has Node + pnpm.

### First-time Postgres fix (langgraph-api 0.10.x)

The first start of `langgraph-api` (the Python runtime) runs ~29
migrations, including a `CREATE INDEX CONCURRENTLY ...
store_prefix_idx`. Upstream 0.10.x wraps this in a transaction, which
Postgres rejects for `CONCURRENTLY` indexes.

If you see `psycopg.errors.UndefinedColumn: column "prefix" does not exist`
in `docker compose logs app` on first start, run this once **after** the
first boot completes (the languagegraph-api run creates most tables
itself; the workaround just fixes the index migration):

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
ALTER TABLE store ADD COLUMN IF NOT EXISTS prefix text;
UPDATE store SET prefix = namespace_path WHERE prefix IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx
  ON store USING btree (prefix text_pattern_ops);
INSERT INTO store_migrations (v) VALUES (29) ON CONFLICT DO NOTHING;
SQL
```

Then `docker compose restart app` so langgraph-api re-runs its migration
check (it'll skip already-applied ones).

After the fix, the stack is up:

```bash
docker compose pull app       # refresh the image
docker compose up -d
docker compose logs -f app    # watch startup
```

You should see:

- `langgraph_api` finishing its migrations and binding `:2024`
- `next start` binding `:3000`

The app takes ~30-60s on first start to apply Better Auth + langgraph-api
migrations. Subsequent restarts are seconds.

## Verify

From the host:

```bash
# Next.js
curl -fsS http://localhost:3000 | head

# LangGraph API
curl -fsS http://localhost:2024/ok
```

Open `http://<host>:3000` in a browser. You should land on the chat UI.
Sign up, then ask the agent something — a successful reply confirms the
full stack (Next.js + LangGraph + Postgres + Redis + OpenAI) is wired up.

Check observability data is flowing (per-turn spans land in
`observability_spans`):

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM observability_spans;"
```

The count should grow after each assistant reply.

## Update

```bash
cd /opt/langgraph-app
docker compose pull app
docker compose up -d
```

Watch the logs to confirm clean startup. Postgres + Redis volumes are
preserved across app restarts; the `postgres-data` named volume is the
only stateful piece — back it up.

To roll back to the previous tag, edit `.env` and set `IMAGE=...:previous-tag`,
then `docker compose pull app && docker compose up -d`.

## Reverse proxy + TLS

The compose stack above already includes a `caddy` service — it's the
only thing bound to the public network (`:80` + `:443`). Caddy reads
`./Caddyfile` and provisions / renews a Let's Encrypt certificate on
first request. Nothing to configure beyond the domain name in
`Caddyfile`.

If you'd rather terminate TLS elsewhere, drop the `caddy` service from
the compose file and point your own proxy at `app:3000`:

- **Caddy / nginx on the host** — reverse-proxy `chat.example.com` →
  `app:3000` (same docker network). Same `BETTER_AUTH_URL` rules apply.
- **Cloudflare Tunnel / Tailscale** — if you don't want to open ports
  at all. `BETTER_AUTH_URL` must match the URL the browser actually uses.

Don't put the langgraph port (`:2024`) behind the public proxy. The
Next.js route at `app/api/[..._path]/route.ts` calls it on the docker
network; if you do expose it, the proxy auth check (rule #9) is
bypassed.

## External Postgres (optional)

If you use a managed Postgres (RDS, Cloud SQL, Neon, Supabase, …), drop
the `postgres` service from the deploy compose and point the app at your
endpoint:

```yaml
# In .env
DATABASE_URL=postgresql://user:pass@db.example.com:5432/langgraph_app?sslmode=require
POSTGRES_URI=postgresql://user:pass@db.example.com:5432/langgraph_app?sslmode=require
```

Then `docker compose up -d` (only the `app` service starts; the `postgres`
and `redis` services can stay in the file, they're cheap to keep).

Run the [first-time index fix](#first-time-postgres-fix-langgraph-api-010x)
against the managed DB once.

## Air-gapped install (optional)

Each GitHub Release for stable / beta channels attaches a
`langgraph-app-<tag>.tar.gz` (see `docs/CI.md § GitHub Release + tarball
asset`). You can `curl` + `docker load` it without GHCR credentials:

```bash
curl -L -o image.tar.gz \
  https://github.com/<owner>/langgraph-app/releases/download/<tag>/langgraph-app-<tag>.tar.gz
docker load < image.tar.gz
# Image is now available locally as langgraph-app:<tag>
```

Set `IMAGE=langgraph-app:<tag>` in `.env` and proceed.

## OAuth providers (optional)

To enable GitHub / Google sign-in, add to `.env`:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Restart the app. Better Auth reads these at startup. Provider setup
walkthroughs are in [`docs/AUTH.md`](AUTH.md).

## WalletConnect project id

The crypto sub-agent's wallet UI uses WalletConnect / Reown. The project id
(`WALLET_CONNECT_PROJECT_ID`) is a **non-secret public value** surfaced
to the browser via `window.__CONFIG__` (CLAUDE.md rule #12) — injected
by `app/layout.tsx` from `.env` at request time. **No build-time
inlining**, so changes to `WALLET_CONNECT_PROJECT_ID` only need a
container restart, no image rebuild and no GitHub Actions secret.

Get the value at <https://dashboard.reown.com> (formerly
cloud.walletconnect.com) → Project settings. After creating the project,
**lock it to your domain** in Allowed domains (e.g. `ai.firetable.tech`)
so a forked image deployed elsewhere can't piggy-back on your project id
quota. With the value set in `.env`, the bundle reads it at runtime and
WalletConnect SDK calls like
`https://api.web3modal.org/appkit/v1/config?projectId=...` go out with it.

If a deployment domain doesn't match the project id's Allowed domains,
WalletConnect rejects calls at runtime (HTTP 401 / 403) — wallet
features silently fail.

The repo's GitHub Actions no longer needs a `WALLET_CONNECT_PROJECT_ID`
secret; `CD.yml` and `CI.yml` build without it. Older releases
(2026-07 and earlier) baked the value at build time and required a repo
secret of the same name.

## Backups

The only persistent state is the `postgres-data` volume. A nightly
`pg_dump` is the standard pattern:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "/backups/langgraph-$(date +%F).sql.gz"
```

Hook that up to cron or your backup tool of choice.
