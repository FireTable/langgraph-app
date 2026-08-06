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
  getChatModel: async () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
    withStructuredOutput: (...args: unknown[]) => {
      mockWithStructuredArgs(...args);
      return { invoke: (...args: unknown[]) => mockInvokeStructured(...args) };
    },
  }),
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
  it("returns the LLM structured-output object with source: llm on fallback", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    const result = await routerAgentNode({
      messages: [new HumanMessage("tell me a joke")],
    });

    expect(result).toEqual({
      routerDecision: { next: "chatAgent", source: "llm" },
    });
  });

  it("routes weather queries via keyword short-circuit (source: keyword)", async () => {
    const result = await routerAgentNode({
      messages: [new HumanMessage("北京天气怎么样?")],
    });

    expect(result).toEqual({
      routerDecision: {
        next: "weatherAgent",
        source: "keyword",
        matchedKey: "天气",
      },
    });
    // Keyword match should NOT invoke the LLM
    expect(mockInvokeStructured).not.toHaveBeenCalled();
  });

  it("routes crypto queries via keyword short-circuit (source: keyword)", async () => {
    const result = await routerAgentNode({
      messages: [new HumanMessage("BTC price now")],
    });

    expect(result).toEqual({
      routerDecision: {
        next: "cryptoAgent",
        source: "keyword",
        matchedKey: "/\\b(btc|eth|usdt|usdc|doge|shib)\\b/i",
      },
    });
    expect(mockInvokeStructured).not.toHaveBeenCalled();
  });

  it("routes code queries via keyword short-circuit (source: keyword)", async () => {
    const result = await routerAgentNode({
      messages: [new HumanMessage("请帮我写一段 TypeScript 代码")],
    });

    expect(result).toEqual({
      routerDecision: {
        next: "codeAgent",
        source: "keyword",
        matchedKey: "/(写|编写|生成|重构|优化|运行|调试|修复)[\\s\\S]{0,15}(代码|脚本|程序|函数|接口|正则)/i",
      },
    });
    expect(mockInvokeStructured).not.toHaveBeenCalled();
  });

  it("prepends the router system prompt when falling back to LLM", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    await routerAgentNode({
      messages: [new SystemMessage("stale"), new HumanMessage("tell me a story")],
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
      messages: [new HumanMessage("tell me a story")],
    });

    const schemaArg = mockWithStructuredArgs.mock.calls.at(-1)?.[0] as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const optionsArg = mockWithStructuredArgs.mock.calls.at(-1)?.[1] as {
      name: string;
      method: string;
      strict?: boolean;
    };
    expect(schemaArg?.safeParse({ next: "weatherAgent" }).success).toBe(true);
    expect(schemaArg?.safeParse({ next: "cryptoAgent" }).success).toBe(true);
    expect(schemaArg?.safeParse({ next: "bogus" }).success).toBe(false);
    expect(optionsArg).toEqual({
      name: "route_decision",
      method: "jsonSchema",
      strict: true,
    });
  });

  it("passes only the last user message to LLM when falling back without keyword match", async () => {
    mockInvokeStructured.mockResolvedValueOnce({ next: "chatAgent" });

    await routerAgentNode({
      messages: [
        new SystemMessage("stale system"),
        new HumanMessage("earlier question"),
        new SystemMessage("another stale system"),
        new HumanMessage("tell me a philosophy concept"),
        new SystemMessage("trailing stale"),
      ],
    });

    const callArgs = mockInvokeStructured.mock.calls[0]?.[0] as Array<{
      type: string;
      content: string;
    }>;
    expect(callArgs).toHaveLength(2);
    expect(callArgs?.map((m) => m.type)).toEqual(["system", "human"]);
    expect(callArgs?.[1]?.content).toBe("tell me a philosophy concept");
  });
});

