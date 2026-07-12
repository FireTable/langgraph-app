import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { and, asc, eq } from "drizzle-orm";
import { LRUCache } from "lru-cache";

import { db } from "@/db/client";
import {
  provider as providerTable,
  type ProviderApiKey,
} from "@/lib/provider/schema";
import { aesGcmDecrypt, loadKek } from "@/lib/auth/encryption";

// ponytail: 1h TTL — admin writes bust via invalidateModelCache(); the
// TTL is the fallback for replicas that don't see the bust signal.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 10;

// ponytail: cache key is derived from the caller-supplied opts alone, so
// the lookup is a sync hash hit and we don't pay a DB round-trip on cache
// hit. `"*"` is the placeholder for unset fields — different opt shapes
// land in different slots, which is fine: the DB lookup only runs once
// per (providerId, modelName) pair, and admin invalidation drops them all.
type OptsKey = string;

const cache = new LRUCache<OptsKey, BaseChatModel>({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
});

export type GetChatModelOpts = {
  providerId?: string;
  modelName?: string;
};

/**
 * Resolve a chat model from the DB, with an in-process LRU keyed on the
 * caller-supplied opts. With no opts, picks the first enabled provider's
 * first enabled model. Throws if no enabled provider/model exists.
 *
 * Admin writes call `invalidateModelCache()` to bust entries on demand.
 *
 * The pure-DB path. The `getChatModel()` wrapper in backend/model.ts adds
 * an env-var fallback on top of this — call that one from runtime code,
 * not this one.
 */
export async function getChatModelFromDB(
  opts: GetChatModelOpts = {},
): Promise<BaseChatModel> {
  const key = `${opts.providerId ?? "*"}:${opts.modelName ?? "*"}`;
  const cached = cache.get(key);

  if (cached) return cached;

  const { provider, modelName } = await resolveProviderAndModel(opts);
  const apiKeyBlob = pickRandomApiKey(provider.apiKeys);
  const apiKey = apiKeyBlob ? decryptApiKey(apiKeyBlob) : undefined;

  const model = new ChatOpenAI({
    model: modelName,
    apiKey,
    configuration: provider.baseUrl
      ? { baseURL: provider.baseUrl }
      : undefined,
    streaming: true,
    // ponytail: only minimax reads this — keeping it hard-coded keeps the
    // DB schema free of a one-off knob that no other provider honors.
    modelKwargs: { reasoning_split: true },
  });

  cache.set(key, model);
  return model;
}

/**
 * Bust the cache. With no arg, clears every entry (use after CUD on the
 * provider/models/apiKeys rows). With a specific key, clears just that
 * `(providerId, modelName)` opt-shape.
 */
export function invalidateModelCache(key?: OptsKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}

async function resolveProviderAndModel(opts: GetChatModelOpts): Promise<{
  provider: typeof providerTable.$inferSelect;
  modelName: string;
}> {
  const providerRows = opts.providerId
    ? await db
      .select()
      .from(providerTable)
      .where(
        and(eq(providerTable.id, opts.providerId), eq(providerTable.enabled, true)),
      )
      .limit(1)
    : await db
      .select()
      .from(providerTable)
      .where(eq(providerTable.enabled, true))
      .orderBy(asc(providerTable.id))
      .limit(1);

  if (providerRows.length === 0) {
    throw new Error("no enabled provider in DB");
  }
  const provider = providerRows[0];

  const modelName =
    opts.modelName ?? provider.models.find((m) => m.enabled)?.name;
  if (!modelName) {
    throw new Error(`no enabled model in provider "${provider.id}"`);
  }

  return { provider, modelName };
}

function pickRandomApiKey(keys: ProviderApiKey[]): ProviderApiKey | undefined {
  if (keys.length === 0) return undefined;
  return keys[Math.floor(Math.random() * keys.length)];
}

function decryptApiKey(blob: ProviderApiKey): string {
  const kek = loadKek();
  return aesGcmDecrypt(blob.encryptedKey, blob.iv, kek);
}