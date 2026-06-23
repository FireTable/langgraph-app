import { describe, it, expect, vi } from "vitest";

// Mock the chat model singleton. Returns whatever the test queues with
// mockResolvedValueOnce — a fake AIMessage.
const mockInvoke = vi.fn();
vi.mock("@/backend/model", () => ({
  chatModel: { invoke: (...args: unknown[]) => mockInvoke(...args) },
}));

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { callModelNode } from "@/backend/node/call-model-node";

describe("callModelNode", () => {
  it("invokes the chat model with state messages and returns the response", async () => {
    const aiReply = new AIMessage("Sure, here's how you parse JSON.");
    mockInvoke.mockResolvedValueOnce(aiReply);

    const messages = [new HumanMessage("How do I parse JSON?")];
    const result = await callModelNode({ messages });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(messages);
    expect(result).toEqual({ messages: [aiReply] });
  });

  it("passes through empty messages list", async () => {
    const aiReply = new AIMessage("Hello!");
    mockInvoke.mockResolvedValueOnce(aiReply);

    const result = await callModelNode({ messages: [] });

    expect(mockInvoke).toHaveBeenCalledWith([]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toBe(aiReply);
  });
});
