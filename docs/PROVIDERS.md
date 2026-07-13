# Providers

The runtime chat model that powers every LangGraph node is resolved at **call time** from the `provider` table in Postgres, not from `process.env`. The DB-backed registry is the only thing the graph knows about; `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` are a graceful fallback when the table is empty (first-boot, before the seed migration runs, or if the operator wipes the registry).

Resolution path:

1. **`backend/model.ts:getChatModel(opts?)`** — canonical entry point. Every LangGraph node calls this. Tries the DB registry first; on miss / DB unreachable, falls back to a `ChatOpenAI` built from env vars so dev still works pre-seed.
2. **`lib/provider/model-registry.ts:getChatModelFromDB(opts?)`** — the pure-DB path. Collects every enabled `(provider, model, key)` tuple matching the opts, decrypts each, picks one via round-robin, and returns the bare `ChatOpenAI`. **No fallback chain** — a previous version wrapped picks in `Runnable.withFallbacks(...)` but that returns a `RunnableWithFallbacks` (Runnable, not BaseChatModel) and dropped `.bindTools` / `.withStructuredOutput`, which crashed the 6 LangGraph node consumers. Cross-tuple retry on any thrown error is gone; add it back via a per-call-site `try/catch` loop when a per-key rate-limit becomes a real problem. The tuple list is cached in an in-process LRU keyed on `providerId:modelName` for 60s.
3. **`lib/provider/model-registry.ts:invalidateModelCache(key?)`** — called by every admin CUD route (`POST/PATCH/DELETE` under `/api/admin/providers/**`). Without an arg, clears the entire LRU; with a key, drops just that entry.

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

The cache key is `${providerId ?? "*"}:${modelName ?? "*"}` — derived purely from the caller-supplied opts, so a cache hit is a sync hash lookup with zero DB traffic. Different opt shapes land in different slots; admin invalidation drops them all.

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

`modelKwargs.reasoning_split: true` is hard-coded in the registry — only `minimax` honors it, but the DB schema is free of a one-off knob no other provider cares about. If a second provider ever needs a different kwarg, add a `metadata` jsonb column to `provider.models[]` and read it here.

## Future direction

- **Per-agent model binding** — pass `getChatModel({ agentName: "weather" })` and look up `provider.models[].defaultForAgents[]` from the DB. The registry signature already accepts `providerId` + `modelName`; per-agent is a one-arg extension.
- **Cross-process invalidation** — see § Cross-process tradeoff above.
- **Health observability** — `provider.last_used_at` / `last_success_at` / `last_error_at` / `last_error_message` columns + an admin "Test key" button. Out of scope for the round-robin work; add when the need surfaces (see issue #14).

## See also

- [`docs/ADMIN.md`](./ADMIN.md) — admin UI + endpoints for managing providers, keys, models.
- [`docs/DB.md`](./DB.md) — `provider` table schema, encryption-at-rest shape.
- [`docs/APIS.md`](./APIS.md) — `/api/admin/providers/**` endpoint reference.
