---
name: langgraph-app-maintain
description: Deploy and maintain langgraph-app on a VPS. First-time cold start, push-to-CD deploys, rolling back to a previous image, resetting the database, upgrading OS / Docker / base image / Node, backup and restore. Invoke when the user mentions "deploy / deployment / upgrade / rollback / maintenance / VPS / go live". If the user gives a forked GitHub repo, substitute the fork's name throughout.
---

# langgraph-app-maintain

Deploy and maintain `langgraph-app` (a Next.js + LangGraph chat app) on an Ubuntu VPS with a public domain. This skill covers first-time cold start, daily updates, rollback, upgrade, and backup.

**Where to pull the code from**: upstream repo at <https://github.com/FireTable/langgraph-app>. **Fork it to your own `<GH_OWNER>/<GH_REPO>` first** — every step below assumes that's done. The GHCR image CD pushes and your Reown Allowed domains quota both belong to your fork.

**Prerequisites** (confirm before starting):

- You've forked <https://github.com/FireTable/langgraph-app> to `<GH_OWNER>/<GH_REPO>` (or you're working on the upstream directly — in that case `GH_OWNER = FireTable`)
- You have a public Ubuntu 24.04+ VPS reachable from the internet (root access, SSH-capable)
- You have a public domain pointing to the VPS (DNS A record)
- Your local machine has `git` / `ssh` / `scp` / `docker` (docker is optional — for local build tests)
- You have **Settings access** on the GitHub repo (to configure secrets)
- You have accounts on Cloudflare / Reown / OpenAI as needed (optional, depends on which features you want)

---

## Key anchors

> Before running this skill for the first time, **fill in these values** — every command below depends on them.

| Field            | Example                                   | Meaning                      | How to fill                                           |
| ---------------- | ----------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| `LOCAL_REPO`     | `~/code/langgraph-app`                    | Your local repo root         | The absolute path you cloned to                       |
| `VPS_HOST`       | `vps.example.com`                         | VPS public IP or domain      | From the VPS control panel or DNS A record            |
| `VPS_USER`       | `root`                                    | SSH user                     | Use `root` for deploys (the deploy dir is `/opt/...`) |
| `VPS_DEPLOY_DIR` | `/opt/langgraph-app`                      | Deploy dir on the VPS        | Any path you want                                     |
| `PUBLIC_DOMAIN`  | `ai.example.com`                          | Public domain browsers hit   | DNS A record pointing to `VPS_HOST`                   |
| `GH_OWNER`       | `your-org`                                | GitHub user or org           | The owner after forking                               |
| `GH_REPO`        | `langgraph-app`                           | Repo name                    | Default is this                                       |
| `IMAGE`          | `ghcr.io/<your-org>/langgraph-app:latest` | Full image name              | Composed from `GH_OWNER/REPO`                         |
| `CD_WORKFLOW`    | `CD.yml`                                  | GitHub Actions workflow name | The filename under `.github/workflows/`               |

**When the agent runs this skill for the first time**:

1. **Ask the user** for these values (or infer `GH_OWNER/REPO` from the conversation context / `git remote get-url origin`)
2. Store them in the "Key anchors" table at the top of this skill (replacing the examples)
3. Subsequent commands substitute `<VPS_USER>` `<VPS_HOST>` etc. directly

---

## 1. First-time deployment (cold start)

### 1.1 User actions (the agent does NOT do these)

The following **must be done by a human** — the agent must never pretend to be the user clicking buttons on external sites. Each item has a URL + purpose.

#### External API keys

| Resource                                    | Where to get it                                                                | Purpose                        | Required?                            |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------ |
| `OPENAI_API_KEY`                            | <https://platform.openai.com/api-keys>                                         | LLM calls                      | **Required**                         |
| `BETTER_AUTH_SECRET`                        | `openssl rand -hex 32` (local)                                                 | Signs sessions                 | **Required**                         |
| `POSTGRES_PASSWORD`                         | `openssl rand -hex 24` (local)                                                 | DB password                    | **Required**                         |
| `POSTGRES_USER` / `POSTGRES_DB`             | Your choice (e.g. `langgraph` / `langgraph_app`)                               | DB credentials                 | **Required**                         |
| `RESEND_API_KEY`                            | <https://resend.com/api-keys>                                                  | Verification emails on sign-up | Optional                             |
| `JINA_API_KEYS`                             | <https://jina.ai/reader>                                                       | `search_web` tool              | Optional                             |
| `ALCHEMY_API_KEY`                           | <https://dashboard.alchemy.com>                                                | On-chain data                  | Optional                             |
| `DENO_DEPLOY_TOKEN`                         | <https://console.deno.com>                                                     | `execute_code` tool            | Optional                             |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | <https://github.com/settings/developers> → New OAuth App                       | GitHub sign-in                 | Optional                             |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | <https://console.cloud.google.com/apis/credentials>                            | Google sign-in                 | Optional                             |
| `LANGSMITH_API_KEY`                         | <https://smith.langchain.com>                                                  | Tracing                        | Optional                             |
| `WALLETCONNECT_PROJECT_ID`                  | <https://dashboard.reown.com> (formerly cloud.walletconnect.com) → New Project | Wallet UI                      | Optional (skip if not using wallets) |

#### Two required steps for WalletConnect / Reown

1. Create a project at <https://dashboard.reown.com> and note the Project ID
2. **Immediately** in the Reown dashboard → project settings → **Allowed domains** add `PUBLIC_DOMAIN` (e.g. `ai.example.com`)
   - **Without this restriction, anyone who deploys an image baked with your project ID burns your Reown quota**

#### GitHub repo secret

At <https://github.com/<GH_OWNER>/<GH_REPO>/settings/secrets/actions> → New repository secret:

| Secret name                             | Value            | Purpose                                                                       |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | Reown Project ID | CD bakes it into the client bundle at build time (`NEXT_PUBLIC_*` is inlined) |

**If this secret is missing**: CD won't fail — it falls back to the placeholder `build-placeholder-project-id` and continues. But the bundle will carry a fake project ID, and the wallet UI won't work.

#### Cloudflare setup (if the domain is CF-proxied)

1. Add the domain to Cloudflare, DNS `A <PUBLIC_DOMAIN> → <VPS_HOST>`, proxy enabled (orange cloud)
2. <https://dash.cloudflare.com> → select domain → **SSL/TLS** → **Origin Server** → **Create Certificate** (15 years)
3. Save:
   - **Certificate** contents → `<VPS_DEPLOY_DIR>/caddy-origin.pem` on the VPS
   - **Private Key** contents → `<VPS_DEPLOY_DIR>/caddy-origin-key.pem` on the VPS

> **Works without Cloudflare**: remove the `caddy` service from `docker-compose.yml` and change the `Caddyfile` to use `tls internal` (self-signed, debug only). Production must use a real certificate.

### 1.2 User writes `.env.vps`

The user creates `LOCAL_REPO/.env.vps` (**gitignored**) with one `KEY=VALUE` per line:

```bash
# Copy the repo's .env.example and edit
cp .env.example .env.vps
vim .env.vps
# At minimum, fill in:
#   OPENAI_API_KEY=sk-...
#   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
#   BETTER_AUTH_URL=https://<PUBLIC_DOMAIN>
#   POSTGRES_USER=langgraph
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   POSTGRES_DB=langgraph_app
# See .env.example comments for the rest
```

`.env.vps` is already in `.gitignore` — `git status` won't see it. **Never commit it.**

### 1.3 VPS-side initialization (first time SSHing into the VPS)

```bash
# 1. Install Docker (Ubuntu 24.04)
#    https://docs.docker.com/engine/install/ubuntu/
#    Verify: docker compose version

# 2. Create the deploy directory
ssh <VPS_USER>@<VPS_HOST> 'mkdir -p <VPS_DEPLOY_DIR> && chown root:root <VPS_DEPLOY_DIR>'

# 3. Disable SSH password auth (standard production config)
ssh <VPS_USER>@<VPS_HOST> 'cat > /etc/ssh/sshd_config.d/10-disable-password.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh'

# 4. Verify: local key works, password doesn't
ssh -o BatchMode=no -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no <VPS_USER>@<VPS_HOST>
# Expected: Permission denied (publickey)
```

### 1.4 Agent actions

**1.4.1 Upload deploy files**

```bash
# Local
cd $LOCAL_REPO
scp docker-compose.yml Caddyfile \
  <VPS_USER>@<VPS_HOST>:<VPS_DEPLOY_DIR>/
scp ~/.../caddy-origin.pem ~/.../caddy-origin-key.pem \
  <VPS_USER>@<VPS_HOST>:<VPS_DEPLOY_DIR>/
scp .env.vps <VPS_USER>@<VPS_HOST>:<VPS_DEPLOY_DIR>/.env
ssh <VPS_USER>@<VPS_HOST> 'chmod 600 <VPS_DEPLOY_DIR>/.env <VPS_DEPLOY_DIR>/caddy-origin*.pem'
```

**1.4.2 Pull image + start stack**

```bash
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker compose pull app && \
  docker compose up -d'
sleep 45
ssh <VPS_USER>@<VPS_HOST> 'docker logs --tail=50 langgraph-app-app-1'
```

Expected log (any of these lines means startup succeeded):

```
Application startup complete.
Uvicorn running on http://0.0.0.0:2024
JS graph server listening
```

**1.4.3 Verify**

```bash
# Internal endpoints
ssh <VPS_USER>@<VPS_HOST> 'curl -fsS -o /dev/null -w ":3000/api/auth/get-session: %{http_code}\n" http://localhost:3000/api/auth/get-session'
ssh <VPS_USER>@<VPS_HOST> 'curl -fsS -o /dev/null -w ":2024/ok: %{http_code}\n" http://localhost:2024/ok'

# Public
curl -fsS -o /dev/null -w "GET /: %{http_code}\n" https://<PUBLIC_DOMAIN>/
curl -fsS -o /dev/null -w "GET /api/auth/get-session: %{http_code}\n" https://<PUBLIC_DOMAIN>/api/auth/get-session
```

Expected:

- `:3000/api/auth/get-session` → `200` (empty session when not logged in, not 401)
- `:2024/ok` → `200`
- `https://<PUBLIC_DOMAIN>/` → `307` → `/login` (Next.js auth middleware redirect)
- `https://<PUBLIC_DOMAIN>/api/auth/get-session` → `200`

**First start runs 60 DB migrations** (Drizzle + langgraph PostgresStore + langgraph-api runtime), 30-60s. **Idempotent** — safe to restart.

**1.4.4 Confirm the GHCR package is public (so CD can push and the VPS can pull without auth)**

```bash
# After the first CD run, check (use /users/ for a user, /orgs/ for an org)
gh api /users/<GH_OWNER>/packages/container/langgraph-app \
  -H "Accept: application/vnd.github+json" \
  --jq '.visibility'  # should be "public"

# If private, change to public:
gh api -X PATCH /user/packages/container/langgraph-app \
  -f visibility=public
# For an org:  /orgs/<GH_OWNER>/packages/container/langgraph-app
```

---

## 2. Push code → CD → pull new image (daily updates)

```bash
# 1. Local: push to main
cd $LOCAL_REPO
git status  # clean before pushing
git push origin main

# 2. Wait for CD to finish (5-8 min, all three jobs ✓)
gh run watch $(gh run list --workflow=$CD_WORKFLOW --limit=1 --json databaseId -q '.[0].databaseId') \
  --repo <GH_OWNER>/<GH_REPO> --exit-status

# 3. VPS pulls the new image + restarts
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker compose pull app && \
  docker compose up -d'

# 4. Verify
curl -fsS -o /dev/null -w "GET /: %{http_code}\n" https://<PUBLIC_DOMAIN>/
ssh <VPS_USER>@<VPS_HOST> 'docker logs --tail=20 langgraph-app-app-1'
```

Postgres + Redis volumes are preserved — **user data is not lost**. Only the stack code changes.

---

## 3. Rollback

When a new version breaks something:

```bash
# 1. Find the last working commit / image tag
git log origin/main  # look at the most recent commits
# Each GitHub Release also has a tarball:
#   https://github.com/<GH_OWNER>/<GH_REPO>/releases

# 2A. Method A: git revert (recommended — keeps git history)
git revert <bad-commit>
git push origin main
# wait for CD → pull → up

# 2B. Method B: pull a previous image directly from GHCR
TAG=<previous-commit-short-sha>  # e.g. a1b2c3d
ssh <VPS_USER>@<VPS_HOST> "docker pull <IMAGE:${TAG}> && \
  docker tag <IMAGE:${TAG}> <IMAGE:latest>"
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && docker compose up -d'

# 2C. Method C: GitHub Release tarball (no GHCR credentials needed)
curl -fL "https://github.com/<GH_OWNER>/<GH_REPO>/releases/download/${TAG}/langgraph-app-${TAG}.tar.gz" \
  -o /tmp/lg-${TAG}.tar.gz
scp /tmp/lg-${TAG}.tar.gz <VPS_USER>@<VPS_HOST>:/tmp/
ssh <VPS_USER>@<VPS_HOST> "docker load -i /tmp/lg-${TAG}.tar.gz && \
  docker tag <IMAGE:${TAG}> <IMAGE:latest>"

# 3. Verify
curl -fsS -o /dev/null -w "GET /: %{http_code}\n" https://<PUBLIC_DOMAIN>/
```

**Key constraints**:

- Rollback **does not** revert the DB schema (migrations are forward-only; cross-major-version rollback can break schema compatibility)
- Rollback **does not** change `.env` or GH secrets
- Rollback **loses** the `restart unless-stopped` health check window (30-60s cold start)

**Reverse rollback (back to latest)**:

```bash
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker pull <IMAGE:latest> && \
  docker compose up -d'
```

---

## 4. Reset environment (wipe all data)

Reset scenarios: changed `BETTER_AUTH_SECRET` / `POSTGRES_PASSWORD` (old sessions are dead), migration deadlocked, debugging.

```bash
# 1. Back up first (reset destroys data!)
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "langgraph-pre-reset-$(date +%F).sql.gz"

# 2. Stop the stack + remove volumes
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker compose down --volumes --remove-orphans'

# 3. Remove the old image + pull the new
ssh <VPS_USER>@<VPS_HOST> 'docker rmi <IMAGE:latest> || true'
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && docker compose pull app'

# 4. Start the stack
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && docker compose up -d'
sleep 45
ssh <VPS_USER>@<VPS_HOST> 'docker logs --tail=50 langgraph-app-app-1'
```

---

## 5. Upgrade

**Bottom-up**: lower layers first (OS / Docker), then application layers (base image / Node / deps). **Always back up first** (see §6).

### 5.1 OS

```bash
ssh <VPS_USER>@<VPS_HOST> 'apt update && apt upgrade -y'
# 24.04 → 24.04.x point release: the above is enough
# 24.04 → 25.04/26.04: do-release-upgrade (in-place is risky; backup + fresh VPS is safer)
```

### 5.2 Docker Engine

```bash
ssh <VPS_USER>@<VPS_HOST> 'apt update && apt upgrade -y docker-ce docker-ce-cli containerd.io docker-compose-plugin'
# Roll back on failure: apt install -y docker-ce=<previous-version> ...
```

### 5.3 Base image (`langchain/langgraphjs-api:22`)

The `FROM` line at the top of `Dockerfile`: `FROM langchain/langgraphjs-api:22` → `:23` (if upstream ships one). **Before any major version bump, check** <https://github.com/langchain-ai/langgraph/pkgs/container/langgraphjs-api> changelog — the migration list is not backward-compatible across major versions. After the change, validate with `docker compose build` locally.

### 5.4 Node (22 → 24)

Change `.nvmrc` from `22` to `24` and `engines.node` in `package.json` to `>=24`. The CI/CD runner uses the new version. Check dependency compatibility (wagmi/next/typescript all support 24).

### 5.5 pnpm

Update the `packageManager` field in `package.json`.

### 5.6 Postgres 16 → 17 (major-version warning)

**Don't just swap the image tag** — `pg_dump` first, then move to a new container, then restore. Edit `image: postgres:17-alpine` in `docker-compose.yml` after backing up.

---

## 6. Backup + restore

```bash
# Backup
ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
  docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "langgraph-$(date +%F).sql.gz"

# Restore
gunzip -c langgraph-YYYY-MM-DD.sql.gz | \
  ssh <VPS_USER>@<VPS_HOST> 'cd <VPS_DEPLOY_DIR> && \
    docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

The only persistent state is the `langgraph-app_postgres-data` named volume. `pg_dump` is enough to back it up.

---

## 7. Special baked items in the image

`package.json` includes `pnpm.overrides.qr: 0.5.5` — `qr@0.6.0` raised the minimum `border` value from 0 to 1, but RainbowKit's `cuer@0.0.3` hardcodes `border: 0`, so QR rendering throws and the entire RainbowKit modal crashes. Pinning 0.5.5 is a temporary workaround; drop the override once `wevm/cuer` ships a release compatible with `qr@0.6.0`. See [rainbow-me/rainbowkit#2680](https://github.com/rainbow-me/rainbowkit/pull/2680).

---

## 8. Common CD failure modes + fixes

| Failure                                       | Cause                                                             | Fix                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build` exit 1                           | typecheck / lint / test failed                                    | Reproduce locally with `pnpm typecheck && pnpm lint && pnpm test`                                                          |
| `pnpm build` says "No projectId found"        | `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` GH secret not set         | Set the secret, or confirm the repo's CD workflow file has a `\|\| 'build-placeholder-project-id'` fallback                |
| `failed to solve: Get https://ghcr.io/v2/...` | GHCR auth failed                                                  | `permissions: packages: write` is already in the CD workflow; PRs from forks don't push, so auth failure is expected there |
| VPS pull 401 unauthorized                     | GHCR image went private                                           | <https://github.com/<GH_OWNER>/<GH_REPO>/packages/container/langgraph-app/settings> → Change visibility → Public           |
| App container keeps restarting                | Postgres / Redis didn't come up; first start is slow (migrations) | Check `docker compose logs postgres`; 30-60s on first start is normal                                                      |

---

## 9. Notes for the agent maintaining this skill

- Changing any deploy-related code (`Dockerfile` / `docker-compose.yml` / `CD.yml` / `CI.yml`) → update the corresponding section of this skill
- Changing the `.env` schema (see the repo's `docs/DEPLOY.md` or `.env.example`) → update the table in §1.1
- After a successful deploy, update the "Key anchors" table at the top with **current commit hash + deploy time + image digest**
- Adding a new GH secret → update §1.1
- User reports a deploy problem → first check §8 "Common CD failure modes"
- **Never write real API keys or OAuth secrets into the skill doc** — use `<your-key>` placeholders or external links

---

## 10. Hard lines: things the agent must NOT do for the user

These are the **user's** responsibility. The agent gives guidance but does not act:

1. **Apply for external API keys** (OpenAI / Reown / Resend / Jina / Alchemy / Deno Deploy / OAuth)
2. **Generate random secrets locally** (e.g. `openssl rand -hex 32`)
3. **Write `.env.vps`** (the user writes it; the agent only scps it over)
4. **Create the Cloudflare Origin Certificate** (in the Cloudflare dashboard, save to VPS)
5. **Set Reown Allowed domains** (at <https://dashboard.reown.com>; no restriction = anyone can burn your Reown quota)
6. **Configure GitHub repository secrets** (in repo Settings)
7. **Configure Cloudflare DNS + proxy** (add `A <PUBLIC_DOMAIN> → <VPS_HOST>`, enable proxy)
8. **Set up the VPS SSH key** (locally `ssh-copy-id <VPS_USER>@<VPS_HOST>`)
9. **Rotate production secrets** (after the user changes `.env`, the agent restarts the stack — but **what** to change is the user's call)
10. **Pay for anything** (CF Pro, Reown upgrades, OpenAI overage, etc.)
