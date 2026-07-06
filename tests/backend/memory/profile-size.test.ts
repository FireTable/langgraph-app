import { describe, expect, it } from "vitest";

import { assertProfileSize, MemorySizeError } from "@/backend/memory/profile-size";

describe("backend/memory/profile-size", () => {
  it("does not throw when the value is well under the cap", () => {
    expect(() => assertProfileSize({ role: "frontend" }, 8192)).not.toThrow();
  });

  it("does not throw at exactly the cap", () => {
    // 8192 bytes for an empty object is trivially under; build a string
    // whose serialized length equals 8192 and assert no throw.
    const padding = "x".repeat(8192 - JSON.stringify({ a: "" }).length);
    const value = { a: padding };
    expect(JSON.stringify(value).length).toBe(8192);
    expect(() => assertProfileSize(value, 8192)).not.toThrow();
  });

  it("throws MemorySizeError with attemptedBytes + maxBytes when over the cap", () => {
    const padding = "x".repeat(8192);
    try {
      assertProfileSize({ a: padding }, 8192);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MemorySizeError);
      const err = e as MemorySizeError;
      expect(err.attemptedBytes).toBeGreaterThan(8192);
      expect(err.maxBytes).toBe(8192);
      expect(err.name).toBe("MemorySizeError");
    }
  });
});
