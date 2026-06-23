// ponytail: in-memory Jina API key pool. The LangGraph dev server is a
// long-running process, so we can keep keys in a module-level array and
// mutate it on 401/403 without persisting anywhere. Failover loops up to
// the original pool size — once every key has rejected us, the request
// gives up.

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
  const initialSize = pool.length;
  if (initialSize === 0) throw new Error("JINA_API_KEYS is empty");

  for (let attempt = 0; attempt < initialSize; attempt++) {
    if (pool.length === 0) break;
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
