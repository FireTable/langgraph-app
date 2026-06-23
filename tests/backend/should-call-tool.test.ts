import { describe, it, expect } from "vitest";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { shouldCallTool } from "@/backend/agent";

describe("shouldCallTool", () => {
  it("returns 'afterAgent' when last message has no tool calls", () => {
    const state = { messages: [new HumanMessage("hi"), new AIMessage("hello")] };
    expect(shouldCallTool(state)).toBe("afterAgent");
  });

  it("returns 'tools' when last message has tool_calls", () => {
    const aiWithTool = new AIMessage({
      content: "",
      tool_calls: [{ id: "t1", name: "searchWeb", args: { query: "x" } }],
    });
    const state = { messages: [new HumanMessage("hi"), aiWithTool] };
    expect(shouldCallTool(state)).toBe("tools");
  });

  it("returns 'afterAgent' on empty messages", () => {
    expect(shouldCallTool({ messages: [] })).toBe("afterAgent");
  });
});