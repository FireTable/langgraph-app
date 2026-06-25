import { describe, it, expect, vi } from "vitest";

const { mockInvokeStructured, mockInvoke } = vi.hoisted(() => ({
  mockInvokeStructured: vi.fn(),
  mockInvoke: vi.fn(),
}));

// The router binds `chatModel.withStructuredOutput(...)` at module load
// time. We mock `withStructuredOutput` to return a stub whose `.invoke`
// is mockInvokeStructured, so the router's call lands in our control.
vi.mock("@/backend/model", () => ({
  chatModel: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    withStructuredOutput: () => ({ invoke: (...args: unknown[]) => mockInvokeStructured(...args) }),
  },
}));

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { routerAgentNode } from "@/backend/node/router-agent-node";

describe("routerAgentNode", () => {
  it("returns the structured-output object as routerDecision", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    const result = await routerAgentNode({
      messages: [new HumanMessage("how do I parse JSON?")],
    });

    expect(result).toEqual({ routerDecision: { next: "chatAgent" } });
  });

  it("routes weather queries to weatherAgent", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "weatherAgent" });

    const result = await routerAgentNode({
      messages: [new HumanMessage("北京天气怎么样?")],
    });

    expect(result).toEqual({ routerDecision: { next: "weatherAgent" } });
  });

  it("prepends the router system prompt and strips any prior system messages", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    await routerAgentNode({
      messages: [new SystemMessage("stale"), new HumanMessage("rain?")],
    });

    const callArgs = mockInvokeStructured.mock.calls[0]?.[0] as Array<{
      type: string;
      content: string;
    }>;
    expect(callArgs?.map((m) => m.type)).toEqual(["system", "human"]);
    expect(callArgs?.[0]?.content).toMatch(/router/i);
  });
});
