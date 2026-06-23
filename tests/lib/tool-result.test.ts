import { describe, it, expect } from "vitest";

import { unwrapToolResult } from "@/components/tool-ui/tool-result";

describe("unwrapToolResult", () => {
  it("returns null for null and undefined", () => {
    expect(unwrapToolResult(null)).toBeNull();
    expect(unwrapToolResult(undefined)).toBeNull();
  });

  it("returns null for non-object primitives", () => {
    expect(unwrapToolResult(42)).toBeNull();
    expect(unwrapToolResult(true)).toBeNull();
  });

  it("passes through plain objects", () => {
    const obj = { success: true, widget: { id: "x" } };
    expect(unwrapToolResult(obj)).toBe(obj);
  });

  it("parses a JSON string into its object", () => {
    const obj = { success: true, widget: { id: "x" } };
    expect(unwrapToolResult(JSON.stringify(obj))).toEqual(obj);
  });

  it("handles double-stringified JSON", () => {
    const obj = { success: true, widget: { id: "x" } };
    const double = JSON.stringify(JSON.stringify(obj));
    expect(unwrapToolResult(double)).toEqual(obj);
  });

  it("returns null for malformed JSON", () => {
    expect(unwrapToolResult("not json")).toBeNull();
  });
});