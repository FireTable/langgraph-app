import { describe, it, expect } from "vitest";
import { computeCredits } from "@/lib/credit/charge";

describe("computeCredits", () => {
  it("computes from input + output tokens at the given rates", () => {
    expect(computeCredits({ input: 1000, output: 0 }, { inputPer1k: 1, outputPer1k: 3 })).toBe(1);
    expect(computeCredits({ input: 0, output: 1000 }, { inputPer1k: 1, outputPer1k: 3 })).toBe(3);
    expect(computeCredits({ input: 1000, output: 1000 }, { inputPer1k: 1, outputPer1k: 3 })).toBe(
      4,
    );
  });

  it("handles fractional tokens", () => {
    expect(computeCredits({ input: 500, output: 250 }, { inputPer1k: 2, outputPer1k: 4 })).toBe(2);
  });

  it("zero usage yields zero credits", () => {
    expect(computeCredits({ input: 0, output: 0 }, { inputPer1k: 10, outputPer1k: 30 })).toBe(0);
  });
});
