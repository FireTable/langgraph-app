// ponytail: spec NFR-004 — env vars are read once at module load, not
// per-call. A process restart picks up new values; runtime mutation is
// not a supported surface (same shape as lib/observability/config.ts).
// Each helper returns the parsed value or the documented default when
// the env var is missing / empty / non-numeric / out of valid range.

const DEFAULTS = {
  // ponytail: BATCH_SIZE = how many human turns ONE LLM summarize call
  // covers. KEEP_RECENT = how many recent human turns we leave alone
  // (never summarized). THRESHOLD is kept as a safety floor — if
  // userMessageCount falls below it, the gateway skips the summarize
  // call entirely (avoids edge-case work for tiny threads).
  threshold: 10,
  keepRecent: 4,
  batchSize: 6,
  profileMaxBytes: 8192,
  // ponytail: RECALL_LIMIT caps the cross-thread list shown in the
  // Memory tab UI — it no longer feeds the model prompt (that path
  // was retired: single-thread summaries live inline in the
  // messages channel; cross-thread history was leaky and is gone).
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

// ponytail: BATCH_SIZE is the ONLY knob the user controls here.
// Larger → fewer LLM calls but more context per call (and the per-
// call Q&A summary may need truncation). Smaller → more LLM calls
// but bounded per-call work. The router compares userMessageCount to
// KEEP_RECENT + BATCH_SIZE before entering the summarize node, so
// values < 1 collapse to a no-op.
export const MEMORY_THREAD_SUMMARY_BATCH_SIZE = positiveInt(
  process.env.MEMORY_THREAD_SUMMARY_BATCH_SIZE,
  DEFAULTS.batchSize,
);

export const MEMORY_PROFILE_MAX_BYTES = positiveInt(
  process.env.MEMORY_PROFILE_MAX_BYTES,
  DEFAULTS.profileMaxBytes,
);

export const MEMORY_THREAD_RECALL_LIMIT = nonNegativeInt(
  process.env.MEMORY_THREAD_RECALL_LIMIT,
  DEFAULTS.threadRecallLimit,
);

// ponytail: keys that may be filled from the auth record (OAuth /
// Better Auth) when the user-saved doc doesn't have them. Listed
// once so mergeMemory iterates them — the UI's "(from account)"
// hint and the LLM's system-prompt overlay use the same set.
export const AUTH_OVERLAY_KEYS = ["name", "email", "image", "socials"] as const;
export type AuthOverlayKey = (typeof AUTH_OVERLAY_KEYS)[number];
