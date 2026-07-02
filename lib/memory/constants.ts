// ponytail: spec NFR-004 — env vars are read once at module load, not
// per-call. A process restart picks up new values; runtime mutation is
// not a supported surface (same shape as lib/observability/config.ts).
// Each helper returns the parsed value or the documented default when
// the env var is missing / empty / non-numeric / out of valid range.

const DEFAULTS = {
  threshold: 10,
  keepRecent: 4,
  profileMaxBytes: 8192,
  threadRecallLimit: 3,
} as const;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

export const MEMORY_THREAD_SUMMARY_THRESHOLD = positiveInt(
  process.env.MEMORY_THREAD_SUMMARY_THRESHOLD,
  DEFAULTS.threshold,
);

export const MEMORY_THREAD_SUMMARY_KEEP_RECENT = nonNegativeInt(
  process.env.MEMORY_THREAD_SUMMARY_KEEP_RECENT,
  DEFAULTS.keepRecent,
);

export const MEMORY_PROFILE_MAX_BYTES = positiveInt(
  process.env.MEMORY_PROFILE_MAX_BYTES,
  DEFAULTS.profileMaxBytes,
);

export const MEMORY_THREAD_RECALL_LIMIT = nonNegativeInt(
  process.env.MEMORY_THREAD_RECALL_LIMIT,
  DEFAULTS.threadRecallLimit,
);
