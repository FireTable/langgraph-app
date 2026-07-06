import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRenameThread = vi.fn();
const mockInvoke = vi.fn();
vi.mock("@/lib/threads/queries", () => ({
  renameThread: (...args: unknown[]) => mockRenameThread(...args),
}));
vi.mock("@/backend/model", () => ({
  chatModel: { invoke: (...args: unknown[]) => mockInvoke(...args) },
}));

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";

beforeEach(() => {
  mockRenameThread.mockReset();
  mockInvoke.mockReset();
});

describe("renameThreadAgentNode", () => {
  it("calls renameThread with the trimmed generated title and thread_id, returns null", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("How to parse JSON"));
    mockRenameThread.mockResolvedValueOnce(undefined);

    const result = await renameThreadAgentNode(
      { messages: [new HumanMessage("How do I parse JSON?")] },
      { configurable: { thread_id: "thread-1" } },
    );

    expect(result).toBeNull();
    expect(mockRenameThread).toHaveBeenCalledTimes(1);
    expect(mockRenameThread).toHaveBeenCalledWith("thread-1", "How to parse JSON");
  });

  it("trims whitespace before persisting", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("  Short title  "));
    mockRenameThread.mockResolvedValueOnce(undefined);

    await renameThreadAgentNode(
      { messages: [new HumanMessage("anything")] },
      { configurable: { thread_id: "thread-2" } },
    );

    expect(mockRenameThread).toHaveBeenCalledWith("thread-2", "Short title");
  });

  it("skips the model and renameThread when no human message is provided", async () => {
    const result = await renameThreadAgentNode(
      { messages: [] },
      { configurable: { thread_id: "thread-3" } },
    );

    expect(result).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockRenameThread).not.toHaveBeenCalled();
  });

  it("passes the user message as the second chat-model argument", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("First wins"));
    mockRenameThread.mockResolvedValueOnce(undefined);

    await renameThreadAgentNode(
      { messages: [new HumanMessage("first question")] },
      { configurable: { thread_id: "thread-4" } },
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [callArgs] = mockInvoke.mock.calls[0]!;
    const messages = callArgs as Array<{ content: unknown }>;
    expect(messages[1]?.content).toBe("first question");
  });

  it("skips renameThread when LLM returns an empty title after trim", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("   "));

    await renameThreadAgentNode(
      { messages: [new HumanMessage("anything")] },
      { configurable: { thread_id: "thread-5" } },
    );

    expect(mockRenameThread).not.toHaveBeenCalled();
  });

  it("is a no-op when no thread_id is in config", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("Title"));

    await renameThreadAgentNode({ messages: [new HumanMessage("anything")] }, {});

    expect(mockRenameThread).not.toHaveBeenCalled();
  });
});
