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
OPENAI_API_KEY=sk-...                         # required
OPENAI_BASE_URL=                              # leave empty for stock OpenAI
OPENAI_MODEL=                                 # leave empty for provider default

# RainbowKit / WalletConnect — required for the crypto sub-agent's wallet UI.
# Get one at https://cloud.walletconnect.com
NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=your_walletconnect_project_id

# Assistant graph id (don't change unless you renamed the graph in
# langgraph.json — see CLAUDE.md "Things to know before editing")
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=agent
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
    environment:
      ROLE: all
      NODE_ENV: production
      # App + LangGraph share the same DB; pass both env vars so each
      # process picks up its preferred key (DATABASE_URL for the Next.js
      # auth/checkpointer modules, POSTGRES_URI for langgraph-api).
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      POSTGRES_URI: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URI: redis://redis:6379
      LANGGRAPH_API_URL: http://localhost:2024
      LANGGRAPH_RUNTIME_EDITION: postgres
      PORT: "2024"
      LANGGRAPH_SERVER_HOST: 0.0.0.0
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      BETTER_AUTH_URL: ${BETTER_AUTH_URL}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      OPENAI_BASE_URL: ${OPENAI_BASE_URL:-}
      OPENAI_MODEL: ${OPENAI_MODEL:-}
      NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID: ${NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID}
      NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID: ${NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID}
      # Tool keys (optional — see docs/TOOLS.md)
      JINA_API_KEYS: ${JINA_API_KEYS:-}
      ALCHEMY_API_KEY: ${ALCHEMY_API_KEY:-}
      DENO_DEPLOY_TOKEN: ${DENO_DEPLOY_TOKEN:-}
      DENO_DEPLOY_ORG: ${DENO_DEPLOY_ORG:-}
      # OAuth (optional — empty = sign-in button hidden)
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      # Resend email
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      RESEND_FROM_EMAIL: ${RESEND_FROM_EMAIL:-}
      ALCHEMY_DISABLED_NETWORKS: ${ALCHEMY_DISABLED_NETWORKS:-}
      NEXT_PUBLIC_CRYPTO_REAL_SWAP: ${NEXT_PUBLIC_CRYPTO_REAL_SWAP:-}
      NEXT_PUBLIC_LANGGRAPH_API_URL: ${NEXT_PUBLIC_LANGGRAPH_API_URL:-}
      # LangSmith tracing
      LANGSMITH_TRACING: ${LANGSMITH_TRACING:-false}
      LANGSMITH_API_KEY: ${LANGSMITH_API_KEY:-}
      LANGSMITH_PROJECT: ${LANGSMITH_PROJECT:-}
      LANGCHAIN_API_KEY: ${LANGCHAIN_API_KEY:-}
      # Observability + memory tuning
      OBSERVABILITY_RETENTION_DAYS: ${OBSERVABILITY_RETENTION_DAYS:-30}
      MEMORY_THREAD_SUMMARY_KEEP_RECENT: ${MEMORY_THREAD_SUMMARY_KEEP_RECENT:-10}
      MEMORY_PROFILE_MAX_BYTES: ${MEMORY_PROFILE_MAX_BYTES:-8192}
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

## First-time Postgres fix (langgraph-api 0.10.x)

`langgraph-api` runs ~29 migrations on first start, including a
`CREATE INDEX CONCURRENTLY ... store_prefix_idx`. Upstream 0.10.x wraps
this in a transaction, which Postgres rejects for `CONCURRENTLY` indexes.
Until upstream fixes it, run this once **before** the first `docker compose up`:

```bash
docker compose run --rm postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx \
      ON store USING btree (prefix text_pattern_ops);"
```

(If the `store` table doesn't exist yet, this will error with
`relation "store" does not exist` — that's fine, the langgraph-api
migration will create it on first start. Then re-run the index command.)

After the fix, start the stack:

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

## Backups

The only persistent state is the `postgres-data` volume. A nightly
`pg_dump` is the standard pattern:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "/backups/langgraph-$(date +%F).sql.gz"
```

Hook that up to cron or your backup tool of choice.
