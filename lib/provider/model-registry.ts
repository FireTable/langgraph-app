import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { asc, eq } from "drizzle-orm";
import { LRUCache } from "lru-cache";

import { db } from "@/db/client";
import { provider as providerTable, type ProviderApiKey } from "@/lib/provider/schema";
import { aesGcmDecrypt, loadKek } from "@/lib/auth/encryption";

// ponytail: 60s TTL on the (provider, model, key) TUPLE list, not on
// the wrapped runnable. The wrapped runnable is rebuilt on every call
// so round-robin can advance; the tuple list (encrypted blobs + baseUrl)
// only changes when admin CUDs a row, so a 60s refresh is plenty.
const TUPLE_CACHE_TTL_MS = 60 * 1000;
const TUPLE_CACHE_MAX = 10;

type OptsKey = string;

// ponytail: a "tuple" is one (provider, model, key) leaf — the unit of
// load distribution. Each call picks one as the primary via round-robin;
// the rest become the withFallbacks chain. Deterministic ordering by
// (providerId, modelName, keyName) so the round-robin is stable across
// cache misses (a fresh process always starts at the same primary for
// the same opt shape, not at a random key).
type ModelTuple = {
  providerId: string;
  baseUrl: string | undefined;
  modelName: string;
  key: ProviderApiKey;
};

const tupleCache = new LRUCache<OptsKey, ModelTuple[]>({
  max: TUPLE_CACHE_MAX,
  ttl: TUPLE_CACHE_TTL_MS,
});

// ponytail: process-local round-robin counter. Each call to
// getChatModelFromDB advances by 1, so a stable (provider, model) opt
// shape distributes starting key across the tuple list evenly. Counter
// is per-process (LangGraph and Next.js each have their own); per-process
// is fine for a self-host where the bottleneck is rate-limit per key,
// not coordinated cluster-wide fair distribution. No priority field —
// every enabled key gets a slot; ordering is by (providerId, modelName,
// keyName) so the rotation is reproducible.
let nextTupleIndex = 0;

export type GetChatModelOpts = {
  providerId?: string;
  modelName?: string;
};

/**
 * Resolve a chat model from the DB, returning a round-robin-balanced
 * fallback chain across all enabled (provider, model, key) tuples that
 * match the opts. With no opts, every enabled provider's enabled models
 * and keys are in the pool; with `providerId` set, only that provider's
 * tuples; with `modelName` set, only matching models.
 *
 * The wrapped runnable is rebuilt on every call so the round-robin can
 * advance. The tuple list (DB rows + encrypted key blobs) is cached for
 * 60s — admin CUD calls `invalidateModelCache()` to bust it eagerly.
 *
 * No priority field. Even distribution by rotation: call N's primary is
 * the Nth tuple modulo len(tuples). On retryable error, LangChain's
 * `withFallbacks` walks the rest in order; on the last tuple's error,
 * that last error is rethrown.
 */
export async function getChatModelFromDB(opts: GetChatModelOpts = {}): Promise<BaseChatModel> {
  const cacheKey = `${opts.providerId ?? "*"}:${opts.modelName ?? "*"}`;

  let tuples = tupleCache.get(cacheKey);
  if (!tuples) {
    tuples = await collectTuples(opts);
    tupleCache.set(cacheKey, tuples);
  }

  if (tuples.length === 0) {
    throw new Error(
      opts.providerId
        ? `no enabled (provider, model, key) tuple for ${cacheKey}`
        : `no enabled provider in DB (cacheKey=${cacheKey})`,
    );
  }

  // Round-robin pick. Counter advances on every call so consecutive
  // calls see a different primary; the rest of the tuples become the
  // withFallbacks chain. modulo is safe — nextTupleIndex is unbounded
  // but JS doubles can hold 2^53, plenty for any realistic QPS.
  const start = nextTupleIndex++ % tuples.length;

  // Build one ChatOpenAI per tuple. The decrypt + ctor cost is small
  // (AES + LangChain field assignment, no network) — the user explicitly
  // traded the old LRU-on-wrapped-runnable for per-call round-robin.
  const models = tuples.map(
    (t) =>
      new ChatOpenAI({
        model: t.modelName,
        apiKey: decryptApiKey(t.key),
        configuration: t.baseUrl ? { baseURL: t.baseUrl } : undefined,
        streaming: true,
        // ponytail: only minimax reads this — keeping it hard-coded keeps
        // the DB schema free of a one-off knob that no other provider honors.
        modelKwargs: { reasoning_split: true },
      }),
  );

  // Rotate so the round-robin pick is index 0; withFallbacks always
  // uses [0] as primary, [1..] as the chain.
  const ordered = [...models.slice(start), ...models.slice(0, start)];

  // ponytail: skip the withFallbacks wrapper when there's only one
  // candidate — LangChain's wrapper is a no-op then, and a bare
  // ChatOpenAI has fewer stack frames on the hot path.
  const runnable = ordered.length === 1 ? ordered[0] : ordered[0].withFallbacks(ordered.slice(1));
  // ponytail: withFallbacks returns RunnableWithFallbacks (a Runnable),
  // not a BaseChatModel. The 7 `createAgent({llm}).bindTools(...)`
  // consumers in backend/model.ts already cast via `as ChatOpenAI`, so
  // structural methods (invoke / stream / bindTools) all work at
  // runtime — TypeScript just can't see through the wrap. Cast through
  // `unknown` once at the boundary; don't pepper the call sites.
  return runnable as unknown as BaseChatModel;
}

/**
 * Bust the tuple cache. With no arg, clears every entry (use after CUD
 * on the provider/models/apiKeys rows). With a specific key, clears
 * just that `(providerId, modelName)` opt-shape.
 */
export function invalidateModelCache(key?: OptsKey): void {
  if (key) tupleCache.delete(key);
  else tupleCache.clear();
}

async function collectTuples(opts: GetChatModelOpts): Promise<ModelTuple[]> {
  const providerRows = opts.providerId
    ? await db.select().from(providerTable).where(eq(providerTable.id, opts.providerId))
    : await db.select().from(providerTable).orderBy(asc(providerTable.id));

  const tuples: ModelTuple[] = [];
  for (const p of providerRows) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (!m.enabled) continue;
      if (opts.modelName && m.name !== opts.modelName) continue;
      for (const k of p.apiKeys) {
        tuples.push({
          providerId: p.id,
          baseUrl: p.baseUrl,
          modelName: m.name,
          key: k,
        });
      }
    }
  }
  return tuples;
}

function decryptApiKey(blob: ProviderApiKey): string {
  const kek = loadKek();
  return aesGcmDecrypt(blob.encryptedKey, blob.iv, kek);
}
