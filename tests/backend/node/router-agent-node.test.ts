import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvokeStructured, mockInvoke, mockWithStructuredArgs } = vi.hoisted(() => ({
  mockInvokeStructured: vi.fn(),
  mockInvoke: vi.fn(),
  mockWithStructuredArgs: vi.fn(),
}));

// The router binds `chatModel.withStructuredOutput(...)` at module load
// time. We mock `withStructuredOutput` to return a stub whose `.invoke`
// is mockInvokeStructured, so the router's call lands in our control.
vi.mock("@/backend/model", () => ({
  chatModel: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    withStructuredOutput: (...args: unknown[]) => {
      mockWithStructuredArgs(...args);
      return { invoke: (...args: unknown[]) => mockInvokeStructured(...args) };
    },
  },
}));

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { routerAgentNode } from "@/backend/node/router-agent-node";

beforeEach(() => {
  // ponytail: vi.hoisted() mocks persist across tests — clear before
  // each so call order / counts don't bleed between cases.
  mockInvokeStructured.mockReset();
  mockInvoke.mockReset();
  mockWithStructuredArgs.mockReset();
});

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

  it("routes crypto queries to cryptoAgent", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "cryptoAgent" });

    const result = await routerAgentNode({
      messages: [new HumanMessage("我想买 100 美元的 BTC")],
    });

    expect(result).toEqual({ routerDecision: { next: "cryptoAgent" } });
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

  it("registers the route_decision schema with jsonSchema method", async () => {
    mockWithStructuredArgs.mockClear();
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    await routerAgentNode({
      messages: [new HumanMessage("anything")],
    });

    // withStructuredOutput is called once at module load + once per
    // routerAgentNode invocation. The router invocation must pass the
    // route_decision schema and the jsonSchema method — a regression
    // to functionCalling breaks compatibility with strict json-mode
    // providers.
    const schemaArg = mockWithStructuredArgs.mock.calls.at(-1)?.[0] as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const optionsArg = mockWithStructuredArgs.mock.calls.at(-1)?.[1] as {
      name: string;
      method: string;
    };
    expect(schemaArg?.safeParse({ next: "weatherAgent" }).success).toBe(true);
    expect(schemaArg?.safeParse({ next: "cryptoAgent" }).success).toBe(true);
    expect(schemaArg?.safeParse({ next: "bogus" }).success).toBe(false);
    expect(optionsArg).toEqual({ name: "route_decision", method: "jsonSchema" });
  });

  // ponytail: router is a yes/no classifier on the CURRENT turn. Full
  // history is a token-cost move AND can distract the classifier into
  // routing off a stale topic. Only the trailing HumanMessage goes in.
  it("passes only the last user message to the model when history is long", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "weatherAgent" });

    await routerAgentNode({
      messages: [
        new SystemMessage("stale system"),
        new HumanMessage("earlier question"),
        new SystemMessage("another stale system"),
        new HumanMessage("今天北京天气怎么样?"),
        new SystemMessage("trailing stale"),
      ],
    });

    const callArgs = mockInvokeStructured.mock.calls[0]?.[0] as Array<{
      type: string;
      content: string;
    }>;
    expect(callArgs).toHaveLength(2);
    expect(callArgs?.map((m) => m.type)).toEqual(["system", "human"]);
    expect(callArgs?.[1]?.content).toBe("今天北京天气怎么样?");
  });

  it("routes based on the most recent user message, not earlier turns", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "cryptoAgent" });

    await routerAgentNode({
      messages: [
        new HumanMessage("weather in Tokyo"), // earlier turn — ignored
        new HumanMessage("BTC price now"), // current turn — drives decision
      ],
    });

    const callArgs = mockInvokeStructured.mock.calls[0]?.[0] as Array<{
      type: string;
      content: string;
    }>;
    expect(callArgs?.map((m) => m.content)).toEqual([
      expect.stringMatching(/router/i),
      "BTC price now",
    ]);
  });

  it("still invokes the model when the last message is human (no fallback when present)", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    await routerAgentNode({
      messages: [new SystemMessage("stray"), new HumanMessage("hi")],
    });

    expect(mockInvokeStructured).toHaveBeenCalledTimes(1);
    const callArgs = mockInvokeStructured.mock.calls[0]?.[0] as Array<{
      type: string;
    }>;
    // [system, human] — no extra system messages, no extra humans.
    expect(callArgs).toHaveLength(2);
    expect(callArgs?.map((m) => m.type)).toEqual(["system", "human"]);
  });
});
