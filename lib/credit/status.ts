// ponytail: shared client-side reader for /api/credit/status. Used by
// the UserButton dropdown slot AND the settings-page summary card —
// both surfaces need the same numbers and must hit the network at most
// once. Module-scope cache + in-flight promise collapse the duplicate
// fetches; the 1s TTL guarantees the number refreshes whenever the
// user pauses long enough to want a fresh reading (the realistic
// "I want to see fresh data" cadence for credit monitoring).

export type CreditStatus = {
  used: number;
  limit: number | null;
  windowHours: number | null;
  resetAt: string;
  unlimited: boolean;
  roleName: string;
};

const CACHE_TTL_MS = 1_000;

let cache: { status: CreditStatus; expiresAt: number } | null = null;
let inflight: Promise<CreditStatus> | null = null;

export function peekCachedStatus(): CreditStatus | null {
  return cache && cache.expiresAt > Date.now() ? cache.status : null;
}

export async function loadCreditStatus(): Promise<CreditStatus> {
  if (cache && cache.expiresAt > Date.now()) return cache.status;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/credit/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as CreditStatus;
      cache = { status: data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
