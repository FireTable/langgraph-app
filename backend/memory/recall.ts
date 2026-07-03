import { LRUCache } from "lru-cache";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  getAuthInfo,
  getMemoryDoc,
  getRecentThreadSummaries,
  type MemoryDoc,
} from "@/lib/memory/queries";
import { mergeMemory } from "@/lib/memory/merge";
import { MEMORY_THREAD_RECALL_LIMIT } from "@/lib/memory/constants";
import type { SummaryEntry } from "@/lib/memory/validators";

export type LoadedMemory = {
  // ponytail: user-saved doc with auth fields overlaid. user-saved wins
  // when a field is present (the user explicitly stored it via
  // save_memory); otherwise the live auth record fills the gap so the
  // model always sees a name/email even when nothing was saved yet.
  memory: MemoryDoc;
  threads: Array<{ key: string; value: SummaryEntry }>;
};

// ponytail: 1000 entries × ~10-50KB per payload = single-digit MB. Way
// more than concurrent users in dev; trim if memory becomes a concern.
// 60s TTL is a belt-and-suspenders against missed invalidate() calls —
// save_memory explicitly clears the cache on write, so this is mostly
// theoretical.
const memoryCache = new LRUCache<string, LoadedMemory>({
  max: 1000,
  ttl: 60_000,
  updateAgeOnGet: true,
});

export function extractUserId(
  config?: { configurable?: { userId?: unknown } } | RunnableConfig,
): string | null {
  const raw = config?.configurable?.userId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function loadMemory(userId: string): Promise<LoadedMemory> {
  const [doc, auth, threads] = await Promise.all([
    getMemoryDoc(userId).catch(() => ({})),
    getAuthInfo(userId).catch(() => ({
      name: null,
      email: null,
      image: null,
      socials: [] as Array<{ provider: string }>,
    })),
    getRecentThreadSummaries(userId, MEMORY_THREAD_RECALL_LIMIT).catch(() => []),
  ]);
  return { memory: mergeMemory(doc, auth), threads };
}

export async function getCachedMemory(userId: string): Promise<LoadedMemory | null> {
  if (!userId) return null;
  const hit = memoryCache.get(userId);
  if (hit) return hit;
  const fresh = await loadMemory(userId);
  memoryCache.set(userId, fresh);
  return fresh;
}

export function invalidateMemory(userId: string): void {
  memoryCache.delete(userId);
}
