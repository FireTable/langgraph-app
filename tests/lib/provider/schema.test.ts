import { describe, it, expect } from "vitest";
import { provider } from "@/lib/provider/schema";

describe("provider schema shape", () => {
  it("exports provider table with required columns", () => {
    const cols = provider as unknown as Record<string, unknown>;
    expect(cols.id).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.enabled).toBeDefined();
    expect(cols.apiKeys).toBeDefined();
    expect(cols.models).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("provider.id is the primary key", () => {
    const id = (provider as unknown as { id: { primary: boolean } }).id;
    expect(id.primary).toBe(true);
  });
});
