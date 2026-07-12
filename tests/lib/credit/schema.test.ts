import { describe, it, expect } from "vitest";
import { creditUsageLog, callStatus } from "@/lib/credit/schema";

describe("credit_usage_log schema shape", () => {
  it("exports creditUsageLog table with required columns", () => {
    const cols = creditUsageLog as unknown as Record<string, unknown>;
    expect(cols.id).toBeDefined();
    expect(cols.userId).toBeDefined();
    expect(cols.providerId).toBeDefined();
    expect(cols.modelName).toBeDefined();
    expect(cols.agentName).toBeDefined();
    expect(cols.inputTokens).toBeDefined();
    expect(cols.outputTokens).toBeDefined();
    expect(cols.credits).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("callStatus enum has only success and error", () => {
    const enumValues = (callStatus as unknown as { enumValues: readonly string[] }).enumValues;
    expect([...enumValues].sort()).toEqual(["error", "success"]);
  });
});
