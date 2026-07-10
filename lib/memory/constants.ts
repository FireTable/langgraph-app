// ponytail: spec NFR-004 — env vars are read once at module load, not
// per-call. A process restart picks up new values; runtime mutation is
// not a supported surface (same shape as lib/observability/config.ts).
// Each helper returns the parsed value or the documented default when
// the env var is missing / empty / non-numeric / out of valid range.

const DEFAULTS = {
  // ponytail: KEEP_RECENT is the single knob for thread summarization.
  // It controls THREE things at once:
  //   - BATCH SIZE  — every compress pass covers KEEP_RECENT consecutive
  //                   human turns (e.g. turn 1..10, then turn 11..20).
  //   - TRIGGER CADENCE — trigger fires every KEEP_RECENT new turns;
  //                       humanCount at trigger = 4k+1 (k≥1).
  //   - RECENT FLOOR — the most recent KEEP_RECENT turns are never
  //                    compressed, so the model always sees fresh
  //                    context.
  // Larger KEEP_RECENT → fewer LLM calls but more context per call.
  // Smaller → more calls but bounded per-call work. Defaults to 10
  // (matches the worked example in our docs).
  keepRecent: 10,
  profileMaxBytes: 8192,
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

// ponytail: single env var for the thread summarize trigger window.
// The router + node both gate on this constant; values < 1 collapse to
// a no-op (defensive — nonNegativeInt clamps negatives to 0).
export const MEMORY_THREAD_SUMMARY_KEEP_RECENT = nonNegativeInt(
  process.env.MEMORY_THREAD_SUMMARY_KEEP_RECENT,
  DEFAULTS.keepRecent,
);

export const MEMORY_PROFILE_MAX_BYTES = positiveInt(
  process.env.MEMORY_PROFILE_MAX_BYTES,
  DEFAULTS.profileMaxBytes,
);

// ponytail: keys that may be filled from the auth record (OAuth /
// Better Auth) when the user-saved doc doesn't have them. Listed
// once so mergeMemory iterates them — the UI's "(from account)"
// hint and the LLM's system-prompt overlay use the same set.
export const AUTH_OVERLAY_KEYS = ["name", "email", "avatar", "socials"] as const;
export type AuthOverlayKey = (typeof AUTH_OVERLAY_KEYS)[number];
