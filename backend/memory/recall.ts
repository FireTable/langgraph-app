import { LRUCache } from "lru-cache";
import type { RunnableConfig } from "@langchain/core/runnables";

import { EMPTY_AUTH_INFO, getAuthInfo, getMemoryDoc } from "@/lib/memory/queries";
import { mergeMemory } from "@/lib/memory/merge";
import type { MemoryDoc } from "@/lib/memory/queries";

// ponytail: user-saved doc with auth fields overlaid. user-saved wins
// when a field is present (the user explicitly stored it via
// save_memory); otherwise the live auth record fills the gap so the
// model always sees a name/email even when nothing was saved yet.
//
// `threads` is no longer in the LLM-facing payload — that path was
// retired (cross-thread summary injection was leaky; thread summaries
// now live inline in the messages channel of each thread). The Memory
// tab UI still fetches past-thread summaries via /api/memory/threads.
export type LoadedMemory = {
  memory: MemoryDoc;
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

// ponytail: parallel of extractUserId for thread_id. Used by the
// system-prompt template to scope thread-summary injection to the
// current chat. Both fields ride on the same config.configurable
// envelope the LangGraph proxy sets in app/api/[..._path]/route.ts.
export function extractThreadId(
  config?: { configurable?: { thread_id?: unknown } } | RunnableConfig,
): string | null {
  const raw = config?.configurable?.thread_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function loadMemory(userId: string): Promise<LoadedMemory> {
  const [doc, auth] = await Promise.all([
    getMemoryDoc(userId).catch(() => ({})),
    getAuthInfo(userId).catch(() => EMPTY_AUTH_INFO),
  ]);
  return { memory: mergeMemory(doc, auth) };
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
