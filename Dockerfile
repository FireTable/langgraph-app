# Single image. Base = `langchain/langgraphjs-api:22` — the official
# LangGraph prod runtime (Python uvicorn + Go core). It ships with
# LANGGRAPH_RUNTIME_EDITION=postgres and reads POSTGRES_URI / DATABASE_URL
# for the compiled PostgresSaver, so thread state persists across
# container restarts. We add Next.js on top and run both via start.sh.
#
# Why this base over `langgraphjs dev`? dev mode force-loads an
# InMemorySaver regardless of what `backend/checkpointer.ts` exports
# (CLAUDE.md has a stale note about this; verified from CLI behavior).
# The runtime image honors the configured checkpointer.
FROM langchain/langgraphjs-api:22

WORKDIR /deps/langgraph-app

# Deps first (cached layer when the lockfile doesn't change).
# BuildKit cache-mount the pnpm store so packages survive across
# builds — only changed deps are re-fetched when the lockfile
# changes. Combined with CD.yml's `cache-to: type=gha,mode=max`,
# the store persists across CI runs. Requires DOCKER_BUILDKIT=1
# (default on GitHub Actions and modern Docker).
#
# ponytail: `patches/` is bundled with the workspace files because
# pnpm-workspace.yaml's `patchedDependencies` references it
# (CLAUDE.md's pnpm-10 placeholder). The lockfile hash-checks
# patch contents, so the files MUST be in the build context before
# `pnpm install` runs. CI hit ENOENT on this exact path; the
# follow-up `COPY . .` below copies the rest of the source but
# it's too late by then.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc patches ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,id=pnpm \
    corepack enable && pnpm install --frozen-lockfile

# App source.
COPY . .

# Build Next.js. `next build` statically evaluates App Router routes;
# Better Auth runs DB migrations at module load, which needs a reachable
# Postgres on localhost:5432. CD.yml exposes a postgres service for
# this; for local builds run `docker compose up -d postgres` first or
# override DATABASE_URL via `--build-arg`.
ENV NEXT_TELEMETRY_DISABLED=1
ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/langgraph_app
ENV DATABASE_URL=${DATABASE_URL}
ENV BETTER_AUTH_SECRET=build_secret_aabbccddeeff00112233445566778899
ENV BETTER_AUTH_URL=http://localhost:3000
ENV NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=agent
# WalletConnect project id is `NEXT_PUBLIC_*` so Next.js bakes it into
# the client bundle at build time — runtime env (docker-compose) is too
# late. CD.yml passes it via `--build-arg` from the
# `WALLET_CONNECT_PROJECT_ID` GitHub Actions secret. Default has to be
# a non-empty placeholder because RainbowKit's prerender throws
# "No projectId found" on an empty string — that broke CD on
# 2026-07-07. With the placeholder default, builds without the secret
# succeed (same silent wallet failure as before); with the secret set
# CD overwrites the placeholder with the real id.
ARG NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID="build-placeholder-project-id"
ENV NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=${NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID}
RUN pnpm build

# LangGraph runtime config — point at our graphs and DB.
ENV LANGSERVE_GRAPHS='{"agent":"./backend/agent.ts:graph","background_agent":"./backend/background-agent.ts:graph"}'
ENV POSTGRES_URI=${DATABASE_URL}
ENV LANGGRAPH_RUNTIME_EDITION=postgres
# Override base image PORT=8000 → 2024 (matches docker-compose + CLAUDE.md).
ENV PORT=2024
ENV LANGGRAPH_SERVER_HOST=0.0.0.0

COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3000 2024

# Override base image entrypoint; run.sh starts both Next.js and the
# LangGraph uvicorn server concurrently.
ENTRYPOINT ["/usr/local/bin/start.sh"]