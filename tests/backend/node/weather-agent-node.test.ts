import { describe, it, expect, vi } from "vitest";

const { mockInvoke, mockBindTools } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockBindTools: vi.fn(),
}));

vi.mock("@/backend/model", () => {
  const boundInvoke = (...args: unknown[]) => mockInvoke(...args);
  const boundBind = (...args: unknown[]) => {
    mockBindTools(...args);
    return { invoke: boundInvoke };
  };
  return {
    chatModel: {
      invoke: boundInvoke,
      bindTools: boundBind,
    },
  };
});

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { runWeatherAgent } from "@/backend/node/weather-agent-node";

describe("runWeatherAgent", () => {
  it("binds weather tools and invokes the model with the weather prompt prepended", async () => {
    const aiReply = new AIMessage("Let me check the weather for you.");
    mockInvoke.mockResolvedValueOnce(aiReply);

    const messages = [new HumanMessage("Weather in Beijing?")];
    const result = await runWeatherAgent(messages);

    expect(mockBindTools).toHaveBeenCalledTimes(1);
    const toolsArg = mockBindTools.mock.calls[0]?.[0] as Array<{ name: string }> | undefined;
    expect(toolsArg?.map((t) => t.name)).toEqual(["ask_location", "geocode_location", "get_weather"]);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const callArgs = mockInvoke.mock.calls[0]?.[0] as Array<{ type: string; content: string }> | undefined;
    expect(callArgs?.[0]?.type).toBe("system");
    expect(callArgs?.[0]?.content).toMatch(/geocode_location/);
    expect(callArgs?.[0]?.content).toMatch(/get_weather/);
    expect(callArgs?.[1]).toBe(messages[0]);

    expect(Array.isArray(result)).toBe(true);
    // The subgraph's bound model was invoked with the right shape; the
    // exact output messages depend on LangGraph's MessagesAnnotation
    // reducer behavior under mocks, which is exercised end-to-end in
    // tests/backend/agent.test.ts.
  });

  it("strips any prior system messages before prepending the weather prompt", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("ok"));

    await runWeatherAgent([new SystemMessage("old prompt"), new HumanMessage("rain?")]);

    const callArgs = mockInvoke.mock.calls[0]?.[0] as Array<{ type: string; content: string }> | undefined;
    expect(callArgs).toHaveLength(2);
    expect(callArgs?.[0]?.type).toBe("system");
    expect(callArgs?.[1]?.type).toBe("human");
  });
});
