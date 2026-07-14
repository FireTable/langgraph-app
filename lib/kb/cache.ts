import { LRUCache } from "lru-cache";

import {
  findKbChunksByDocumentId,
  findKbDocumentById,
  type KbChunk,
  type KbDocument,
} from "./queries";

// ponytail: v2 KB resolve cache. Same shape as `backend/memory/recall.ts`
// — keyed by `${userId}:${docId}` so cross-user access (which we
// 404) can never hit the other user's cached entry.
//
// Capacity ceiling: 500 entries × ~5 KB doc + chunks each ≈ 2.5 MB worst
// case — well below a single chat's working set. TTL matches the memory
// cache (5 min) — long enough that back-to-back kb_ref resolves hit, short
// enough that a doc the user just deleted doesn't keep serving stale
// chunks.

export type CachedKbDoc = {
  doc: KbDocument;
  chunks: KbChunk[];
};

const cache = new LRUCache<string, CachedKbDoc>({
  max: 500,
  ttl: 5 * 60 * 1000,
  // ponytail: size entry by chunk count; bound the total work, not bytes.
  // One kb_document with 50 chunks counts as 50 units. Disposal hook
  // is a no-op — chunks + embedding arrays are GC'd with the entry.
  sizeCalculation: (entry) => Math.max(1, entry.chunks.length + 1),
  maxSize: 5_000,
});

function key(userId: string, docId: string): string {
  return `${userId}:${docId}`;
}

export async function getKbDocForResolve(
  userId: string,
  docId: string,
): Promise<CachedKbDoc | null> {
  const cached = cache.get(key(userId, docId));
  if (cached) return cached;
  const doc = await findKbDocumentById(userId, docId);
  if (!doc) return null;
  const chunks = await findKbChunksByDocumentId(userId, docId);
  const entry: CachedKbDoc = { doc, chunks };
  cache.set(key(userId, docId), entry);
  return entry;
}

// Called from chunkEmbedStoreNode once the new chunks land — the cache
// mustn't serve the stale empty list to the very next resolve that
// happens before the next request.
export function invalidateKbDoc(userId: string, docId: string): void {
  cache.delete(key(userId, docId));
}

export function clearKbCache(): void {
  cache.clear();
}

// Test-only escape hatch (asserts the LRU internals without exposing
// them across the module boundary).
export function _kbCacheForTest(): LRUCache<string, CachedKbDoc> {
  return cache;
}
