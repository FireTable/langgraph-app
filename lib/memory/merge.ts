// ponytail: pure, platform-agnostic merge of user-saved memory with
// auth overlay. Imported by both backend (recall.ts → system prompt)
// and frontend (memory-view.tsx → UI render) so the merge semantics
// are defined once. No DB calls, no env reads, no React — safe to
// import from anywhere.

import { AUTH_OVERLAY_KEYS, type AuthOverlayKey } from "@/lib/memory/constants";

export type AuthInfo = Record<AuthOverlayKey, unknown>;

export type MemoryDoc = Record<string, unknown>;

// ponytail: a value is "missing" if it's null, undefined, or an empty
// array. Empty string `""` is preserved (a real choice), but `null`
// and `[]` mean "no signal from auth" — fall through to whatever the
// store has. Verified live: a user with no social accounts shouldn't
// have their saved `socials` field wiped by an empty auth overlay.
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// ponytail: store wins. Iterate the auth-overlay key list (single
// source of truth in constants.ts) and fill gaps in the user-saved
// doc. Adding a new overlayable field = one entry in AUTH_OVERLAY_KEYS,
// not another if-statement here.
export function mergeMemory(doc: MemoryDoc, auth: AuthInfo): MemoryDoc {
  const out: MemoryDoc = { ...doc };
  for (const key of AUTH_OVERLAY_KEYS) {
    if (out[key] === undefined && !isEmptyValue(auth[key])) {
      out[key] = auth[key];
    }
  }
  return out;
}

// ponytail: returns the set of keys present in the store doc. Used by
// the frontend to classify merged fields as "summarized by AI" vs "from
// account" — anything in this set is store-owned because save_memory
// filters unchanged auth values out of the write-back.
export function getStoreKeys(doc: MemoryDoc): Set<string> {
  return new Set(Object.keys(doc));
}
