import { describe, it, expect } from "vitest";

import { parseAmount, formatAmount, formatQty, safeDivide } from "@/lib/decimal";

describe("parseAmount", () => {
  it("parses a clean integer", () => {
    const d = parseAmount("100");
    expect(d?.toNumber()).toBe(100);
  });

  it("parses a decimal without losing precision", () => {
    // parseFloat("0.1") + parseFloat("0.2") !== 0.3 — Decimal handles it.
    expect(parseAmount("0.1")?.plus("0.2")?.toFixed(1)).toBe("0.3");
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmount("  100  ")?.toNumber()).toBe(100);
  });

  it("rejects empty input", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });

  it("rejects zero and negative numbers", () => {
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-100")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
    expect(parseAmount("1,000")).toBeNull(); // comma is not a decimal separator here
  });

  it("rejects scientific notation (1e2 style) to avoid fat-finger trades", () => {
    expect(parseAmount("1e2")).toBeNull();
    expect(parseAmount("1E5")).toBeNull();
  });

  it("rejects non-finite inputs", () => {
    expect(parseAmount("Infinity")).toBeNull();
    expect(parseAmount("NaN")).toBeNull();
  });

  it("rejects amounts above the safety cap", () => {
    expect(parseAmount("1e16")).toBeNull();
  });
});

describe("formatAmount", () => {
  it("rounds to N decimal places", () => {
    expect(formatAmount("1.005", 2)).toBe("1.01");
    expect(formatAmount("1.004", 2)).toBe("1.00");
  });

  it("accepts Decimal | number | string", () => {
    expect(formatAmount(100)).toBe("100.00");
    expect(formatAmount("100.5")).toBe("100.50");
  });
});

describe("formatQty", () => {
  it("uses 4dp for qty >= 1", () => {
    expect(formatQty("1.23456789")).toBe("1.2346");
  });

  it("uses 6dp for qty < 1 (satoshi-level)", () => {
    expect(formatQty("0.000123456")).toBe("0.000123");
  });
});

describe("safeDivide", () => {
  it("divides without precision loss", () => {
    const result = safeDivide("100", "3");
    expect(result?.toFixed(10)).toBe("33.3333333333");
  });

  it("returns null when dividing by zero", () => {
    expect(safeDivide("100", "0")).toBeNull();
  });

  it("returns null when denominator is negative", () => {
    expect(safeDivide("100", "-5")).toBeNull();
  });
});
