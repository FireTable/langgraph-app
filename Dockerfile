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
#
# The two-step COPY is intentional: a single-line `COPY ... patches ./`
# reused a stale GHA layer that had been built when .dockerignore
# still excluded `patches/`. Splitting the COPY into a wildcard
# (`patches/*.patch`) and renaming the destination (`.` → `./patches/`)
# forces a new layer because both the source glob and the destination
# differ from the old step. The expanded wildcard pulls the actual
# files in now that .dockerignore no longer filters the directory.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches/*.patch ./patches/
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
ENV LANGGRAPH_ASSISTANT_ID=agent
# ponytail: all client-visible values (LANGGRAPH_ASSISTANT_ID,
# LANGGRAPH_PUBLIC_URL, WALLET_CONNECT_PROJECT_ID,
# R2_ALLOWED_CONTENT_TYPES, ATTACHMENTS_ENABLED) are server-only env,
# surfaced to the browser at request time via `window.__CONFIG__`
# injected by app/layout.tsx. CLAUDE.md rule #12.
RUN pnpm build

# LangGraph runtime config — start.sh loads graph registrations from
# langgraph.json; point the runtime at our DB.
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