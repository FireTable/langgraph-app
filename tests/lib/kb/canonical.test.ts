import { describe, expect, it } from "vitest";

import { appLevelCanonical } from "@/lib/kb/canonical";

// ponytail: app-level canonicalization (audit §15 + Step 5 table).
// NFKC + trim + lower-unify against the doc's existing entity names.
// Pure function, O(N).

describe("lib/kb/canonical — appLevelCanonical", () => {
  it("returns the first NFKC-matched name when one already exists", () => {
    // ponytail: audit §15 says "lower 相同 → 取 allNames 里第一个".
    // lower() doesn't strip whitespace, so "Light Rag" lower ≠
    // "lightrag" lower — they don't unify under the rule. The
    // expected outcome is "no match → returns normalized self".
    expect(appLevelCanonical("LightRAG", ["lightrag", "OpenAI"])).toBe("lightrag");
    expect(appLevelCanonical("LIGHTRAG", ["lightrag", "OpenAI"])).toBe("lightrag");
    // "Light Rag" lower ≠ "lightrag" lower → no match, returns NFKC.
    expect(appLevelCanonical("Light Rag", ["lightrag", "Light Rag"])).toBe("Light Rag");
  });

  it("NFKC unifies fullwidth → halfwidth", () => {
    // Fullwidth L I G H T R A G vs ASCII LightRAG — should collapse.
    expect(appLevelCanonical("ＬｉｇｈｔＲＡＧ", ["LightRAG"])).toBe("LightRAG");
  });

  it("trims surrounding whitespace before comparison", () => {
    expect(appLevelCanonical("  Acme  ", ["Acme"])).toBe("Acme");
  });

  it("returns NFKC+trim of self when no match in allNames", () => {
    expect(appLevelCanonical("Brand New Entity", [])).toBe("Brand New Entity");
    expect(appLevelCanonical("  Brand New Entity  ", [])).toBe("Brand New Entity");
  });

  it("empty string passes through unchanged", () => {
    expect(appLevelCanonical("", ["anything"])).toBe("");
    expect(appLevelCanonical("", [])).toBe("");
  });

  it("preserves the surface form from allNames (first match wins)", () => {
    // allNames surfaces the casing the LLM used; the new name folds to it.
    const allNames = ["OpenAI", "Microsoft"];
    expect(appLevelCanonical("openai", allNames)).toBe("OpenAI");
    expect(appLevelCanonical("OPENAI", allNames)).toBe("OpenAI");
  });

  it("handles CJK without case-folding (no lowercase in CJK scripts)", () => {
    // CJK characters are case-less; lower() is a no-op so the
    // comparison is byte-equal NFKC + trim. Whitespace is NOT folded
    // (audit §15 lower-unify only — collapsing "光 年" → "光年"
    // would risk false positives on multi-word names).
    expect(appLevelCanonical("光年", ["光年"])).toBe("光年");
    expect(appLevelCanonical("  光年  ", ["光年"])).toBe("光年");
    // Different characters → no match, returns normalized self.
    expect(appLevelCanonical("光子", ["光年"])).toBe("光子");
  });

  it("is idempotent on its own output", () => {
    const allNames = ["LightRAG", "Acme"];
    const once = appLevelCanonical("lightrag", allNames);
    const twice = appLevelCanonical(once, allNames);
    expect(twice).toBe(once);
  });
});
