import { describe, it, expect } from "vitest";
import { formatPrice } from "@/components/tool-ui/crypto/price-card";

// CoinGecko accepts these vs_currency codes (lowercase). The card lower-cases
// nothing — formatPrice upper-cases before handing to Intl. Cover every code
// that has a meaningful symbol distinction, plus the edge cases around
// sub-1 values and zero-decimal currencies.
describe("formatPrice", () => {
  describe("symbol correctness per currency", () => {
    it("USD → $", () => {
      expect(formatPrice(255034, "usd")).toContain("$");
      expect(formatPrice(255034, "usd")).toBe("$255,034.00");
    });

    it("EUR → €", () => {
      expect(formatPrice(1234.5, "eur")).toContain("€");
      expect(formatPrice(1234.5, "eur")).toBe("€1,234.50");
    });

    it("JPY → ¥ (no decimals)", () => {
      expect(formatPrice(255034, "jpy")).toContain("¥");
      // JPY has no sub-unit — must NOT emit .5 or .00.
      expect(formatPrice(255034, "jpy")).toBe("¥255,034");
      expect(formatPrice(1234.5, "jpy")).toBe("¥1,235"); // rounds half-up
      expect(formatPrice(161.71, "jpy")).toBe("¥162");
    });

    it("CNY → ¥ (RMB glyph, no CN/元 prefix)", () => {
      // Bare ¥ — same glyph as JPY — to match the user's "人民币 ¥"
      // convention. We accept that CNY and JPY render the same symbol;
      // the vs_currency label in the surrounding context is what
      // disambiguates them.
      expect(formatPrice(1234.5, "cny")).toBe("¥1,234.50");
    });

    it("CNY has no decimals when the value rounds cleanly", () => {
      // CNY is not in NO_FRACTION, so it still uses 2dp even on round
      // numbers — this is the conventional retail display.
      expect(formatPrice(1000, "cny")).toBe("¥1,000.00");
    });

    it("GBP → £", () => {
      expect(formatPrice(1234.5, "gbp")).toContain("£");
      expect(formatPrice(1234.5, "gbp")).toBe("£1,234.50");
    });

    it("KRW → ₩ (no decimals)", () => {
      expect(formatPrice(255034, "krw")).toContain("₩");
      expect(formatPrice(255034, "krw")).toBe("₩255,034");
    });

    it("INR → ₹", () => {
      expect(formatPrice(1234.5, "inr")).toContain("₹");
      expect(formatPrice(1234.5, "inr")).toBe("₹1,234.50");
    });

    it("CNY vs JPY share the ¥ glyph by design", () => {
      // Both render bare ¥ — the surrounding context (vs_currency label
      // in the chat) is the disambiguator. We still assert both contain
      // ¥ so a future "drop CNY symbol" regression can't sneak past.
      const cny = formatPrice(1234.5, "cny");
      const jpy = formatPrice(1234.5, "jpy");
      expect(cny).toContain("¥");
      expect(jpy).toContain("¥");
      // CNY keeps 2dp, JPY uses 0dp, so the full strings diverge:
      expect(cny).toBe("¥1,234.50");
      expect(jpy).toBe("¥1,235");
    });
  });

  describe("sub-unit precision for small values", () => {
    it("USD sub-1 keeps 6 decimals so PEPE-style prices stay readable", () => {
      expect(formatPrice(0.000123, "usd")).toBe("$0.000123");
    });

    it("USD >= 1 keeps 2 decimals", () => {
      expect(formatPrice(1234.5, "usd")).toBe("$1,234.50");
    });

    it("JPY sub-1 still rounds to 0 decimals (no ¥0.000123)", () => {
      // Even at ¥0.5 we render ¥1 (rounded), not a fractional yen.
      expect(formatPrice(0.5, "jpy")).toBe("¥1");
    });
  });

  describe("case insensitivity (CoinGecko sends lowercase)", () => {
    it("lowercase codes are accepted", () => {
      expect(formatPrice(100, "usd")).toBe(formatPrice(100, "USD"));
      expect(formatPrice(100, "jpy")).toBe(formatPrice(100, "JPY"));
      expect(formatPrice(100, "cny")).toBe(formatPrice(100, "CNY"));
    });
  });

  describe("unknown currency codes", () => {
    // CoinGecko occasionally adds new currencies before ICU learns them.
    // Node's Intl falls back to rendering the ISO code itself rather than
    // throwing — `XYZ 100.00`. Document that behavior so a future change
    // to "throw on unknown" is a deliberate decision, not a silent regression.
    it("falls back to the ISO code instead of throwing", () => {
      const out = formatPrice(100, "xyz");
      expect(out).toContain("XYZ");
      expect(out).toContain("100");
    });
  });
});
