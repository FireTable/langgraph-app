import { describe, it, expect } from "vitest";

import { generateId } from "@/lib/ids/nanoid";

describe("generateId", () => {
  it("returns a 12-char string from the 0-9a-z alphabet", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-z]{12}$/);
  });

  it("returns unique ids across many invocations", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    // Birthday collision: 1000 ids × ~62 bits → expected collisions ≈ 0.
    expect(ids.size).toBe(1000);
  });

  it("never produces the same id twice in a tight loop (no reseeded RNG)", () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});
