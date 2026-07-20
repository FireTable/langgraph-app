# Providers

The runtime model that powers every LangGraph node is resolved at **call time** from the `provider` table in Postgres, not from `process.env`. The DB-backed registry is the only thing the graph knows about; `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` are a graceful fallback when the table is empty (first-boot, before the seed migration runs, or if the operator wipes the registry).

Resolution paths:

1. **`backend/model.ts:getChatModel(opts?)`** — canonical entry point for chat-class models. Every LangGraph node calls this. Tries the DB registry first; on miss / DB unreachable, falls back to a `ChatOpenAI` built from env vars so dev still works pre-seed.
2. **`lib/provider/model-registry.ts:getChatModelFromDB(opts?)`** — the pure-DB chat path. Collects every enabled `(provider, model, key)` tuple matching the opts and whose `kind` includes `"chat"`, decrypts each, picks one via round-robin, and returns the bare `ChatOpenAI`. **No fallback chain** — a previous version wrapped picks in `Runnable.withFallbacks(...)` but that returns a `RunnableWithFallbacks` (Runnable, not BaseChatModel) and dropped `.bindTools` / `.withStructuredOutput`, which crashed the 6 LangGraph node consumers. Cross-tuple retry on any thrown error is gone; add it back via a per-call-site `try/catch` loop when a per-key rate-limit becomes a real problem. The tuple list is cached in an in-process LRU keyed on `kind=chat|providerId:modelName` for 60s.
3. **`lib/provider/model-registry.ts:getOcrModelFromDB(opts?)` / `getExtractModelFromDB(opts?)` / `getEmbeddingModelFromDB(opts?)` / `getRerankModelFromDB(opts?)`** — kind-aware variants for the non-chat pools (KB v3). Each filters on `kind.includes("<kind>")` and is round-robin-independent from the chat pool, so a chat burst doesn't starve an OCR pick. `getExtractModelFromDB` falls back to the chat pool when no tuple has `"extract"` in its `kind` list — every chat model is a valid structured-output caller, so the wiring is non-breaking for fresh installs that haven't flagged a model for extract work yet.
4. **`lib/provider/model-registry.ts:invalidateModelCache(key?)`** — called by every admin CUD route (`POST/PATCH/DELETE` under `/api/admin/providers/**`). Without an arg, clears the entire LRU; with a key, drops just that entry.

## Model `kind` — five-way capability split

Each row inside `provider.models[]` carries a `kind: ("chat" | "ocr" | "embed" | "extract" | "rerank")[]` array. A single model can serve multiple pools — `kind: ["chat","ocr"]` makes gpt-4o eligible for both. The route is decided by the caller, not by `kind`; `kind` is only a filter on the registry. Omitting `kind` on POST auto-fills `["chat"]` (back-compat with seed rows created before KB v3).

| `kind`    | What runs                                                                   | Caller today                                                                       |
| --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `chat`    | Reasoning + tool use (the default pool)                                     | Every sub-agent + 5 LangGraph nodes (see [`docs/MEMORY.md`](./MEMORY.md) topology) |
| `ocr`     | Vision-capable chat models used for PDF page → markdown (`kbAgent.ocrNode`) | `backend/agent/kb-agent.ts`                                                        |
| `embed`   | Dense-vector models for KB chunk embeddings                                 | `backend/agent/kb-agent.ts` (`OpenAIEmbeddings` from `@langchain/openai`)          |
| `extract` | Chat models earmarked for structured-output extraction                      | Optional — falls back to the `chat` pool when no tuple has `extract` in `kind`     |
| `rerank`  | Cross-encoder / Reranker APIs (Cohere, Jina, …)                             | `lib/kb/search.ts` when registered; otherwise the search skips the second stage    |

See [`docs/ADMIN.md`](./ADMIN.md) § Model registration for the admin UI surface and [`docs/APIS.md`](./APIS.md) § Admin for the request/response shape.

## Reranker shape (`RerankModel`)

`RerankModel` (same file, `lib/provider/model-registry.ts`) is a thin wrapper around the Cohere / Jina `/rerank` endpoint — picked the same way as a chat model, but returned as a class instead of a `BaseChatModel`. The constructor takes `{ providerId, baseUrl, modelName, apiKey }` from the DB tuple; `.rerank(query, documents, topN)` POSTs `{ model, query, documents, top_n }` to `${baseUrl}/rerank` and reshapes the response's `results[].relevance_score` into `{ index, score }[]`. When the provider id is `jina` and no explicit `baseUrl` is set, it falls back to `https://api.jina.ai/v1`; every other provider id defaults to `https://api.cohere.com/v1`. Operators wanting a non-default endpoint should set `baseUrl` on the provider row.

The fallback exists so a fresh checkout can boot end-to-end before `pnpm db:migrate` lands the seeded `default` provider row.

## Round-robin (no fallback chain)

The registry distributes traffic **evenly** across every enabled `(provider, model, key)` tuple, with no priority field — each tuple is one slot in the rotation. On every call, `getChatModelFromDB`:

1. Looks up the cached tuple list (sync LRU hit) or queries Postgres on miss.
2. Increments a process-local `nextTupleIndex` counter; the new primary is `tuples[counter % N]`.
3. Builds one `ChatOpenAI` per tuple (decrypt + `new ChatOpenAI(...)`, no I/O).
4. Returns **just the round-robin pick** as a bare `ChatOpenAI`. Cross-tuple retry is not implemented here (see callout above).

Deterministic ordering: tuples are sorted by `(providerId, modelName, keyName)`, so the rotation is reproducible across cache misses. Per-process counter — LangGraph and Next.js each have their own; per-process is fine for a self-host where the bottleneck is per-key rate-limit, not cluster-wide fair distribution.

## LRU cache + cross-process TTL

The registry caches the **(provider, model, key) tuple list** in `lib/provider/model-registry.ts` — the decrypted blobs, baseUrl, and model names. The picked `ChatOpenAI` is rebuilt on every call so round-robin can advance.

```ts
const tupleCache = new LRUCache<OptsKey, ModelTuple[]>({
  max: 10,
  ttl: 60 * 1000, // 60s
});
```

The cache key is `kind=<kind>|${providerId ?? "*"}:${modelName ?? "*"}` — the `kind=` prefix namespaces the LRU + the round-robin counter per pool so chat traffic and OCR traffic don't advance each other's pick positions. Different opt shapes (with or without `providerId` / `modelName`) land in different slots; admin invalidation drops them all. Five prefixes exist today (`chat / ocr / embed / extract / rerank`); adding a sixth only touches this file + one wrapper.

### The cross-process tradeoff

The Next.js dev server (port 3000) and the LangGraph dev server (port 2024) are **two separate processes** with two separate in-memory LRUs. When an admin writes a provider / model / key change through the Next.js API, `invalidateModelCache()` only clears the Next-side cache — the LangGraph process keeps its stale entry until the 60s TTL expires.

This is a deliberate choice: the alternative (LISTEN/NOTIFY or a shared Redis cache) is real infrastructure for what is fundamentally a 1-minute staleness window. The 60s TTL bounds how long an admin change can stay invisible to a fresh LangGraph request while keeping the hot path DB-free. If you need cross-process realtime, the two cheap upgrades are:

1. Drop `CACHE_TTL_MS` to `10_000` (10s). Trades hot-path DB load for tighter admin UX.
2. Add a Postgres `LISTEN provider_changed` channel; `invalidateModelCache` issues `NOTIFY`, the LangGraph process subscribes and clears locally. Real-time; needs a long-lived DB connection per process.

Today: 60s. Both upgrades are isolated to `lib/provider/model-registry.ts` and don't touch consumers.

## Seeded `default` provider

Migration `0003_melted_bedlam.sql` seeds one row:

```sql
INSERT INTO "provider" (id, name, enabled, base_url, api_keys, models, ...)
VALUES ('default', 'Default Provider', true,
        '__OPENAI_BASE_URL__',                    -- from process.env by db-migrate runner
        '__OPENAI_API_KEY_ENCRYPTED__'::jsonb,   -- encrypted with LLM_KEY_ENCRYPTION_KEY
        '__OPENAI_MODEL_JSON__'::jsonb,          -- [{ name: <OPENAI_MODEL>, enabled: true, inputPer1k: 0, outputPer1k: 0 }]
        now(), now())
ON CONFLICT (id) DO NOTHING;
```

`scripts/db-migrate.ts` (and `tests/setup.ts` for the test DB) reads the env vars, encrypts the key with `aesGcmEncrypt`, and substitutes the placeholders before applying the SQL. Pure SQL can't read `process.env`, so the runner is the bridge.

The seeded id is **protected** — `DELETE /api/admin/providers/default` returns 409 `PROTECTED` because at least one provider must always exist for the system to boot. The admin UI disables the corresponding button on the same id (server-side is the source of truth). Rename it via PATCH if you want a different display id; the protection follows the literal string `"default"`.

## Env fallback (no providers in DB)

When `getChatModelFromDB` throws (table empty, no enabled provider, or DB unreachable), `backend/model.ts:getChatModel` catches and constructs an env-only `ChatOpenAI`:

```ts
new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { configuration: { baseURL: process.env.OPENAI_BASE_URL } }
    : {}),
  streaming: true,
  modelKwargs: { reasoning_split: true },
});
```

This is what lets `pnpm dev` work before the migration runs. In production, the seed migration always lands first (CI runs `pnpm db:migrate` before booting the app container), so the env path is dormant.

## Callers

Every LangGraph node that calls an LLM goes through `backend/model.ts:getChatModel()`. Today: `backend/agent/{chat,code,weather,crypto}-agent.ts` + `backend/node/{rename-thread-agent,thread-summarize,router-agent}-node.ts`. All call sites are `await getChatModel()` (async). Adding a new node: import the same getter, no further wiring.

The non-chat pools are reached directly from `lib/provider/model-registry.ts`:

- `getOcrModelFromDB` — `backend/agent/kb-agent.ts` (PDF page screenshots → markdown)
- `getEmbeddingModelFromDB` — `backend/agent/kb-agent.ts` (chunk vectors, 1024-dim)
- `getExtractModelFromDB` — `backend/agent/kb-agent.ts` (LightRAG-style entity / relationship / theme extraction)
- `getRerankModelFromDB` — `lib/kb/search.ts` (only when an admin has flagged a model with `kind: ["rerank"]`)

The chat path stays the env fallback (`backend/model.ts`) — the others throw if no matching tuple exists.

`modelKwargs.reasoning_split: true` is hard-coded in the registry — only `minimax` honors it, but the DB schema is free of a one-off knob no other provider cares about. If a second provider ever needs a different kwarg, add a `metadata` jsonb column to `provider.models[]` and read it here.

## Future direction

- **Per-agent model binding** — pass `getChatModel({ agentName: "weather" })` and look up `provider.models[].defaultForAgents[]` from the DB. The registry signature already accepts `providerId` + `modelName`; per-agent is a one-arg extension.
- **Cross-process invalidation** — see § Cross-process tradeoff above.
- **Health observability** — `provider.last_used_at` / `last_success_at` / `last_error_at` / `last_error_message` columns + an admin "Test key" button. Out of scope for the round-robin work; add when the need surfaces (see issue #14).

## See also

- [`docs/ADMIN.md`](./ADMIN.md) — admin UI + endpoints for managing providers, keys, models.
- [`docs/DB.md`](./DB.md) — `provider` table schema, encryption-at-rest shape.
- [`docs/APIS.md`](./APIS.md) — `/api/admin/providers/**` endpoint reference.
