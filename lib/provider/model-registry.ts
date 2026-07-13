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
// load distribution. Each call picks one via round-robin and returns
// it directly. No fallback chain — a previous version wrapped the
// picks in `withFallbacks(...)` but that returns a `RunnableWithFallbacks`
// (Runnable, not BaseChatModel) and dropped `.bindTools` /
// `.withStructuredOutput`, which broke the 6 LangGraph node call
// sites that depend on those chat-model-only methods. Cross-tuple
// retry on error is gone; add it back via a manual try/catch wrapper
// at the call site if a per-key rate-limit becomes a real problem.
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

// ponytail: per-cacheKey round-robin counter — Map<OptsKey, count>. Each
// opt shape (default pool vs per-provider pool vs per-model pool) gets
// its own counter so interleaved calls don't drift a smaller pool onto
// a single index. Per-process is fine for a self-host where the
// bottleneck is rate-limit per key, not cluster-wide fair distribution.
const nextTupleIndexByKey = new Map<OptsKey, number>();

export type GetChatModelOpts = {
  providerId?: string;
  modelName?: string;
};

/**
 * Resolve a chat model from the DB, returning one round-robin-picked
 * (provider, model, key) tuple per call across all enabled tuples that
 * match the opts. With no opts, every enabled provider's enabled models
 * and keys are in the pool; with `providerId` set, only that provider's
 * tuples; with `modelName` set, only matching models.
 *
 * The picked ChatOpenAI is rebuilt on every call so the round-robin
 * can advance. The tuple list (DB rows + encrypted key blobs) is cached
 * for 60s — admin CUD calls `invalidateModelCache()` to bust it eagerly.
 *
 * No priority field. Even distribution by rotation: call N's primary is
 * the Nth tuple modulo len(tuples). On any thrown error, the exception
 * propagates — cross-tuple fallback is intentionally NOT here (see the
 * `ModelTuple` comment for the why).
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

  // Round-robin pick, scoped to the cacheKey so interleaving different
  // opt shapes doesn't drift a smaller pool onto a single index.
  const counter = nextTupleIndexByKey.get(cacheKey) ?? 0;
  nextTupleIndexByKey.set(cacheKey, counter + 1);
  const start = counter % tuples.length;

  // ponytail: build all N ChatOpenAIs, then return the round-robin
  // pick. N decrypt + ctor is small and amortized over the 60s tuple
  // TTL, so the "build only the picked one" optimization isn't worth
  // the cache-tracker complexity.
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

  // Return type stays BaseChatModel (not ChatOpenAI) so a non-OpenAI
  // provider can land without touching the 6 call sites; today every
  // registered model is ChatOpenAI.
  return models[start] as BaseChatModel;
}

/**
 * Bust the tuple cache. With no arg, clears every entry (use after CUD
 * on the provider/models/apiKeys rows). With a specific key, clears
 * just that `(providerId, modelName)` opt-shape.
 */
export function invalidateModelCache(key?: OptsKey): void {
  if (key) tupleCache.delete(key);
  else tupleCache.clear();
  // ponytail: clear the round-robin counter alongside the cache. The
  // next call rebuilds the tuple list from scratch, and a counter
  // trained on the old layout would pick a stale index.
  nextTupleIndexByKey.clear();
}

/**
 * ponytail: test-only hook. Resets every per-cacheKey counter to 0 so
 * tests asserting "call N picks tuple N" don't depend on whatever calls
 * the previous test made. No-op in prod (callers shouldn't reach for it,
 * but it doesn't expose anything worth attacking).
 */
export function resetRoundRobinCounters(): void {
  nextTupleIndexByKey.clear();
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
  // ponytail: explicit sort by (providerId, modelName, keyName) so the
  // rotation is reproducible across cache misses, matching the doc
  // contract. DB orderBy only covers the provider dimension; models and
  // keys come out of JSONB arrays in insertion order, which can drift
  // from alphabetical name sort.
  tuples.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.modelName.localeCompare(b.modelName) ||
      a.key.name.localeCompare(b.key.name),
  );
  return tuples;
}

function decryptApiKey(blob: ProviderApiKey): string {
  const kek = loadKek();
  return aesGcmDecrypt(blob.encryptedKey, blob.iv, kek);
}
