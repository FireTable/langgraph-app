// ponytail: in-memory Jina API key pool. The LangGraph dev server is a
// long-running process, so we can keep keys in a module-level array and
// mutate it on 401/403 without persisting anywhere. Failover loops up to
// the original pool size — once every key has rejected us, the request
// gives up. r.jina.ai (the reader) accepts unauthenticated requests on
// the free tier, so an empty pool falls through to a no-Auth fetch — the
// caller gets the result either way, just at a lower rate limit. s.jina.ai
// (the search endpoint) requires a key; tools that depend on it gate
// registration on a non-empty pool so the model never sees a failing tool.

export function parseKeys(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const pool: string[] = parseKeys(process.env.JINA_API_KEYS);

export function poolSize(): number {
  return pool.length;
}

export function hasKeys(): boolean {
  return pool.length > 0;
}

export function pickKey(): string {
  if (pool.length === 0) throw new Error("JINA_API_KEYS is empty");
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function markBad(key: string): void {
  const i = pool.indexOf(key);
  if (i >= 0) {
    pool.splice(i, 1);
    console.warn(`[jina] key removed; ${pool.length} remaining`);
  }
}

// ponytail: a future load spike might warrant per-account locks or
// distributed coordination, but a single LangGraph process serializing
// requests is the only case we care about today.

export async function jinaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // No key — fall through to a no-Auth request. Works for r.jina.ai
  // (subject to free-tier rate limits). s.jina.ai will return 401; the
  // caller (search_web) should be lazy-registered so this branch is
  // never hit in that path.
  if (pool.length === 0) {
    return fetch(url, init);
  }

  const initialSize = pool.length;
  for (let attempt = 0; attempt < initialSize; attempt++) {
    if (pool.length === 0) {
      // All keys exhausted mid-flight — finish the request unauth'd.
      return fetch(url, init);
    }
    const key = pickKey();
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${key}` },
    });
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) {
      markBad(key);
      continue;
    }
    return res;
  }
  throw new Error(`All ${initialSize} Jina keys exhausted`);
}

// Test-only: re-seed the pool from a fresh env value.
export function _resetForTests(env: string | undefined): void {
  pool.length = 0;
  pool.push(...parseKeys(env));
}
