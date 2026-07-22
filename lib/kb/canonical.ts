// ponytail: app-level canonicalization for entity / relationship
// names (audit §15 + Step 5 table). When LLM alignment fails (or
// never runs — retryFailedChunks mode skips it per memory
// `kbagent-three-node-split-once`), we still need a stable,
// idempotent canonical form so the unique index on kb_entity
// (user_id, document_id, name) and kb_relationship (user_id,
// document_id, source, target, relation) don't split one logical
// entity across many rows because of casing / whitespace drift.
//
// Pure function, no LLM, O(N) scan over `allNames`. NFKC + trim +
// lower-unify:
//   1. NFKC normalizes unicode (fullwidth → halfwidth, compatibility
//      decompositions), so "ＬｉｇｈｔＲＡＧ" and "LightRAG" collapse.
//   2. trim() drops surrounding whitespace.
//   3. lower-unify: if two names lower-equal, the FIRST name seen in
//      `allNames` wins (preserves the LLM's preferred surface form
//      when present, falls back to whatever came first).
//
// Returns the canonical surface form for `name`. Empty input is
// returned unchanged (no canonical to look up).

export function appLevelCanonical(name: string, allNames: readonly string[]): string {
  const normalized = name.normalize("NFKC").trim();
  if (normalized.length === 0) return name;

  const target = normalized.toLowerCase();
  for (const candidate of allNames) {
    const c = candidate.normalize("NFKC").trim();
    if (c.length === 0) continue;
    if (c.toLowerCase() === target) return c;
  }
  return normalized;
}
